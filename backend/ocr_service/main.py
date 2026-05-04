"""
ocr_service/main.py
────────────────────
Python FastAPI microservice powering the medicine OCR pipeline.

Strategy
────────
1. PRIMARY  – Gemini Vision (gemini-2.0-flash / gemini-1.5-flash)
   The model reads the image natively and returns a structured JSON with:
   • detectedText      : exact text it sees on the label
   • medicineName      : identified brand/generic name
   • genericName       : generic / active ingredient
   • manufacturer      : company name
   • dosage            : strength (e.g. 650 mg)
   • uses              : what the medicine is used for
   • sideEffects       : common side effects
   • howToUse          : administration instructions
   • storage           : storage instructions
   • warnings          : important cautions
   • confidence        : 0-100 self-reported confidence

2. FALLBACK – EasyOCR (raw text only, returned when Gemini is unavailable)

Endpoint
────────
POST /ocr-analyze
  Body : multipart/form-data  →  file: image/*
  OR    application/json      →  { "imageBase64": "<base64 string>" }

Returns
───────
{
  "success": true,
  "source": "gemini" | "easyocr" | "failed",
  "confidence": 0-100,
  "detectedText": "...",
  "medicine": {
    "name": "...",
    "genericName": "...",
    "manufacturer": "...",
    "dosage": "...",
    "uses": ["..."],
    "sideEffects": ["..."],
    "howToUse": "...",
    "storage": "...",
    "warnings": ["..."]
  },
  "elapsedMs": 0
}
"""

import os
import re
import json
import ssl
import time
import base64
import asyncio
import logging
from io import BytesIO
from typing import Optional

import httpx
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image, ImageEnhance, ImageFilter

# ── env ──────────────────────────────────────────────────────────────────────
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../.env"))
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env"), override=True)

GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
PORT: int = int(os.getenv("OCR_SERVICE_PORT", "5050"))
# Models tried in order; tuple of (model_id, api_version)
# gemini-2.0-flash is the primary vision model on free tier
# gemini-1.5-* must use v1 API (not v1beta)
GEMINI_VISION_MODELS = [
    ("gemini-2.0-flash",         "v1beta"),
    ("gemini-2.0-flash-lite",    "v1beta"),
    ("gemini-1.5-flash-latest",  "v1"),
    ("gemini-1.5-flash",         "v1"),
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ocr_service")

# macOS Python 3.x ships without system CA certs – patch globally so that
# EasyOCR model downloads and httpx connections work without verification errors.
# This is safe in a local-only microservice context.
ssl._create_default_https_context = ssl._create_unverified_context

# ── FastAPI ───────────────────────────────────────────────────────────────────
app = FastAPI(title="MedVision OCR Service", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    """Pre-warm EasyOCR in background so it's ready when first request arrives."""
    import asyncio
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, get_easyocr)

# ── Pydantic models ───────────────────────────────────────────────────────────
class Base64Request(BaseModel):
    imageBase64: str
    hint: Optional[str] = None  # optional user hint ("this is a tablet strip")


class MedicineInfo(BaseModel):
    name: str = ""
    genericName: str = ""
    manufacturer: str = ""
    dosage: str = ""
    uses: list[str] = []
    sideEffects: list[str] = []
    howToUse: str = ""
    storage: str = ""
    warnings: list[str] = []


class OcrResponse(BaseModel):
    success: bool
    source: str
    confidence: float
    detectedText: str
    medicine: MedicineInfo
    elapsedMs: int


# ── image helpers ─────────────────────────────────────────────────────────────
def preprocess_pil(img: Image.Image) -> Image.Image:
    """Light enhancement before sending to Gemini – sharpen + contrast boost."""
    img = img.convert("RGB")
    # Resize: keep aspect, max 2048 wide (Gemini handles large images fine)
    max_w = 2048
    if img.width > max_w:
        ratio = max_w / img.width
        img = img.resize((max_w, int(img.height * ratio)), Image.LANCZOS)
    img = ImageEnhance.Sharpness(img).enhance(1.8)
    img = ImageEnhance.Contrast(img).enhance(1.3)
    return img


def pil_to_base64(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return base64.b64encode(buf.getvalue()).decode()


def bytes_to_pil(data: bytes) -> Image.Image:
    return Image.open(BytesIO(data))


# ── Gemini Vision ─────────────────────────────────────────────────────────────
GEMINI_PROMPT = """You are an expert pharmacist and medical label reader.
Analyze this medicine / pharmaceutical product image carefully and return ONLY a valid JSON object.

Extract ALL text you can see and identify the medicine details.

Return exactly this JSON structure (no markdown, no explanation, just the JSON):
{
  "detectedText": "<all text visible on the label, verbatim>",
  "medicineName": "<brand name, e.g. Dolo 650, Azithromycin 500>",
  "genericName": "<active ingredient / generic name, e.g. Paracetamol, Azithromycin>",
  "manufacturer": "<manufacturing company name>",
  "dosage": "<strength e.g. 650mg, 500mg per tablet>",
  "uses": ["<use 1>", "<use 2>", "<use 3>"],
  "sideEffects": ["<side effect 1>", "<side effect 2>", "<side effect 3>"],
  "howToUse": "<dosage instructions>",
  "storage": "<storage instructions>",
  "warnings": ["<warning 1>", "<warning 2>"],
  "confidence": <integer 0-100 reflecting how confident you are in this extraction>
}

If a field is not visible on the label, fill it with your pharmaceutical knowledge.
If you cannot identify the medicine at all, set confidence to 0."""


async def call_gemini_vision(image_b64: str, model: str, api_version: str = "v1beta") -> dict:
    url = f"https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent?key={GEMINI_API_KEY}"
    payload = {
        "contents": [{
            "parts": [
                {"text": GEMINI_PROMPT},
                {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 1024,
        }
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini {model} HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
        return raw_text


def parse_gemini_response(raw: str) -> dict:
    """Strip markdown fences and parse JSON from Gemini response."""
    text = raw.strip()
    text = re.sub(r"^```json\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^```\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"```$", "", text, flags=re.MULTILINE)
    text = text.strip()
    return json.loads(text)


# ── Gemini circuit-breaker ────────────────────────────────────────────────────
# When Gemini daily quota is exhausted, stop hammering the API for 30 min.
import time as _time
_gemini_blocked_until: float = 0.0   # epoch seconds


def gemini_is_blocked() -> bool:
    return _time.monotonic() < _gemini_blocked_until


def set_gemini_blocked(seconds: float = 1800):
    global _gemini_blocked_until
    _gemini_blocked_until = _time.monotonic() + seconds
    log.warning(f"Gemini circuit-breaker OPEN for {int(seconds/60)} min")


async def gemini_ocr(image_b64: str) -> tuple[dict, str]:
    """Try each Gemini vision model in priority order. Returns (parsed_dict, model_name)."""
    if gemini_is_blocked():
        raise RuntimeError("Gemini circuit-breaker open – quota exhausted, using fallback")

    quota_failures = 0
    for model, api_ver in GEMINI_VISION_MODELS:
        for attempt in range(2):  # max 2 attempts per model (one retry on 429)
            try:
                raw = await call_gemini_vision(image_b64, model, api_ver)
                parsed = parse_gemini_response(raw)
                log.info(f"Gemini vision success via {model}, confidence={parsed.get('confidence')}")
                return parsed, model
            except RuntimeError as e:
                msg = str(e)
                if "HTTP 429" in msg:
                    quota_failures += 1
                    if attempt == 0:
                        log.warning(f"Gemini {model} rate-limited, retrying in 4s...")
                        await asyncio.sleep(4)
                        continue
                    # Second 429 in a row on same model → skip
                    log.warning(f"Gemini {model} still rate-limited, skipping")
                    break
                elif "HTTP 403" in msg or "HTTP 404" in msg:
                    log.warning(f"Gemini {model} unavailable, skipping")
                    break
                log.warning(f"Gemini {model} failed: {e}")
                break
            except Exception as e:
                log.warning(f"Gemini {model} error: {e}")
                break

    # If ALL models hit quota → open circuit-breaker for 30 min
    if quota_failures >= len(GEMINI_VISION_MODELS):
        set_gemini_blocked(1800)  # 30 minutes

    raise RuntimeError("All Gemini vision models failed")


# ── EasyOCR fallback ──────────────────────────────────────────────────────────
_easyocr_reader = None


def get_easyocr():
    global _easyocr_reader
    if _easyocr_reader is None:
        try:
            import easyocr  # lazy import – avoid startup cost if unused
            log.info("Initialising EasyOCR reader (may download models on first run)...")
            _easyocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
            log.info("EasyOCR reader ready")
        except ImportError:
            log.warning("easyocr not installed – fallback unavailable")
        except Exception as e:
            log.warning(f"EasyOCR init failed: {e}")
    return _easyocr_reader


def easyocr_extract(img_bytes: bytes) -> str:
    reader = get_easyocr()
    if reader is None:
        return ""
    try:
        results = reader.readtext(img_bytes, detail=0, paragraph=True)
        return "\n".join(results)
    except Exception as e:
        log.error(f"EasyOCR error: {e}")
        return ""


# Known medicine → info lookup (covers most common Indian OTC/Rx medicines)
# Keys are lowercase substrings to match against detected text
MEDICINE_KB: dict[str, dict] = {
    "dolo": {
        "brandName": "Dolo 650", "genericName": "Paracetamol", "manufacturer": "Micro Labs Ltd",
        "uses": ["Fever", "Mild to moderate pain", "Headache", "Body ache"],
        "sideEffects": ["Nausea", "Allergic reactions (rare)", "Liver damage with overdose"],
        "howToUse": "650mg every 4–6 hours, max 4 doses/day. Take with or without food.",
        "storage": "Store below 30°C, away from moisture.", "warnings": ["Do not exceed 4g/day", "Avoid alcohol"]
    },
    "paracetamol": {
        "brandName": "Paracetamol", "genericName": "Paracetamol (Acetaminophen)",
        "uses": ["Fever", "Pain relief", "Headache", "Body ache"],
        "sideEffects": ["Nausea", "Liver damage with overdose"],
        "howToUse": "500–1000mg every 4–6 hours as needed.", "warnings": ["Max 4g/day", "Avoid with alcohol"]
    },
    "azithromycin": {
        "brandName": "Azithromycin", "genericName": "Azithromycin",
        "uses": ["Bacterial infections", "Respiratory tract infections", "Skin infections", "Ear infections"],
        "sideEffects": ["Nausea", "Diarrhoea", "Abdominal pain", "Headache"],
        "howToUse": "500mg once daily for 3 days, OR 250mg once daily for 5 days. Take on empty stomach.",
        "storage": "Store below 30°C.", "warnings": ["Complete full course", "Inform doctor of heart conditions"]
    },
    "amoxicillin": {
        "brandName": "Amoxicillin", "genericName": "Amoxicillin",
        "uses": ["Bacterial infections", "Ear, nose, throat infections", "Urinary tract infections"],
        "sideEffects": ["Diarrhoea", "Nausea", "Skin rash", "Allergic reactions"],
        "howToUse": "250–500mg every 8 hours with or without food.", "warnings": ["Avoid if penicillin allergy"]
    },
    "ibuprofen": {
        "brandName": "Ibuprofen", "genericName": "Ibuprofen",
        "uses": ["Pain relief", "Fever", "Inflammation", "Arthritis"],
        "sideEffects": ["Stomach upset", "Nausea", "Headache", "Increased blood pressure"],
        "howToUse": "200–400mg every 4–6 hours. Always take with food.", "warnings": ["Avoid on empty stomach", "Not for kidney/heart patients"]
    },
    "cetirizine": {
        "brandName": "Cetirizine", "genericName": "Cetirizine Hydrochloride",
        "uses": ["Allergic rhinitis", "Urticaria (hives)", "Itching", "Hay fever"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Headache"],
        "howToUse": "10mg once daily at night.", "warnings": ["Avoid driving", "Avoid alcohol"]
    },
    "omeprazole": {
        "brandName": "Omeprazole", "genericName": "Omeprazole",
        "uses": ["Acid reflux", "GERD", "Peptic ulcer", "H. pylori infection"],
        "sideEffects": ["Headache", "Diarrhoea", "Nausea", "Abdominal pain"],
        "howToUse": "20mg once daily before meal.", "warnings": ["Long-term use may affect magnesium levels"]
    },
    "metformin": {
        "brandName": "Metformin", "genericName": "Metformin Hydrochloride",
        "uses": ["Type 2 diabetes management", "Blood sugar control"],
        "sideEffects": ["Nausea", "Diarrhoea", "Stomach upset", "Lactic acidosis (rare)"],
        "howToUse": "500mg twice daily with meals.", "warnings": ["Monitor kidney function", "Avoid alcohol"]
    },
    "atorvastatin": {
        "brandName": "Atorvastatin", "genericName": "Atorvastatin Calcium",
        "uses": ["High cholesterol", "Prevention of heart attack and stroke"],
        "sideEffects": ["Muscle pain", "Liver enzyme elevation", "Headache"],
        "howToUse": "10–40mg once daily at night.", "warnings": ["Report unexplained muscle pain", "Avoid grapefruit juice"]
    },
    "pantoprazole": {
        "brandName": "Pantoprazole", "genericName": "Pantoprazole Sodium",
        "uses": ["Acid reflux", "GERD", "Erosive esophagitis", "Zollinger-Ellison syndrome"],
        "sideEffects": ["Headache", "Diarrhoea", "Nausea"],
        "howToUse": "40mg once daily before breakfast.", "warnings": ["Long-term use may cause hypomagnesemia"]
    },
    # ── Additional medicines from test images ──────────────────────────────────
    "bosutinib": {
        "brandName": "Bosutris", "genericName": "Bosutinib", "manufacturer": "Mylan / Pfizer",
        "uses": ["Chronic myelogenous leukemia (CML)", "Philadelphia chromosome-positive CML"],
        "sideEffects": ["Diarrhoea", "Nausea", "Rash", "Fatigue", "Liver toxicity"],
        "howToUse": "500mg once daily with food. Do not crush/split tablets.",
        "storage": "Store at room temperature 20–25°C.", "warnings": ["Monitor liver function tests", "Not for use in pregnancy", "Report unusual bleeding"]
    },
    "bosutris": {
        "brandName": "Bosutris", "genericName": "Bosutinib", "manufacturer": "Mylan",
        "uses": ["Chronic myelogenous leukemia (CML)"],
        "sideEffects": ["Diarrhoea", "Nausea", "Rash", "Fatigue"],
        "howToUse": "500mg once daily with food.", "warnings": ["Monitor liver function", "Not in pregnancy"]
    },
    "cefixime": {
        "brandName": "Zifi 200", "genericName": "Cefixime", "manufacturer": "FDC Limited",
        "uses": ["Bacterial infections", "Urinary tract infections", "Ear infections", "Gonorrhoea"],
        "sideEffects": ["Diarrhoea", "Stomach pain", "Nausea", "Rash"],
        "howToUse": "200–400mg once or twice daily. May be taken with or without food.",
        "storage": "Store below 30°C.", "warnings": ["Complete full course", "Avoid if cephalosporin allergy"]
    },
    "zifi": {
        "brandName": "Zifi 200", "genericName": "Cefixime", "manufacturer": "FDC Limited",
        "uses": ["Bacterial infections", "Urinary tract infections", "Respiratory infections"],
        "sideEffects": ["Diarrhoea", "Nausea", "Stomach upset"],
        "howToUse": "200mg twice daily or 400mg once daily.", "warnings": ["Complete full course"]
    },
    "cilnidipine": {
        "brandName": "Nulong / Cilnidipine", "genericName": "Cilnidipine", "manufacturer": "Various",
        "uses": ["Hypertension (high blood pressure)", "Angina"],
        "sideEffects": ["Headache", "Dizziness", "Flushing", "Ankle swelling", "Palpitations"],
        "howToUse": "5–10mg once daily before or after meals.",
        "storage": "Store below 30°C.", "warnings": ["Do not stop abruptly", "Caution in elderly patients", "Monitor BP regularly"]
    },
    "nulong": {
        "brandName": "Nulong", "genericName": "Cilnidipine", "manufacturer": "Mankind Pharma",
        "uses": ["Hypertension", "Prevention of angina"],
        "sideEffects": ["Headache", "Dizziness", "Flushing", "Ankle swelling"],
        "howToUse": "10–20mg once daily.", "warnings": ["Do not stop abruptly", "Monitor BP"]
    },
    "zandu": {
        "brandName": "Zandu Nityam", "genericName": "Ayurvedic herbal formulation", "manufacturer": "Zandu Pharmaceutical Works",
        "uses": ["Constipation relief", "Bowel regularity", "Digestive wellness"],
        "sideEffects": ["Mild abdominal cramping if overused", "Loose stools"],
        "howToUse": "1–2 tablets at bedtime with warm water.",
        "storage": "Store in a cool dry place.", "warnings": ["Not for chronic use", "Consult doctor if symptoms persist"]
    },
    "nityam": {
        "brandName": "Zandu Nityam", "genericName": "Ayurvedic herbal laxative", "manufacturer": "Zandu Pharmaceutical Works",
        "uses": ["Constipation", "Bowel regularity"],
        "sideEffects": ["Mild cramps", "Loose stools"],
        "howToUse": "1–2 tablets at bedtime with warm water.", "warnings": ["Not for long-term use"]
    },
}

# Skip words that are NOT medicine names
_NAME_SKIP = {
    "tablet", "tablets", "capsule", "capsules", "syrup", "injection", "each",
    "contains", "uses", "store", "strip", "blister", "keep", "children",
    "reach", "away", "before", "expiry", "date", "batch", "mfg", "manufactured",
    "distributed", "marketed", "ltd", "limited", "pvt", "corp", "pharma",
    "pharmaceutical", "laboratories", "lab", "usp", "ip", "bp", "regd",
    "trademark", "registered", "product", "film", "coated", "directions",
}


def enrich_from_kb(name: str, raw_text: str) -> dict:
    """Look up medicine knowledge base by substring match. Prefers longer key matches."""
    combined = (name + " " + raw_text).lower()
    best_key = ""
    best_info: dict = {}
    for key, info in MEDICINE_KB.items():
        if key in combined and len(key) > len(best_key):
            best_key = key
            best_info = info
    return best_info


def parse_medicine_from_ocr(raw_text: str) -> dict:
    """Best-effort structured parse of raw EasyOCR text from a medicine label."""
    lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
    all_text = " ".join(lines)
    name = ""
    dosage = ""

    # ── dosage: 650mg, 500 mg, 10mg/5ml, 20mg ─────────────────────────────
    dosage_pat = re.compile(
        r'(\d+\.?\d*\s*(?:mg|mcg|ml|g|iu|%)(?:/\d+\s*(?:mg|ml))?)',
        re.IGNORECASE
    )
    dm = dosage_pat.search(all_text)
    if dm:
        dosage = dm.group(0).strip()

    # ── medicine name: prefer KB direct match over OCR parse ───────────────
    # First try: does the raw text contain a KB key directly?
    raw_lower = raw_text.lower()
    kb_direct = ""
    for key in MEDICINE_KB:
        if key in raw_lower and len(key) > len(kb_direct):
            kb_direct = key

    if kb_direct:
        # Use KB brand name as the identified name
        name = MEDICINE_KB[kb_direct].get("brandName", kb_direct.title())
    else:
        # Fallback: extract longest capitalised token that isn't a skip word
        # Look in first 8 lines for best candidate
        cap_pat = re.compile(r'\b([A-Za-z][a-zA-Z]{3,})\b')
        candidates: list[tuple[int, str]] = []
        for line in lines[:8]:
            for m in cap_pat.finditer(line):
                word = m.group(1)
                if word.lower() not in _NAME_SKIP and not word.isdigit():
                    # Score: longer words score higher; proper-case gets bonus
                    score = len(word) + (2 if word[0].isupper() else 0)
                    candidates.append((score, word))
        if candidates:
            candidates.sort(reverse=True)
            name = candidates[0][1]

    kb = enrich_from_kb(name, raw_text)
    return {
        "name": kb.get("brandName", name) if kb else name,
        "genericName": kb.get("genericName", ""),
        "manufacturer": kb.get("manufacturer", ""),
        "dosage": dosage or "",
        "uses": kb.get("uses", []),
        "sideEffects": kb.get("sideEffects", []),
        "howToUse": kb.get("howToUse", ""),
        "storage": kb.get("storage", ""),
        "warnings": kb.get("warnings", []),
    }


# ── core pipeline ─────────────────────────────────────────────────────────────
async def analyze_image(img_bytes: bytes) -> OcrResponse:
    t0 = time.monotonic()

    # Pre-process
    try:
        pil = bytes_to_pil(img_bytes)
        pil = preprocess_pil(pil)
        img_b64 = pil_to_base64(pil)
    except Exception as e:
        log.error(f"Image decode failed: {e}")
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    # 1. Try Gemini Vision
    if GEMINI_API_KEY:
        try:
            gemini_data, model_used = await gemini_ocr(img_b64)
            confidence = float(gemini_data.get("confidence", 85))

            def as_list(v):
                if isinstance(v, list):
                    return [str(x) for x in v if x]
                if isinstance(v, str) and v:
                    return [v]
                return []

            return OcrResponse(
                success=True,
                source=f"gemini:{model_used}",
                confidence=confidence,
                detectedText=str(gemini_data.get("detectedText", "")),
                medicine=MedicineInfo(
                    name=str(gemini_data.get("medicineName", "")),
                    genericName=str(gemini_data.get("genericName", "")),
                    manufacturer=str(gemini_data.get("manufacturer", "")),
                    dosage=str(gemini_data.get("dosage", "")),
                    uses=as_list(gemini_data.get("uses", [])),
                    sideEffects=as_list(gemini_data.get("sideEffects", [])),
                    howToUse=str(gemini_data.get("howToUse", "")),
                    storage=str(gemini_data.get("storage", "")),
                    warnings=as_list(gemini_data.get("warnings", [])),
                ),
                elapsedMs=int((time.monotonic() - t0) * 1000),
            )
        except Exception as e:
            log.warning(f"Gemini pipeline failed, falling back to EasyOCR: {e}")

    # 2. EasyOCR + knowledge-base structured fallback
    log.info("Using EasyOCR + knowledge-base fallback")
    raw_text = easyocr_extract(img_bytes)
    if raw_text:
        parsed = parse_medicine_from_ocr(raw_text)
        confidence = 55.0 if parsed.get("uses") else 35.0  # KB matched = higher confidence
        return OcrResponse(
            success=True,
            source="easyocr+kb",
            confidence=confidence,
            detectedText=raw_text,
            medicine=MedicineInfo(**parsed),
            elapsedMs=int((time.monotonic() - t0) * 1000),
        )

    return OcrResponse(
        success=False,
        source="failed",
        confidence=0.0,
        detectedText="",
        medicine=MedicineInfo(),
        elapsedMs=int((time.monotonic() - t0) * 1000),
    )


# ── routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    blocked = gemini_is_blocked()
    return {
        "status": "ok",
        "gemini_configured": bool(GEMINI_API_KEY),
        "gemini_ready": bool(GEMINI_API_KEY) and not blocked,
        "circuit_breaker": "open" if blocked else "closed",
        "easyocr_ready": _easyocr_reader is not None,
    }


@app.post("/reload-key")
async def reload_key():
    """Hot-reload the Gemini API key from .env without restarting the service."""
    global GEMINI_API_KEY, _gemini_blocked_until
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../.env"), override=True)
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env"), override=True)
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    _gemini_blocked_until = 0.0  # reset circuit-breaker
    return {"status": "ok", "gemini_configured": bool(GEMINI_API_KEY), "circuit_breaker": "reset"}


@app.post("/ocr-analyze", response_model=OcrResponse)
async def ocr_from_upload(file: UploadFile = File(...)):
    """Accept multipart file upload."""
    img_bytes = await file.read()
    return await analyze_image(img_bytes)


@app.post("/ocr-analyze-base64", response_model=OcrResponse)
async def ocr_from_base64(body: Base64Request):
    """Accept base64-encoded image (called from Node.js backend)."""
    try:
        img_bytes = base64.b64decode(body.imageBase64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")
    return await analyze_image(img_bytes)


# ── entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    log.info(f"Starting MedVision OCR Service on port {PORT}")
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
