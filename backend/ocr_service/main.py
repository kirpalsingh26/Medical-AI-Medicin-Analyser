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
    """Pre-warm EasyOCR in background; reset circuit breaker on every start."""
    global _gemini_blocked_until
    _gemini_blocked_until = 0.0  # always reset on start
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
    """Enhanced preprocessing for medicine label OCR – grayscale + aggressive sharpening."""
    img = img.convert("RGB")

    # Resize: upscale small images to at least 1024px wide; cap at 2048px
    max_w, min_w = 2048, 1024
    if img.width > max_w:
        ratio = max_w / img.width
        img = img.resize((max_w, int(img.height * ratio)), Image.LANCZOS)
    elif 0 < img.width < min_w:
        ratio = min_w / img.width
        img = img.resize((min_w, int(img.height * ratio)), Image.LANCZOS)

    # Convert to grayscale then back to RGB: removes colour noise, helps text detection
    img = img.convert("L").convert("RGB")

    # Strong contrast boost – separates dark text from background
    img = ImageEnhance.Contrast(img).enhance(1.9)

    # Aggressive sharpening for crisp text edges
    img = ImageEnhance.Sharpness(img).enhance(3.0)

    # Slight brightness lift for dark-packaged medicines
    img = ImageEnhance.Brightness(img).enhance(1.08)

    # Unsharp mask: radius=2, percent=220, threshold=3 – final crispness pass
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=220, threshold=3))

    return img


def pil_to_base64(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return base64.b64encode(buf.getvalue()).decode()


def bytes_to_pil(data: bytes) -> Image.Image:
    return Image.open(BytesIO(data))


# ── Gemini Vision ─────────────────────────────────────────────────────────────
GEMINI_PROMPT = """You are a senior clinical pharmacist and medical label expert specializing in Indian and international pharmaceuticals with 20+ years of experience.

Analyze this medicine/pharmaceutical product image in THREE steps:

STEP 1 – READ: Carefully read EVERY piece of text visible, including:
- The large brand name printed prominently
- Active ingredient / generic name (often smaller text below brand)
- Strength/dosage (e.g. 650mg, 500mg/5ml)
- Manufacturer name
- Any Hindi/Devanagari text (transliterate to English)
- Batch no, MFG date, EXP date (use for context only, not as the medicine name)

STEP 2 – IDENTIFY: Match what you read to a specific pharmaceutical product.
- Brand name takes priority over generic name for medicineName field
- For strips/blisters: the name printed on the foil IS the medicine name
- If you see only a number (e.g. "650") look for the text immediately before it — that together is the name
- Ignore water marks, website text (e.g. ".com"), batch numbers as the name

STEP 3 – FILL: Complete all fields using your pharmaceutical knowledge where label text is incomplete.

EXAMPLES of correct identification:
- Label shows "DOLO 650" → medicineName: "Dolo 650", genericName: "Paracetamol", dosage: "650mg"
- Label shows "Crocin Advance" → medicineName: "Crocin Advance", genericName: "Paracetamol", dosage: "500mg"
- Label shows "AUGMENTIN 625 DUO" → medicineName: "Augmentin 625 Duo", genericName: "Amoxicillin + Clavulanic Acid"
- Label shows "Combiflam" → medicineName: "Combiflam", genericName: "Ibuprofen 400mg + Paracetamol 325mg"
- Label shows "Azithral 500" → medicineName: "Azithral 500", genericName: "Azithromycin", dosage: "500mg"
- Label shows "Pan 40" → medicineName: "Pan 40", genericName: "Pantoprazole", dosage: "40mg"
- Label shows "Glycomet 500" → medicineName: "Glycomet 500", genericName: "Metformin HCl", dosage: "500mg"
- Label shows "Shelcal 500" → medicineName: "Shelcal 500", genericName: "Calcium Carbonate + Vitamin D3"

Return ONLY a valid JSON object — no markdown fences, no explanation, no extra text:
{
  "detectedText": "<ALL visible text on the label, verbatim, line by line>",
  "medicineName": "<exact brand name as printed, e.g. Dolo 650, Crocin 500, Augmentin 625 Duo, Combiflam>",
  "genericName": "<INN / active ingredient(s), e.g. Paracetamol, Amoxicillin + Clavulanic Acid, Ibuprofen + Paracetamol>",
  "manufacturer": "<company name exactly as printed on label>",
  "dosage": "<strength per unit as printed, e.g. 650mg, 500mg/5ml, 10mg, 40mg>",
  "uses": ["<primary therapeutic use>", "<use 2>", "<use 3>"],
  "sideEffects": ["<most common side effect>", "<side effect 2>", "<side effect 3>"],
  "howToUse": "<specific dosage regimen and administration instructions>",
  "storage": "<storage conditions from label or standard pharmaceutical guidelines>",
  "warnings": ["<critical warning 1>", "<warning 2>"],
  "confidence": <integer 0-100: 92-100 if brand name clearly readable, 75-91 if identifiable with minor inference, 50-74 if partially visible, 25-49 if heavily obscured, 0-24 if unreadable>
}

CRITICAL RULES:
1. medicineName MUST be the exact brand name printed on THIS product (e.g. 'Crocin 500', NOT just 'Paracetamol')
2. For combination drugs, list ALL active ingredients in genericName (e.g. 'Ibuprofen 400mg + Paracetamol 325mg')
3. If the label contains Hindi/Devanagari or regional language text, transliterate the medicine name to English
4. Fill uses/sideEffects/howToUse/storage/warnings from your pharmaceutical knowledge if not visible on label
5. Never set confidence above 70 if you cannot clearly read the medicine name
6. If you see a medicine strip/blister, focus on the printed brand name on the foil or box
7. The brand name + strength together form the medicineName (e.g. "Dolo" + "650" = "Dolo 650")
8. Common Indian pharma companies: Micro Labs, Cipla, Sun Pharma, Mankind, Alkem, Abbott, Pfizer, Lupin, Dr Reddy's, Zydus, Torrent, Emcure, Ipca, Glenmark
9. Extended Indian brand list: Dolo, Crocin, Calpol, Combiflam, Allegra, Montair, Telma, Zifi, Pan, Nexium, Azee, Azithral, Ciplox, Augmentin, Becosules, Limcee, Revital, Shelcal, Volini, Moov, Zandu, Glycomet, Glyciphage, Metpure, Januvia, Galvus, Amaryl, Pioz, Ecosprin, Atorva, Rosuvas, Sorvas, Stamlo, Amlodac, Telmikind, Telsar, Olmesart, Tazloc, Losartas, Eritel, Repace, Aten, Metolar, Concor, Corbis, Tonact, Zanocin, Oflomac, Cifran, Ciproflox, Taxim, Monocef, Meronem, Doxylin, Doxinate, Tryptomer, Gabapentin, Pregabalin, Lyrica, Gabantin, Rejunex, Methylcobal, Neurobion, Nucoxia, Nise, Voveran, Diclofenac, Brufen, Ibugesic, Nicip, Zerodol, Meftal, Meftagesic"""


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
    log.warning(f"Gemini circuit-breaker OPEN for {int(seconds/60)} min (will auto-reset)")


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
        set_gemini_blocked(300)  # 5 minutes

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



# Known medicine → info lookup — auto-generated from DB (254 medicines)
# Keys are lowercase full names; enrich_from_kb does substring matching
MEDICINE_KB: dict[str, dict] = {
    "paracetamol": {
        "brandName": "Paracetamol", "genericName": "Paracetamol", "manufacturer": "Various",
        "dosage": "500mg - 1000mg", "uses": ["Fever", "Headache", "Body pain", "Dental pain"],
        "sideEffects": ["Liver damage in overdose", "Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg - 1000mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ibuprofen": {
        "brandName": "Ibuprofen", "genericName": "Ibuprofen", "manufacturer": "Various",
        "dosage": "200mg - 800mg", "uses": ["Pain", "Inflammation", "Fever", "Menstrual cramps", "Arthritis"],
        "sideEffects": ["Stomach upset", "GI bleeding", "Headache"],
        "howToUse": "Take as directed. Dosage: 200mg - 800mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "amoxicillin": {
        "brandName": "Amoxicillin", "genericName": "Amoxicillin Trihydrate", "manufacturer": "Various",
        "dosage": "250mg - 500mg", "uses": ["Bacterial infections", "Pneumonia", "UTI", "Ear infections"],
        "sideEffects": ["Diarrhea", "Nausea", "Rash"],
        "howToUse": "Take as directed. Dosage: 250mg - 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "tylenol extra strength": {
        "brandName": "Tylenol Extra Strength", "genericName": "Acetaminophen", "manufacturer": "Johnson & Johnson",
        "dosage": "500mg", "uses": ["Pain relief", "Fever reduction"],
        "sideEffects": ["Liver damage in overdose"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "advil": {
        "brandName": "Advil", "genericName": "Ibuprofen", "manufacturer": "Pfizer",
        "dosage": "200mg", "uses": ["Pain", "Fever", "Inflammation"],
        "sideEffects": ["GI upset", "Bleeding risk"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "motrin": {
        "brandName": "Motrin", "genericName": "Ibuprofen", "manufacturer": "Johnson & Johnson",
        "dosage": "200mg", "uses": ["Pain", "Fever", "Inflammation"],
        "sideEffects": ["GI irritation"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "aleve": {
        "brandName": "Aleve", "genericName": "Naproxen Sodium", "manufacturer": "Bayer",
        "dosage": "220mg", "uses": ["Pain", "Arthritis", "Menstrual cramps", "Headache"],
        "sideEffects": ["GI irritation"],
        "howToUse": "Take as directed. Dosage: 220mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "aspirin": {
        "brandName": "Aspirin", "genericName": "Acetylsalicylic Acid", "manufacturer": "Bayer",
        "dosage": "81mg - 325mg", "uses": ["Pain", "Fever", "Cardiovascular prevention"],
        "sideEffects": ["GI bleeding", "Ulcer"],
        "howToUse": "Take as directed. Dosage: 81mg - 325mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lipitor": {
        "brandName": "Lipitor", "genericName": "Atorvastatin Calcium", "manufacturer": "Pfizer",
        "dosage": "10mg - 80mg", "uses": ["High cholesterol", "LDL reduction", "Cardiovascular prevention"],
        "sideEffects": ["Muscle pain", "Liver problems", "Headache"],
        "howToUse": "Take as directed. Dosage: 10mg - 80mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "crestor": {
        "brandName": "Crestor", "genericName": "Rosuvastatin Calcium", "manufacturer": "AstraZeneca",
        "dosage": "5mg - 40mg", "uses": ["High cholesterol", "Dyslipidemia", "Heart disease prevention"],
        "sideEffects": ["Muscle pain", "Headache"],
        "howToUse": "Take as directed. Dosage: 5mg - 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zocor": {
        "brandName": "Zocor", "genericName": "Simvastatin", "manufacturer": "Merck",
        "dosage": "10mg - 40mg", "uses": ["High cholesterol", "Triglycerides", "Cardiovascular risk reduction"],
        "sideEffects": ["Myopathy", "Liver toxicity"],
        "howToUse": "Take as directed. Dosage: 10mg - 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "metformin": {
        "brandName": "Metformin", "genericName": "Metformin Hydrochloride", "manufacturer": "Various",
        "dosage": "500mg - 2000mg", "uses": ["Type 2 diabetes", "Blood sugar control", "PCOS"],
        "sideEffects": ["GI upset", "Lactic acidosis (rare)", "B12 deficiency"],
        "howToUse": "Take as directed. Dosage: 500mg - 2000mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "januvia": {
        "brandName": "Januvia", "genericName": "Sitagliptin Phosphate", "manufacturer": "Merck",
        "dosage": "100mg", "uses": ["Type 2 diabetes", "Blood sugar control"],
        "sideEffects": ["Pancreatitis", "Nasopharyngitis", "UTI"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "jardiance": {
        "brandName": "Jardiance", "genericName": "Empagliflozin", "manufacturer": "Boehringer Ingelheim",
        "dosage": "10mg - 25mg", "uses": ["Type 2 diabetes", "Heart failure", "CKD"],
        "sideEffects": ["Genital infections", "UTI", "Dehydration"],
        "howToUse": "Take as directed. Dosage: 10mg - 25mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "farxiga": {
        "brandName": "Farxiga", "genericName": "Dapagliflozin", "manufacturer": "AstraZeneca",
        "dosage": "10mg", "uses": ["Type 2 diabetes", "Heart failure", "CKD"],
        "sideEffects": ["Genital infections", "UTI"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ozempic": {
        "brandName": "Ozempic", "genericName": "Semaglutide", "manufacturer": "Novo Nordisk",
        "dosage": "0.5mg - 2mg weekly", "uses": ["Type 2 diabetes", "Weight management"],
        "sideEffects": ["Nausea", "Vomiting", "Pancreatitis"],
        "howToUse": "Take as directed. Dosage: 0.5mg - 2mg weekly", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "prilosec": {
        "brandName": "Prilosec", "genericName": "Omeprazole", "manufacturer": "AstraZeneca",
        "dosage": "20mg - 40mg", "uses": ["GERD", "Peptic ulcer", "H. pylori"],
        "sideEffects": ["Headache", "Nausea", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 20mg - 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "nexium": {
        "brandName": "Nexium", "genericName": "Esomeprazole Magnesium", "manufacturer": "AstraZeneca",
        "dosage": "20mg - 40mg", "uses": ["GERD", "Peptic ulcer", "Erosive esophagitis"],
        "sideEffects": ["Headache", "Diarrhea", "Nausea"],
        "howToUse": "Take as directed. Dosage: 20mg - 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "prevacid": {
        "brandName": "Prevacid", "genericName": "Lansoprazole", "manufacturer": "Takeda",
        "dosage": "15mg - 30mg", "uses": ["GERD", "Peptic ulcer", "H. pylori"],
        "sideEffects": ["Headache", "GI upset"],
        "howToUse": "Take as directed. Dosage: 15mg - 30mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lisinopril": {
        "brandName": "Lisinopril", "genericName": "Lisinopril", "manufacturer": "AstraZeneca",
        "dosage": "5mg - 40mg", "uses": ["Hypertension", "Heart failure", "Diabetic nephropathy", "Post-MI"],
        "sideEffects": ["Dry cough", "Angioedema", "Hyperkalemia", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 5mg - 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "losartan": {
        "brandName": "Losartan", "genericName": "Losartan Potassium", "manufacturer": "Merck",
        "dosage": "25mg - 100mg", "uses": ["Hypertension", "Heart failure", "Diabetic nephropathy"],
        "sideEffects": ["Dizziness", "Hyperkalemia", "Hypotension"],
        "howToUse": "Take as directed. Dosage: 25mg - 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "norvasc": {
        "brandName": "Norvasc", "genericName": "Amlodipine Besylate", "manufacturer": "Pfizer",
        "dosage": "2.5mg - 10mg", "uses": ["Hypertension", "Angina", "Coronary artery disease"],
        "sideEffects": ["Ankle swelling", "Headache", "Flushing"],
        "howToUse": "Take as directed. Dosage: 2.5mg - 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "diovan": {
        "brandName": "Diovan", "genericName": "Valsartan", "manufacturer": "Novartis",
        "dosage": "80mg - 320mg", "uses": ["Hypertension", "Heart failure", "Post-MI"],
        "sideEffects": ["Dizziness", "Hypotension", "Hyperkalemia"],
        "howToUse": "Take as directed. Dosage: 80mg - 320mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "toprol xl": {
        "brandName": "Toprol XL", "genericName": "Metoprolol Succinate", "manufacturer": "AstraZeneca",
        "dosage": "25mg - 200mg", "uses": ["Hypertension", "Angina", "Heart failure", "Arrhythmia"],
        "sideEffects": ["Fatigue", "Bradycardia", "Cold extremities"],
        "howToUse": "Take as directed. Dosage: 25mg - 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "tenormin": {
        "brandName": "Tenormin", "genericName": "Atenolol", "manufacturer": "AstraZeneca",
        "dosage": "25mg - 100mg", "uses": ["Hypertension", "Angina", "Arrhythmia"],
        "sideEffects": ["Fatigue", "Bradycardia", "Cold limbs"],
        "howToUse": "Take as directed. Dosage: 25mg - 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "synthroid": {
        "brandName": "Synthroid", "genericName": "Levothyroxine Sodium", "manufacturer": "AbbVie",
        "dosage": "25mcg - 200mcg", "uses": ["Hypothyroidism", "Thyroid hormone replacement"],
        "sideEffects": ["Palpitations in overdose", "Tremor", "Insomnia"],
        "howToUse": "Take as directed. Dosage: 25mcg - 200mcg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "coumadin": {
        "brandName": "Coumadin", "genericName": "Warfarin Sodium", "manufacturer": "Bristol-Myers Squibb",
        "dosage": "1mg - 10mg", "uses": ["DVT", "Pulmonary embolism", "Atrial fibrillation", "Mechanical heart valves"],
        "sideEffects": ["Bleeding", "Bruising", "Drug/food interactions"],
        "howToUse": "Take as directed. Dosage: 1mg - 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "eliquis": {
        "brandName": "Eliquis", "genericName": "Apixaban", "manufacturer": "Bristol-Myers Squibb/Pfizer",
        "dosage": "2.5mg - 5mg", "uses": ["DVT/PE treatment", "AF-related stroke prevention"],
        "sideEffects": ["Bleeding", "Bruising"],
        "howToUse": "Take as directed. Dosage: 2.5mg - 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "xarelto": {
        "brandName": "Xarelto", "genericName": "Rivaroxaban", "manufacturer": "Bayer/Janssen",
        "dosage": "10mg - 20mg", "uses": ["DVT/PE prevention", "AF-related stroke"],
        "sideEffects": ["Bleeding", "Nausea"],
        "howToUse": "Take as directed. Dosage: 10mg - 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "plavix": {
        "brandName": "Plavix", "genericName": "Clopidogrel Bisulfate", "manufacturer": "Sanofi/Bristol-Myers Squibb",
        "dosage": "75mg", "uses": ["ACS", "Post-angioplasty", "Stroke prevention"],
        "sideEffects": ["Bleeding", "Bruising", "GI upset"],
        "howToUse": "Take as directed. Dosage: 75mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "prozac": {
        "brandName": "Prozac", "genericName": "Fluoxetine Hydrochloride", "manufacturer": "Eli Lilly",
        "dosage": "10mg - 80mg", "uses": ["Major depression", "OCD", "Bulimia nervosa", "Panic disorder"],
        "sideEffects": ["Nausea", "Insomnia", "Headache", "Sexual dysfunction"],
        "howToUse": "Take as directed. Dosage: 10mg - 80mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zoloft": {
        "brandName": "Zoloft", "genericName": "Sertraline Hydrochloride", "manufacturer": "Pfizer",
        "dosage": "25mg - 200mg", "uses": ["Depression", "OCD", "PTSD", "Panic disorder"],
        "sideEffects": ["Nausea", "Insomnia", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 25mg - 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lexapro": {
        "brandName": "Lexapro", "genericName": "Escitalopram Oxalate", "manufacturer": "Forest Labs",
        "dosage": "5mg - 20mg", "uses": ["Major depression", "Generalized anxiety disorder"],
        "sideEffects": ["Nausea", "Insomnia", "Headache"],
        "howToUse": "Take as directed. Dosage: 5mg - 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cymbalta": {
        "brandName": "Cymbalta", "genericName": "Duloxetine Hydrochloride", "manufacturer": "Eli Lilly",
        "dosage": "20mg - 120mg", "uses": ["Major depression", "GAD", "Fibromyalgia", "Diabetic neuropathy"],
        "sideEffects": ["Nausea", "Dry mouth", "Constipation"],
        "howToUse": "Take as directed. Dosage: 20mg - 120mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lyrica": {
        "brandName": "Lyrica", "genericName": "Pregabalin", "manufacturer": "Pfizer",
        "dosage": "75mg - 600mg", "uses": ["Neuropathic pain", "Fibromyalgia", "Epilepsy", "GAD"],
        "sideEffects": ["Dizziness", "Somnolence", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 75mg - 600mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "neurontin": {
        "brandName": "Neurontin", "genericName": "Gabapentin", "manufacturer": "Pfizer",
        "dosage": "100mg - 3600mg", "uses": ["Epilepsy", "Post-herpetic neuralgia", "Neuropathic pain"],
        "sideEffects": ["Dizziness", "Fatigue", "Ataxia", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 100mg - 3600mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "xanax": {
        "brandName": "Xanax", "genericName": "Alprazolam", "manufacturer": "Pfizer",
        "dosage": "0.25mg - 4mg", "uses": ["Anxiety disorders", "Panic disorder"],
        "sideEffects": ["Dependence", "Sedation", "Memory impairment"],
        "howToUse": "Take as directed. Dosage: 0.25mg - 4mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "valium": {
        "brandName": "Valium", "genericName": "Diazepam", "manufacturer": "Roche",
        "dosage": "2mg - 10mg", "uses": ["Anxiety", "Muscle spasms", "Seizures", "Alcohol withdrawal"],
        "sideEffects": ["Sedation", "Dependence", "Respiratory depression"],
        "howToUse": "Take as directed. Dosage: 2mg - 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ativan": {
        "brandName": "Ativan", "genericName": "Lorazepam", "manufacturer": "Pfizer",
        "dosage": "0.5mg - 4mg", "uses": ["Anxiety", "Insomnia", "Status epilepticus", "Pre-procedure sedation"],
        "sideEffects": ["Sedation", "Dependence", "Respiratory depression"],
        "howToUse": "Take as directed. Dosage: 0.5mg - 4mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "klonopin": {
        "brandName": "Klonopin", "genericName": "Clonazepam", "manufacturer": "Roche",
        "dosage": "0.25mg - 20mg", "uses": ["Panic disorder", "Epilepsy"],
        "sideEffects": ["Dependence", "Sedation", "Cognitive impairment"],
        "howToUse": "Take as directed. Dosage: 0.25mg - 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ambien": {
        "brandName": "Ambien", "genericName": "Zolpidem Tartrate", "manufacturer": "Sanofi",
        "dosage": "5mg - 10mg", "uses": ["Insomnia", "Short-term sleep initiation"],
        "sideEffects": ["Complex sleep behaviors", "Dependence", "Daytime drowsiness"],
        "howToUse": "Take as directed. Dosage: 5mg - 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "prednisone": {
        "brandName": "Prednisone", "genericName": "Prednisone", "manufacturer": "Various",
        "dosage": "1mg - 60mg", "uses": ["Inflammation", "Autoimmune diseases", "Asthma", "Allergic reactions"],
        "sideEffects": ["Weight gain", "Hyperglycemia", "Osteoporosis", "Infection risk"],
        "howToUse": "Take as directed. Dosage: 1mg - 60mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "medrol": {
        "brandName": "Medrol", "genericName": "Methylprednisolone", "manufacturer": "Pfizer",
        "dosage": "4mg - 1000mg", "uses": ["Inflammation", "Autoimmune diseases", "Severe asthma"],
        "sideEffects": ["Weight gain", "Hyperglycemia", "Osteoporosis"],
        "howToUse": "Take as directed. Dosage: 4mg - 1000mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zyrtec": {
        "brandName": "Zyrtec", "genericName": "Cetirizine Hydrochloride", "manufacturer": "Johnson & Johnson",
        "dosage": "5mg - 10mg", "uses": ["Allergic rhinitis", "Chronic urticaria", "Skin allergies"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Headache"],
        "howToUse": "Take as directed. Dosage: 5mg - 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "claritin": {
        "brandName": "Claritin", "genericName": "Loratadine", "manufacturer": "Bayer",
        "dosage": "10mg", "uses": ["Allergic rhinitis", "Urticaria", "Hay fever"],
        "sideEffects": ["Headache", "Dry mouth", "Fatigue"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "benadryl usa": {
        "brandName": "Benadryl USA", "genericName": "Diphenhydramine Hydrochloride", "manufacturer": "Johnson & Johnson",
        "dosage": "25mg - 50mg", "uses": ["Allergies", "Motion sickness", "Sleep aid", "Itching"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Urinary retention", "Constipation"],
        "howToUse": "Take as directed. Dosage: 25mg - 50mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zithromax": {
        "brandName": "Zithromax", "genericName": "Azithromycin", "manufacturer": "Pfizer",
        "dosage": "250mg - 500mg", "uses": ["Community-acquired pneumonia", "Bronchitis", "Sinusitis", "Chlamydia"],
        "sideEffects": ["Nausea", "Diarrhea", "Abdominal pain", "QT prolongation"],
        "howToUse": "Take as directed. Dosage: 250mg - 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cipro": {
        "brandName": "Cipro", "genericName": "Ciprofloxacin Hydrochloride", "manufacturer": "Bayer",
        "dosage": "250mg - 750mg", "uses": ["UTI", "Pneumonia", "Typhoid", "GI infections"],
        "sideEffects": ["Tendon rupture", "QT prolongation", "Nausea", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 250mg - 750mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "levaquin": {
        "brandName": "Levaquin", "genericName": "Levofloxacin", "manufacturer": "Janssen",
        "dosage": "250mg - 750mg", "uses": ["Pneumonia", "Sinusitis", "UTI", "Skin infections"],
        "sideEffects": ["Tendon rupture", "QT prolongation", "Nausea"],
        "howToUse": "Take as directed. Dosage: 250mg - 750mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "augmentin usa": {
        "brandName": "Augmentin USA", "genericName": "Amoxicillin-Clavulanate", "manufacturer": "GSK",
        "dosage": "875/125mg", "uses": ["Respiratory infections", "Sinusitis", "UTI", "Ear infections"],
        "sideEffects": ["Diarrhea", "Nausea", "Rash"],
        "howToUse": "Take as directed. Dosage: 875/125mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "amoxil": {
        "brandName": "Amoxil", "genericName": "Amoxicillin", "manufacturer": "GSK",
        "dosage": "250mg - 500mg", "uses": ["Bacterial infections", "Strep throat", "H. pylori", "UTI"],
        "sideEffects": ["Diarrhea", "Rash", "Nausea"],
        "howToUse": "Take as directed. Dosage: 250mg - 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "diflucan": {
        "brandName": "Diflucan", "genericName": "Fluconazole", "manufacturer": "Pfizer",
        "dosage": "50mg - 400mg", "uses": ["Vaginal candidiasis", "Oral thrush", "Cryptococcal meningitis", "Tinea"],
        "sideEffects": ["Nausea", "Headache", "Hepatotoxicity"],
        "howToUse": "Take as directed. Dosage: 50mg - 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zofran": {
        "brandName": "Zofran", "genericName": "Ondansetron Hydrochloride", "manufacturer": "GSK",
        "dosage": "4mg - 32mg", "uses": ["Chemotherapy-induced nausea", "PONV", "Gastroenteritis"],
        "sideEffects": ["Headache", "Constipation", "QT prolongation"],
        "howToUse": "Take as directed. Dosage: 4mg - 32mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "tamiflu": {
        "brandName": "Tamiflu", "genericName": "Oseltamivir Phosphate", "manufacturer": "Roche",
        "dosage": "75mg", "uses": ["Influenza A and B treatment", "Influenza prophylaxis"],
        "sideEffects": ["Nausea", "Vomiting", "Headache"],
        "howToUse": "Take as directed. Dosage: 75mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "valtrex": {
        "brandName": "Valtrex", "genericName": "Valacyclovir Hydrochloride", "manufacturer": "GSK",
        "dosage": "500mg - 1000mg", "uses": ["Herpes zoster", "Genital herpes", "Cold sores", "Chickenpox"],
        "sideEffects": ["Nausea", "Headache", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 500mg - 1000mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zovirax": {
        "brandName": "Zovirax", "genericName": "Acyclovir", "manufacturer": "GSK",
        "dosage": "200mg - 800mg", "uses": ["Herpes simplex", "Herpes zoster", "Chickenpox", "HSV encephalitis"],
        "sideEffects": ["Nausea", "Headache", "Nephrotoxicity"],
        "howToUse": "Take as directed. Dosage: 200mg - 800mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "flomax": {
        "brandName": "Flomax", "genericName": "Tamsulosin Hydrochloride", "manufacturer": "Boehringer Ingelheim",
        "dosage": "0.4mg", "uses": ["Benign prostatic hyperplasia", "Kidney stone passage"],
        "sideEffects": ["Orthostatic hypotension", "Retrograde ejaculation", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 0.4mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zyloprim": {
        "brandName": "Zyloprim", "genericName": "Allopurinol", "manufacturer": "Mylan",
        "dosage": "100mg - 800mg", "uses": ["Gout", "Hyperuricemia", "Uric acid kidney stones"],
        "sideEffects": ["Stevens-Johnson syndrome", "Rash", "GI upset"],
        "howToUse": "Take as directed. Dosage: 100mg - 800mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "colchicine": {
        "brandName": "Colchicine", "genericName": "Colchicine", "manufacturer": "Takeda",
        "dosage": "0.6mg", "uses": ["Acute gout", "Gout prophylaxis", "Pericarditis"],
        "sideEffects": ["Diarrhea", "Nausea", "Vomiting"],
        "howToUse": "Take as directed. Dosage: 0.6mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lasix": {
        "brandName": "Lasix", "genericName": "Furosemide", "manufacturer": "Sanofi",
        "dosage": "20mg - 600mg", "uses": ["Heart failure", "Pulmonary edema", "Hypertension", "Edema"],
        "sideEffects": ["Electrolyte imbalance", "Dehydration", "Ototoxicity"],
        "howToUse": "Take as directed. Dosage: 20mg - 600mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "hydrodiuril": {
        "brandName": "HydroDIURIL", "genericName": "Hydrochlorothiazide", "manufacturer": "Various",
        "dosage": "12.5mg - 50mg", "uses": ["Hypertension", "Edema", "Heart failure"],
        "sideEffects": ["Electrolyte disturbances", "Hyperuricemia", "Hyperglycemia"],
        "howToUse": "Take as directed. Dosage: 12.5mg - 50mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "aldactone": {
        "brandName": "Aldactone", "genericName": "Spironolactone", "manufacturer": "Pfizer",
        "dosage": "25mg - 200mg", "uses": ["Heart failure", "Hypertension", "Hyperaldosteronism", "Hormonal acne"],
        "sideEffects": ["Hyperkalemia", "Gynecomastia", "Menstrual irregularity"],
        "howToUse": "Take as directed. Dosage: 25mg - 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lantus": {
        "brandName": "Lantus", "genericName": "Insulin Glargine", "manufacturer": "Sanofi",
        "dosage": "100 units/mL", "uses": ["Type 1 diabetes", "Type 2 diabetes", "Once-daily basal insulin"],
        "sideEffects": ["Hypoglycemia", "Weight gain", "Injection site reactions"],
        "howToUse": "Take as directed. Dosage: 100 units/mL", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "novolog": {
        "brandName": "NovoLog", "genericName": "Insulin Aspart", "manufacturer": "Novo Nordisk",
        "dosage": "100 units/mL", "uses": ["Type 1 and 2 diabetes", "Mealtime insulin"],
        "sideEffects": ["Hypoglycemia", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 100 units/mL", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "humalog": {
        "brandName": "Humalog", "genericName": "Insulin Lispro", "manufacturer": "Eli Lilly",
        "dosage": "100 units/mL", "uses": ["Type 1 and 2 diabetes", "Mealtime insulin"],
        "sideEffects": ["Hypoglycemia", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 100 units/mL", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "abilify": {
        "brandName": "Abilify", "genericName": "Aripiprazole", "manufacturer": "Otsuka",
        "dosage": "2mg - 30mg", "uses": ["Schizophrenia", "Bipolar I disorder", "Major depression adjunct", "Autism"],
        "sideEffects": ["Akathisia", "Weight gain", "Metabolic effects", "Tardive dyskinesia"],
        "howToUse": "Take as directed. Dosage: 2mg - 30mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "seroquel": {
        "brandName": "Seroquel", "genericName": "Quetiapine Fumarate", "manufacturer": "AstraZeneca",
        "dosage": "25mg - 800mg", "uses": ["Schizophrenia", "Bipolar disorder", "Major depression adjunct"],
        "sideEffects": ["Sedation", "Weight gain", "Metabolic syndrome"],
        "howToUse": "Take as directed. Dosage: 25mg - 800mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "risperdal": {
        "brandName": "Risperdal", "genericName": "Risperidone", "manufacturer": "Janssen",
        "dosage": "0.5mg - 8mg", "uses": ["Schizophrenia", "Bipolar disorder", "Autism-related irritability"],
        "sideEffects": ["EPS", "Tardive dyskinesia", "Prolactin elevation", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 0.5mg - 8mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zyprexa": {
        "brandName": "Zyprexa", "genericName": "Olanzapine", "manufacturer": "Eli Lilly",
        "dosage": "2.5mg - 20mg", "uses": ["Schizophrenia", "Bipolar disorder"],
        "sideEffects": ["Significant weight gain", "Hyperglycemia", "Sedation"],
        "howToUse": "Take as directed. Dosage: 2.5mg - 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "adderall": {
        "brandName": "Adderall", "genericName": "Mixed Amphetamine Salts", "manufacturer": "Shire",
        "dosage": "5mg - 30mg", "uses": ["ADHD", "Narcolepsy"],
        "sideEffects": ["Insomnia", "Appetite loss", "Hypertension", "Dependence"],
        "howToUse": "Take as directed. Dosage: 5mg - 30mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ritalin": {
        "brandName": "Ritalin", "genericName": "Methylphenidate Hydrochloride", "manufacturer": "Novartis",
        "dosage": "5mg - 60mg", "uses": ["ADHD", "Narcolepsy"],
        "sideEffects": ["Insomnia", "Appetite suppression", "Headache"],
        "howToUse": "Take as directed. Dosage: 5mg - 60mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "entresto": {
        "brandName": "Entresto", "genericName": "Sacubitril-Valsartan", "manufacturer": "Novartis",
        "dosage": "24/26mg - 97/103mg", "uses": ["Heart failure with reduced ejection fraction"],
        "sideEffects": ["Hypotension", "Hyperkalemia", "Renal impairment"],
        "howToUse": "Take as directed. Dosage: 24/26mg - 97/103mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "trulicity": {
        "brandName": "Trulicity", "genericName": "Dulaglutide", "manufacturer": "Eli Lilly",
        "dosage": "0.75mg - 4.5mg weekly", "uses": ["Type 2 diabetes", "Cardiovascular risk reduction"],
        "sideEffects": ["Nausea", "Diarrhea", "Pancreatitis"],
        "howToUse": "Take as directed. Dosage: 0.75mg - 4.5mg weekly", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "victoza": {
        "brandName": "Victoza", "genericName": "Liraglutide", "manufacturer": "Novo Nordisk",
        "dosage": "0.6mg - 1.8mg daily", "uses": ["Type 2 diabetes", "Obesity"],
        "sideEffects": ["Nausea", "Pancreatitis", "GI upset"],
        "howToUse": "Take as directed. Dosage: 0.6mg - 1.8mg daily", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "bactrim": {
        "brandName": "Bactrim", "genericName": "Sulfamethoxazole-Trimethoprim", "manufacturer": "Roche",
        "dosage": "800/160mg", "uses": ["UTI", "PCP pneumonia", "MRSA skin infections", "Traveler's diarrhea"],
        "sideEffects": ["Rash", "Stevens-Johnson syndrome", "Hyperkalemia"],
        "howToUse": "Take as directed. Dosage: 800/160mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "doxycycline": {
        "brandName": "Doxycycline", "genericName": "Doxycycline Hyclate", "manufacturer": "Various",
        "dosage": "100mg", "uses": ["Bacterial infections", "Acne", "Malaria prophylaxis", "Chlamydia", "Lyme disease"],
        "sideEffects": ["Photosensitivity", "Esophageal irritation", "Nausea"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "keflex": {
        "brandName": "Keflex", "genericName": "Cephalexin Monohydrate", "manufacturer": "Shionogi",
        "dosage": "250mg - 500mg", "uses": ["Skin infections", "Strep throat", "UTI", "Cellulitis"],
        "sideEffects": ["Diarrhea", "Nausea", "Rash"],
        "howToUse": "Take as directed. Dosage: 250mg - 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cleocin": {
        "brandName": "Cleocin", "genericName": "Clindamycin Hydrochloride", "manufacturer": "Pfizer",
        "dosage": "150mg - 450mg", "uses": ["MRSA infections", "Bacterial vaginosis", "Dental infections", "Anaerobic infections"],
        "sideEffects": ["C. diff colitis", "Diarrhea", "Nausea"],
        "howToUse": "Take as directed. Dosage: 150mg - 450mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "flagyl": {
        "brandName": "Flagyl", "genericName": "Metronidazole", "manufacturer": "Pfizer",
        "dosage": "250mg - 500mg", "uses": ["Bacterial vaginosis", "C. difficile", "Trichomoniasis", "H. pylori"],
        "sideEffects": ["Metallic taste", "Nausea", "Peripheral neuropathy"],
        "howToUse": "Take as directed. Dosage: 250mg - 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "macrobid": {
        "brandName": "Macrobid", "genericName": "Nitrofurantoin", "manufacturer": "Almatica Pharma",
        "dosage": "50mg - 100mg", "uses": ["UTI", "Uncomplicated cystitis", "UTI prophylaxis"],
        "sideEffects": ["Nausea", "Pulmonary toxicity"],
        "howToUse": "Take as directed. Dosage: 50mg - 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "tegretol": {
        "brandName": "Tegretol", "genericName": "Carbamazepine", "manufacturer": "Novartis",
        "dosage": "100mg - 1200mg", "uses": ["Epilepsy", "Trigeminal neuralgia", "Bipolar disorder"],
        "sideEffects": ["Hyponatremia", "Dizziness", "Stevens-Johnson syndrome"],
        "howToUse": "Take as directed. Dosage: 100mg - 1200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "depakote": {
        "brandName": "Depakote", "genericName": "Divalproex Sodium", "manufacturer": "AbbVie",
        "dosage": "250mg - 1500mg", "uses": ["Epilepsy", "Bipolar disorder", "Migraine prophylaxis"],
        "sideEffects": ["Weight gain", "Hair loss", "Hepatotoxicity", "Teratogenicity"],
        "howToUse": "Take as directed. Dosage: 250mg - 1500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lithobid": {
        "brandName": "Lithobid", "genericName": "Lithium Carbonate", "manufacturer": "Various",
        "dosage": "150mg - 1800mg", "uses": ["Bipolar disorder", "Mania", "Bipolar depression"],
        "sideEffects": ["Tremor", "Polyuria", "Weight gain", "Hypothyroidism"],
        "howToUse": "Take as directed. Dosage: 150mg - 1800mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lamictal": {
        "brandName": "Lamictal", "genericName": "Lamotrigine", "manufacturer": "GSK",
        "dosage": "25mg - 400mg", "uses": ["Epilepsy", "Bipolar disorder"],
        "sideEffects": ["Rash", "Stevens-Johnson syndrome", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 25mg - 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "viagra": {
        "brandName": "Viagra", "genericName": "Sildenafil Citrate", "manufacturer": "Pfizer",
        "dosage": "25mg - 100mg", "uses": ["Erectile dysfunction", "Pulmonary arterial hypertension"],
        "sideEffects": ["Headache", "Flushing", "Visual changes", "Hypotension"],
        "howToUse": "Take as directed. Dosage: 25mg - 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cialis": {
        "brandName": "Cialis", "genericName": "Tadalafil", "manufacturer": "Eli Lilly",
        "dosage": "2.5mg - 20mg", "uses": ["Erectile dysfunction", "BPH", "Pulmonary arterial hypertension"],
        "sideEffects": ["Headache", "Back pain", "Muscle aches"],
        "howToUse": "Take as directed. Dosage: 2.5mg - 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "humira": {
        "brandName": "Humira", "genericName": "Adalimumab", "manufacturer": "AbbVie",
        "dosage": "40mg every 2 weeks", "uses": ["Rheumatoid arthritis", "Psoriasis", "Crohn's disease", "Ulcerative colitis"],
        "sideEffects": ["Serious infections", "Injection site reactions", "Lymphoma risk"],
        "howToUse": "Take as directed. Dosage: 40mg every 2 weeks", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "plaquenil": {
        "brandName": "Plaquenil", "genericName": "Hydroxychloroquine Sulfate", "manufacturer": "Sanofi",
        "dosage": "200mg - 400mg", "uses": ["SLE Lupus", "Rheumatoid arthritis", "Malaria prevention"],
        "sideEffects": ["Retinopathy", "Nausea", "GI upset", "QT prolongation"],
        "howToUse": "Take as directed. Dosage: 200mg - 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "methotrexate": {
        "brandName": "Methotrexate", "genericName": "Methotrexate", "manufacturer": "Pfizer",
        "dosage": "7.5mg - 25mg weekly", "uses": ["Rheumatoid arthritis", "Psoriasis", "Ectopic pregnancy", "Leukemia"],
        "sideEffects": ["Hepatotoxicity", "Mucositis", "Myelosuppression", "Teratogenicity"],
        "howToUse": "Take as directed. Dosage: 7.5mg - 25mg weekly", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "vitamin d3": {
        "brandName": "Vitamin D3", "genericName": "Cholecalciferol", "manufacturer": "Various",
        "dosage": "400IU - 5000IU", "uses": ["Vitamin D deficiency", "Rickets", "Osteoporosis", "Immune support"],
        "sideEffects": ["Hypercalcemia in overdose", "Kidney stones"],
        "howToUse": "Take as directed. Dosage: 400IU - 5000IU", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "folic acid": {
        "brandName": "Folic Acid", "genericName": "Folic Acid", "manufacturer": "Various",
        "dosage": "0.4mg - 5mg", "uses": ["Folate deficiency", "Neural tube defect prevention", "Megaloblastic anemia"],
        "sideEffects": ["Masking B12 deficiency"],
        "howToUse": "Take as directed. Dosage: 0.4mg - 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ferrous sulfate": {
        "brandName": "Ferrous Sulfate", "genericName": "Iron Supplement", "manufacturer": "Various",
        "dosage": "325mg", "uses": ["Iron deficiency anemia", "Iron supplementation in pregnancy"],
        "sideEffects": ["Constipation", "Dark stools", "Nausea"],
        "howToUse": "Take as directed. Dosage: 325mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "dolo 650": {
        "brandName": "Dolo 650", "genericName": "Paracetamol", "manufacturer": "Micro Labs Ltd",
        "dosage": "650mg", "uses": ["Fever", "Body pain", "Headache", "Dental pain"],
        "sideEffects": ["Nausea", "Liver damage in overdose"],
        "howToUse": "Take as directed. Dosage: 650mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "crocin 650": {
        "brandName": "Crocin 650", "genericName": "Paracetamol", "manufacturer": "GSK Consumer Healthcare",
        "dosage": "650mg", "uses": ["Fever", "Headache", "Body ache", "Toothache"],
        "sideEffects": ["Nausea", "Rash"],
        "howToUse": "Take as directed. Dosage: 650mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "crocin 500": {
        "brandName": "Crocin 500", "genericName": "Paracetamol", "manufacturer": "GSK Consumer Healthcare",
        "dosage": "500mg", "uses": ["Fever", "Mild pain", "Headache"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "calpol 650": {
        "brandName": "Calpol 650", "genericName": "Paracetamol", "manufacturer": "GSK Consumer Healthcare",
        "dosage": "650mg", "uses": ["Fever", "Pain"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 650mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "paracip 500": {
        "brandName": "Paracip 500", "genericName": "Paracetamol", "manufacturer": "Cipla Ltd",
        "dosage": "500mg", "uses": ["Fever", "Pain"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "pacimol 650": {
        "brandName": "Pacimol 650", "genericName": "Paracetamol", "manufacturer": "IPCA Laboratories",
        "dosage": "650mg", "uses": ["Fever", "Headache", "Body ache"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 650mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "p-500": {
        "brandName": "P-500", "genericName": "Paracetamol", "manufacturer": "Mankind Pharma",
        "dosage": "500mg", "uses": ["Fever", "Mild pain"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "brufen 400": {
        "brandName": "Brufen 400", "genericName": "Ibuprofen", "manufacturer": "Abbott India",
        "dosage": "400mg", "uses": ["Pain", "Inflammation", "Fever", "Arthritis"],
        "sideEffects": ["Stomach upset", "Nausea", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ibugesic 400": {
        "brandName": "Ibugesic 400", "genericName": "Ibuprofen", "manufacturer": "Cipla Ltd",
        "dosage": "400mg", "uses": ["Pain", "Fever", "Inflammation"],
        "sideEffects": ["Acidity", "Nausea"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "combiflam": {
        "brandName": "Combiflam", "genericName": "Ibuprofen + Paracetamol", "manufacturer": "Sanofi India",
        "dosage": "400mg + 325mg", "uses": ["Fever", "Pain", "Headache", "Dysmenorrhea"],
        "sideEffects": ["Acidity", "Nausea", "Stomach upset"],
        "howToUse": "Take as directed. Dosage: 400mg + 325mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "flexon": {
        "brandName": "Flexon", "genericName": "Ibuprofen + Paracetamol", "manufacturer": "Aristo Pharmaceuticals",
        "dosage": "400mg + 500mg", "uses": ["Pain", "Fever", "Muscular pain"],
        "sideEffects": ["Acidity", "Nausea"],
        "howToUse": "Take as directed. Dosage: 400mg + 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zerodol sp": {
        "brandName": "Zerodol SP", "genericName": "Aceclofenac + Paracetamol + Serratiopeptidase", "manufacturer": "IPCA Laboratories",
        "dosage": "100mg + 325mg + 15mg", "uses": ["Pain", "Inflammation", "Post-surgical swelling", "Arthritis"],
        "sideEffects": ["Stomach upset", "Nausea"],
        "howToUse": "Take as directed. Dosage: 100mg + 325mg + 15mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "hifenac sp": {
        "brandName": "Hifenac SP", "genericName": "Aceclofenac + Paracetamol + Serratiopeptidase", "manufacturer": "Intas Pharmaceuticals",
        "dosage": "100mg + 325mg + 15mg", "uses": ["Pain", "Inflammation", "Arthritis"],
        "sideEffects": ["Stomach upset"],
        "howToUse": "Take as directed. Dosage: 100mg + 325mg + 15mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "voveran sr 100": {
        "brandName": "Voveran SR 100", "genericName": "Diclofenac Sodium", "manufacturer": "Novartis India",
        "dosage": "100mg SR", "uses": ["Pain", "Inflammation", "Arthritis", "Dysmenorrhea"],
        "sideEffects": ["Acidity", "Nausea", "GI bleeding"],
        "howToUse": "Take as directed. Dosage: 100mg SR", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "nise 100": {
        "brandName": "Nise 100", "genericName": "Nimesulide", "manufacturer": "Dr. Reddy's Laboratories",
        "dosage": "100mg", "uses": ["Pain", "Fever", "Inflammation"],
        "sideEffects": ["Liver toxicity", "Stomach upset"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "nimulid 100": {
        "brandName": "Nimulid 100", "genericName": "Nimesulide", "manufacturer": "Panacea Biotec",
        "dosage": "100mg", "uses": ["Fever", "Pain"],
        "sideEffects": ["Hepatotoxicity"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "nucoxia 60": {
        "brandName": "Nucoxia 60", "genericName": "Etoricoxib", "manufacturer": "Sun Pharma",
        "dosage": "60mg", "uses": ["Arthritis", "Pain", "Gout"],
        "sideEffects": ["Hypertension", "Edema", "GI upset"],
        "howToUse": "Take as directed. Dosage: 60mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "meftal-spas": {
        "brandName": "Meftal-Spas", "genericName": "Mefenamic Acid + Dicyclomine", "manufacturer": "Blue Cross Laboratories",
        "dosage": "250mg + 10mg", "uses": ["Abdominal cramps", "Dysmenorrhea", "Colic pain", "IBS"],
        "sideEffects": ["Nausea", "Diarrhea", "GI upset"],
        "howToUse": "Take as directed. Dosage: 250mg + 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cyclopam": {
        "brandName": "Cyclopam", "genericName": "Dicyclomine + Paracetamol", "manufacturer": "Indoco Remedies",
        "dosage": "20mg + 500mg", "uses": ["Abdominal cramps", "IBS", "Colic", "Renal colic"],
        "sideEffects": ["Dry mouth", "Blurred vision", "Urinary retention"],
        "howToUse": "Take as directed. Dosage: 20mg + 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "azithral 500": {
        "brandName": "Azithral 500", "genericName": "Azithromycin", "manufacturer": "Alembic Pharmaceuticals",
        "dosage": "500mg", "uses": ["Bacterial infections", "Respiratory infections", "Skin infections", "Community-acquired pneumonia"],
        "sideEffects": ["Diarrhea", "Nausea", "Abdominal pain"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "azee 500": {
        "brandName": "Azee 500", "genericName": "Azithromycin", "manufacturer": "Cipla Ltd",
        "dosage": "500mg", "uses": ["Bacterial infections", "Community-acquired pneumonia"],
        "sideEffects": ["Nausea", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zathrin 500": {
        "brandName": "Zathrin 500", "genericName": "Azithromycin", "manufacturer": "Sun Pharma",
        "dosage": "500mg", "uses": ["Bacterial infections"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "augmentin 625": {
        "brandName": "Augmentin 625", "genericName": "Amoxicillin + Clavulanic Acid", "manufacturer": "GSK India",
        "dosage": "625mg", "uses": ["Respiratory infections", "Sinusitis", "Ear infections", "Skin infections", "UTI"],
        "sideEffects": ["Diarrhea", "Nausea", "Rash"],
        "howToUse": "Take as directed. Dosage: 625mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "moxikind-cv 625": {
        "brandName": "Moxikind-CV 625", "genericName": "Amoxicillin + Clavulanic Acid", "manufacturer": "Mankind Pharma",
        "dosage": "625mg", "uses": ["Bacterial infections"],
        "sideEffects": ["Diarrhea", "Nausea"],
        "howToUse": "Take as directed. Dosage: 625mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zifi 200": {
        "brandName": "Zifi 200", "genericName": "Cefixime", "manufacturer": "FDC Limited",
        "dosage": "200mg", "uses": ["Bacterial infections", "UTI", "Ear infections", "Pharyngitis"],
        "sideEffects": ["Diarrhea", "Nausea", "Rash"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "taxim-o 200": {
        "brandName": "Taxim-O 200", "genericName": "Cefixime", "manufacturer": "Alkem Laboratories",
        "dosage": "200mg", "uses": ["Bacterial infections"],
        "sideEffects": ["Diarrhea"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "monocef 1g": {
        "brandName": "Monocef 1g", "genericName": "Ceftriaxone", "manufacturer": "Aristo Pharmaceuticals",
        "dosage": "1g injection", "uses": ["Severe bacterial infections", "Meningitis", "Pneumonia", "Typhoid"],
        "sideEffects": ["Injection site pain", "Diarrhea", "Rash"],
        "howToUse": "Take as directed. Dosage: 1g injection", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ceftum 500": {
        "brandName": "Ceftum 500", "genericName": "Cefuroxime", "manufacturer": "GSK India",
        "dosage": "500mg", "uses": ["Respiratory infections", "UTI", "Skin infections"],
        "sideEffects": ["Diarrhea", "Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ciplox 500": {
        "brandName": "Ciplox 500", "genericName": "Ciprofloxacin", "manufacturer": "Cipla Ltd",
        "dosage": "500mg", "uses": ["Bacterial infections", "UTI", "Typhoid", "GI infections"],
        "sideEffects": ["Nausea", "Dizziness", "Headache"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cifran 500": {
        "brandName": "Cifran 500", "genericName": "Ciprofloxacin", "manufacturer": "Sun Pharma",
        "dosage": "500mg", "uses": ["Bacterial infections", "UTI"],
        "sideEffects": ["Dizziness", "Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "levoflox 500": {
        "brandName": "Levoflox 500", "genericName": "Levofloxacin", "manufacturer": "Sun Pharma",
        "dosage": "500mg", "uses": ["Pneumonia", "Sinusitis", "UTI", "Skin infections"],
        "sideEffects": ["Nausea", "Diarrhea", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "doxy-1 l-dr": {
        "brandName": "Doxy-1 L-DR", "genericName": "Doxycycline", "manufacturer": "USV Ltd",
        "dosage": "100mg", "uses": ["Bacterial infections", "Acne", "Malaria prophylaxis"],
        "sideEffects": ["Photosensitivity", "Nausea", "Esophageal irritation"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "metrogyl 400": {
        "brandName": "Metrogyl 400", "genericName": "Metronidazole", "manufacturer": "J.B. Chemicals",
        "dosage": "400mg", "uses": ["Amoebic dysentery", "Bacterial vaginosis", "H. pylori eradication", "Anaerobic infections"],
        "sideEffects": ["Metallic taste", "Nausea", "Headache", "Dark urine"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "oflox oz": {
        "brandName": "Oflox OZ", "genericName": "Ofloxacin + Ornidazole", "manufacturer": "Cipla Ltd",
        "dosage": "200mg + 500mg", "uses": ["GI infections", "Diarrhea", "Giardiasis", "Amoebiasis"],
        "sideEffects": ["Nausea", "Metallic taste", "Headache"],
        "howToUse": "Take as directed. Dosage: 200mg + 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "o2 tablet": {
        "brandName": "O2 Tablet", "genericName": "Ofloxacin + Ornidazole", "manufacturer": "Macleods Pharmaceuticals",
        "dosage": "200mg + 500mg", "uses": ["GI infections"],
        "sideEffects": ["Nausea"],
        "howToUse": "Take as directed. Dosage: 200mg + 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "norflox 400": {
        "brandName": "Norflox 400", "genericName": "Norfloxacin", "manufacturer": "Cipla Ltd",
        "dosage": "400mg", "uses": ["UTI", "Gastroenteritis", "Traveler's diarrhea"],
        "sideEffects": ["Nausea", "Headache", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "omez 20": {
        "brandName": "Omez 20", "genericName": "Omeprazole", "manufacturer": "Dr. Reddy's Laboratories",
        "dosage": "20mg", "uses": ["Acidity", "GERD", "Peptic ulcer", "H. pylori"],
        "sideEffects": ["Headache", "Nausea", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "pan 40": {
        "brandName": "Pan 40", "genericName": "Pantoprazole", "manufacturer": "Alkem Laboratories",
        "dosage": "40mg", "uses": ["GERD", "Peptic ulcer", "Acidity", "Zollinger-Ellison syndrome"],
        "sideEffects": ["Headache", "Diarrhea", "Nausea"],
        "howToUse": "Take as directed. Dosage: 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "pantocid 40": {
        "brandName": "Pantocid 40", "genericName": "Pantoprazole", "manufacturer": "Sun Pharma",
        "dosage": "40mg", "uses": ["GERD", "Ulcers", "Acidity"],
        "sideEffects": ["Headache", "Nausea"],
        "howToUse": "Take as directed. Dosage: 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "razo 20": {
        "brandName": "Razo 20", "genericName": "Rabeprazole Sodium", "manufacturer": "Dr. Reddy's Laboratories",
        "dosage": "20mg", "uses": ["GERD", "Peptic ulcer", "Acidity"],
        "sideEffects": ["Headache", "Nausea", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "rantac 150": {
        "brandName": "Rantac 150", "genericName": "Ranitidine", "manufacturer": "J.B. Chemicals",
        "dosage": "150mg", "uses": ["Peptic ulcer", "GERD", "Heartburn", "Hyperacidity"],
        "sideEffects": ["Headache", "Dizziness", "Constipation"],
        "howToUse": "Take as directed. Dosage: 150mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "mucaine gel": {
        "brandName": "Mucaine Gel", "genericName": "Aluminium Hydroxide + Magnesium Hydroxide + Oxethazaine", "manufacturer": "Pfizer India",
        "dosage": "5ml suspension", "uses": ["GERD", "Heartburn", "Peptic ulcer pain", "Acidity"],
        "sideEffects": ["Constipation", "Diarrhea", "Nausea"],
        "howToUse": "Take as directed. Dosage: 5ml suspension", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "digene": {
        "brandName": "Digene", "genericName": "Magaldrate + Simethicone", "manufacturer": "Abbott India",
        "dosage": "Chewable tablet", "uses": ["Acidity", "Gas", "Indigestion", "Bloating"],
        "sideEffects": ["Constipation"],
        "howToUse": "Take as directed. Dosage: Chewable tablet", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "gelusil": {
        "brandName": "Gelusil", "genericName": "Aluminium Hydroxide + Magnesium Hydroxide + Simethicone", "manufacturer": "Pfizer India",
        "dosage": "Chewable tablet", "uses": ["Acidity", "Gas", "Heartburn"],
        "sideEffects": ["Constipation", "Chalky taste"],
        "howToUse": "Take as directed. Dosage: Chewable tablet", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "eno fruit salt": {
        "brandName": "ENO Fruit Salt", "genericName": "Sodium Bicarbonate + Citric Acid", "manufacturer": "GSK Consumer Healthcare",
        "dosage": "Sachet 5g", "uses": ["Acidity", "Heartburn", "Indigestion", "Bloating"],
        "sideEffects": ["Belching", "Sodium load with frequent use"],
        "howToUse": "Take as directed. Dosage: Sachet 5g", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "domstal 10": {
        "brandName": "Domstal 10", "genericName": "Domperidone", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "10mg", "uses": ["Nausea", "Vomiting", "Gastric stasis", "Bloating"],
        "sideEffects": ["Dry mouth", "Headache", "Galactorrhea (rare)"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "perinorm": {
        "brandName": "Perinorm", "genericName": "Metoclopramide", "manufacturer": "Neon Laboratories",
        "dosage": "10mg", "uses": ["Nausea", "Vomiting", "Gastroparesis", "Hiccups"],
        "sideEffects": ["Drowsiness", "Restlessness", "Tardive dyskinesia (long-term)"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "emeset 4": {
        "brandName": "Emeset 4", "genericName": "Ondansetron", "manufacturer": "Cipla Ltd",
        "dosage": "4mg", "uses": ["Nausea", "Vomiting", "Chemotherapy-induced nausea", "Post-operative nausea"],
        "sideEffects": ["Headache", "Constipation", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 4mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ecosprin 75": {
        "brandName": "Ecosprin 75", "genericName": "Aspirin", "manufacturer": "USV Ltd",
        "dosage": "75mg", "uses": ["Cardiovascular disease prevention", "Post-heart attack", "Post-stroke"],
        "sideEffects": ["Gastric irritation", "GI bleeding"],
        "howToUse": "Take as directed. Dosage: 75mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "clopivas 75": {
        "brandName": "Clopivas 75", "genericName": "Clopidogrel", "manufacturer": "Sun Pharma",
        "dosage": "75mg", "uses": ["Prevention of heart attack", "Prevention of stroke", "ACS"],
        "sideEffects": ["Bleeding", "Bruising", "Stomach upset"],
        "howToUse": "Take as directed. Dosage: 75mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "deplatt a 75": {
        "brandName": "Deplatt A 75", "genericName": "Aspirin + Clopidogrel", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "75mg + 75mg", "uses": ["ACS", "Post-angioplasty", "Stroke prevention", "CAD"],
        "sideEffects": ["Bleeding", "GI irritation", "Bruising"],
        "howToUse": "Take as directed. Dosage: 75mg + 75mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "glycomet 500": {
        "brandName": "Glycomet 500", "genericName": "Metformin Hydrochloride", "manufacturer": "USV Ltd",
        "dosage": "500mg", "uses": ["Type 2 diabetes", "Blood sugar control", "PCOS"],
        "sideEffects": ["Nausea", "Diarrhea", "Stomach upset", "Lactic acidosis (rare)"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "glyciphage 500": {
        "brandName": "Glyciphage 500", "genericName": "Metformin Hydrochloride", "manufacturer": "Franco-Indian Pharmaceuticals",
        "dosage": "500mg", "uses": ["Type 2 diabetes"],
        "sideEffects": ["GI upset", "Nausea"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "glycomet gp 2": {
        "brandName": "Glycomet GP 2", "genericName": "Glimepiride + Metformin", "manufacturer": "USV Ltd",
        "dosage": "2mg + 500mg", "uses": ["Type 2 diabetes", "Blood sugar control"],
        "sideEffects": ["Hypoglycemia", "Weight gain", "GI upset"],
        "howToUse": "Take as directed. Dosage: 2mg + 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "amaryl m 2": {
        "brandName": "Amaryl M 2", "genericName": "Glimepiride + Metformin", "manufacturer": "Sanofi India",
        "dosage": "2mg + 500mg", "uses": ["Type 2 diabetes", "Hyperglycemia"],
        "sideEffects": ["Hypoglycemia", "GI upset"],
        "howToUse": "Take as directed. Dosage: 2mg + 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "janumet 50/500": {
        "brandName": "Janumet 50/500", "genericName": "Sitagliptin + Metformin", "manufacturer": "MSD India",
        "dosage": "50mg/500mg", "uses": ["Type 2 diabetes"],
        "sideEffects": ["Nausea", "Headache", "Pancreatitis (rare)"],
        "howToUse": "Take as directed. Dosage: 50mg/500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "dapagliflozin 10": {
        "brandName": "Dapagliflozin 10", "genericName": "Dapagliflozin", "manufacturer": "AstraZeneca India",
        "dosage": "10mg", "uses": ["Type 2 diabetes", "Heart failure", "CKD"],
        "sideEffects": ["UTI", "Genital infections", "Increased urination"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "empagliflozin 10": {
        "brandName": "Empagliflozin 10", "genericName": "Empagliflozin", "manufacturer": "Boehringer Ingelheim India",
        "dosage": "10mg", "uses": ["Type 2 diabetes", "Heart failure", "CKD protection"],
        "sideEffects": ["UTI", "Genital infections", "Dehydration"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "atorva 10": {
        "brandName": "Atorva 10", "genericName": "Atorvastatin", "manufacturer": "Zydus Cadila",
        "dosage": "10mg", "uses": ["High cholesterol", "High LDL", "Cardiovascular prevention"],
        "sideEffects": ["Muscle pain", "Liver enzyme elevation", "Headache"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "storvas 10": {
        "brandName": "Storvas 10", "genericName": "Atorvastatin", "manufacturer": "Sun Pharma",
        "dosage": "10mg", "uses": ["High cholesterol", "Dyslipidemia"],
        "sideEffects": ["Myalgia", "Liver toxicity"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lipikind 10": {
        "brandName": "Lipikind 10", "genericName": "Atorvastatin", "manufacturer": "Mankind Pharma",
        "dosage": "10mg", "uses": ["High cholesterol", "LDL reduction"],
        "sideEffects": ["Muscle pain", "Rhabdomyolysis (rare)"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "rosuvas 10": {
        "brandName": "Rosuvas 10", "genericName": "Rosuvastatin", "manufacturer": "Sun Pharma",
        "dosage": "10mg", "uses": ["High cholesterol", "Atherosclerosis prevention"],
        "sideEffects": ["Muscle pain", "Headache", "Nausea"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "rozavel 10": {
        "brandName": "Rozavel 10", "genericName": "Rosuvastatin", "manufacturer": "Sun Pharma",
        "dosage": "10mg", "uses": ["Dyslipidemia", "High cholesterol"],
        "sideEffects": ["Myalgia"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "telma 40": {
        "brandName": "Telma 40", "genericName": "Telmisartan", "manufacturer": "Glenmark Pharmaceuticals",
        "dosage": "40mg", "uses": ["Hypertension", "Cardiovascular risk reduction"],
        "sideEffects": ["Dizziness", "Hyperkalaemia", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "telsar 40": {
        "brandName": "Telsar 40", "genericName": "Telmisartan", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "40mg", "uses": ["Hypertension"],
        "sideEffects": ["Dizziness"],
        "howToUse": "Take as directed. Dosage: 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "olmezest 20": {
        "brandName": "Olmezest 20", "genericName": "Olmesartan Medoxomil", "manufacturer": "Sun Pharma",
        "dosage": "20mg", "uses": ["Hypertension"],
        "sideEffects": ["Dizziness", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "losar 50": {
        "brandName": "Losar 50", "genericName": "Losartan Potassium", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "50mg", "uses": ["Hypertension", "Diabetic nephropathy", "Heart failure"],
        "sideEffects": ["Dizziness", "Hyperkalaemia"],
        "howToUse": "Take as directed. Dosage: 50mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "amlong 5": {
        "brandName": "Amlong 5", "genericName": "Amlodipine Besylate", "manufacturer": "Micro Labs Ltd",
        "dosage": "5mg", "uses": ["Hypertension", "Angina", "Coronary artery disease"],
        "sideEffects": ["Ankle swelling", "Headache", "Flushing"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "stamlo 5": {
        "brandName": "Stamlo 5", "genericName": "Amlodipine Besylate", "manufacturer": "Dr. Reddy's Laboratories",
        "dosage": "5mg", "uses": ["Hypertension", "Angina"],
        "sideEffects": ["Edema", "Flushing", "Headache"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "aten 50": {
        "brandName": "Aten 50", "genericName": "Atenolol", "manufacturer": "Zydus Cadila",
        "dosage": "50mg", "uses": ["Hypertension", "Angina", "Arrhythmia", "Post-MI"],
        "sideEffects": ["Fatigue", "Cold extremities", "Bradycardia"],
        "howToUse": "Take as directed. Dosage: 50mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "metolar 25": {
        "brandName": "Metolar 25", "genericName": "Metoprolol Succinate", "manufacturer": "Cipla Ltd",
        "dosage": "25mg", "uses": ["Hypertension", "Heart failure", "Angina", "Arrhythmia"],
        "sideEffects": ["Fatigue", "Dizziness", "Bradycardia"],
        "howToUse": "Take as directed. Dosage: 25mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cardivas 3.125": {
        "brandName": "Cardivas 3.125", "genericName": "Carvedilol", "manufacturer": "Sun Pharma",
        "dosage": "3.125mg", "uses": ["Heart failure", "Hypertension", "Post-MI LV dysfunction"],
        "sideEffects": ["Dizziness", "Fatigue", "Hypotension"],
        "howToUse": "Take as directed. Dosage: 3.125mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ramipril 2.5": {
        "brandName": "Ramipril 2.5", "genericName": "Ramipril", "manufacturer": "Various",
        "dosage": "2.5mg", "uses": ["Hypertension", "Heart failure", "Diabetic nephropathy"],
        "sideEffects": ["Dry cough", "Hyperkalemia", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 2.5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "thyronorm 50": {
        "brandName": "Thyronorm 50", "genericName": "Levothyroxine Sodium", "manufacturer": "Abbott India",
        "dosage": "50mcg", "uses": ["Hypothyroidism", "Thyroid hormone replacement", "Goiter"],
        "sideEffects": ["Palpitations in overdose", "Tremor", "Insomnia"],
        "howToUse": "Take as directed. Dosage: 50mcg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "eltroxin 50": {
        "brandName": "Eltroxin 50", "genericName": "Levothyroxine Sodium", "manufacturer": "GSK India",
        "dosage": "50mcg", "uses": ["Hypothyroidism"],
        "sideEffects": ["Palpitations", "Tachycardia in overdose"],
        "howToUse": "Take as directed. Dosage: 50mcg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "nulong 10": {
        "brandName": "Nulong 10", "genericName": "Cilnidipine", "manufacturer": "Mankind Pharma",
        "dosage": "10mg", "uses": ["Hypertension", "Angina"],
        "sideEffects": ["Headache", "Dizziness", "Flushing", "Ankle swelling"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "allegra 120": {
        "brandName": "Allegra 120", "genericName": "Fexofenadine Hydrochloride", "manufacturer": "Sanofi India",
        "dosage": "120mg", "uses": ["Allergic rhinitis", "Urticaria", "Hay fever"],
        "sideEffects": ["Headache", "Nausea", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 120mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "okacet 10": {
        "brandName": "Okacet 10", "genericName": "Cetirizine Hydrochloride", "manufacturer": "Cipla Ltd",
        "dosage": "10mg", "uses": ["Allergic rhinitis", "Urticaria", "Skin allergies"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Headache"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "levocet 5": {
        "brandName": "Levocet 5", "genericName": "Levocetirizine Dihydrochloride", "manufacturer": "Sun Pharma",
        "dosage": "5mg", "uses": ["Allergic rhinitis", "Chronic urticaria", "Atopic dermatitis"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Fatigue"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "montair lc": {
        "brandName": "Montair LC", "genericName": "Montelukast + Levocetirizine", "manufacturer": "Cipla Ltd",
        "dosage": "10mg + 5mg", "uses": ["Allergic rhinitis", "Urticaria", "Asthma with allergy"],
        "sideEffects": ["Drowsiness", "Headache", "Stomach upset"],
        "howToUse": "Take as directed. Dosage: 10mg + 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "montair 10": {
        "brandName": "Montair 10", "genericName": "Montelukast Sodium", "manufacturer": "Cipla Ltd",
        "dosage": "10mg", "uses": ["Asthma prevention", "Allergic rhinitis", "Exercise-induced bronchospasm"],
        "sideEffects": ["Headache", "GI upset", "Mood changes"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ascoril ls": {
        "brandName": "Ascoril LS", "genericName": "Levosalbutamol + Ambroxol + Guaifenesin", "manufacturer": "Glenmark Pharmaceuticals",
        "dosage": "Syrup", "uses": ["Productive cough", "Bronchitis", "COPD"],
        "sideEffects": ["Palpitations", "Tremor", "Nausea"],
        "howToUse": "Take as directed. Dosage: Syrup", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "benadryl cough syrup": {
        "brandName": "Benadryl Cough Syrup", "genericName": "Diphenhydramine + Ammonium Chloride", "manufacturer": "Johnson & Johnson India",
        "dosage": "Syrup", "uses": ["Dry cough", "Allergic cough", "Cold symptoms"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Dizziness"],
        "howToUse": "Take as directed. Dosage: Syrup", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "sinarest nf": {
        "brandName": "Sinarest NF", "genericName": "Paracetamol + Pseudoephedrine + Chlorpheniramine", "manufacturer": "Centaur Pharmaceuticals",
        "dosage": "Tablet", "uses": ["Common cold", "Sinusitis", "Nasal congestion", "Sneezing"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Increased BP"],
        "howToUse": "Take as directed. Dosage: Tablet", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cheston cold": {
        "brandName": "Cheston Cold", "genericName": "Paracetamol + Phenylephrine + Cetirizine", "manufacturer": "Cipla Ltd",
        "dosage": "Tablet", "uses": ["Cold", "Runny nose", "Fever", "Sneezing"],
        "sideEffects": ["Drowsiness", "Dry mouth", "Nausea"],
        "howToUse": "Take as directed. Dosage: Tablet", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "asthalin 100 inhaler": {
        "brandName": "Asthalin 100 Inhaler", "genericName": "Salbutamol Sulphate", "manufacturer": "Cipla Ltd",
        "dosage": "100mcg/puff", "uses": ["Asthma", "COPD", "Bronchospasm", "Exercise-induced asthma"],
        "sideEffects": ["Tremor", "Palpitations", "Tachycardia"],
        "howToUse": "Take as directed. Dosage: 100mcg/puff", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "duolin inhaler": {
        "brandName": "Duolin Inhaler", "genericName": "Levosalbutamol + Ipratropium", "manufacturer": "Cipla Ltd",
        "dosage": "Inhaler", "uses": ["COPD", "Asthma", "Bronchospasm"],
        "sideEffects": ["Tremor", "Dry mouth", "Headache"],
        "howToUse": "Take as directed. Dosage: Inhaler", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "foracort 200": {
        "brandName": "Foracort 200", "genericName": "Formoterol + Budesonide", "manufacturer": "Cipla Ltd",
        "dosage": "200mcg + 6mcg per puff", "uses": ["Asthma maintenance", "COPD", "Severe asthma prevention"],
        "sideEffects": ["Oral candidiasis", "Hoarseness", "Palpitations"],
        "howToUse": "Take as directed. Dosage: 200mcg + 6mcg per puff", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "seroflo 250 inhaler": {
        "brandName": "Seroflo 250 Inhaler", "genericName": "Fluticasone + Salmeterol", "manufacturer": "Cipla Ltd",
        "dosage": "250mcg + 50mcg per puff", "uses": ["Asthma", "COPD", "Prevention of bronchospasm"],
        "sideEffects": ["Oral candidiasis", "Throat irritation", "Headache"],
        "howToUse": "Take as directed. Dosage: 250mcg + 50mcg per puff", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "deriphyllin retard 150": {
        "brandName": "Deriphyllin Retard 150", "genericName": "Etofylline + Theophylline", "manufacturer": "Piramal Healthcare",
        "dosage": "150mg", "uses": ["Asthma", "COPD", "Bronchitis"],
        "sideEffects": ["Nausea", "Headache", "Palpitations"],
        "howToUse": "Take as directed. Dosage: 150mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "prednisolone 5": {
        "brandName": "Prednisolone 5", "genericName": "Prednisolone", "manufacturer": "Pfizer India",
        "dosage": "5mg", "uses": ["Inflammation", "Severe allergies", "Asthma", "Autoimmune conditions", "Arthritis"],
        "sideEffects": ["Weight gain", "Moon face", "High blood sugar", "Osteoporosis"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "medrol 4": {
        "brandName": "Medrol 4", "genericName": "Methylprednisolone", "manufacturer": "Pfizer India",
        "dosage": "4mg", "uses": ["Inflammation", "Allergic reactions", "Autoimmune diseases"],
        "sideEffects": ["Weight gain", "Hyperglycemia", "Hypertension", "Osteoporosis"],
        "howToUse": "Take as directed. Dosage: 4mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "hcqs 200": {
        "brandName": "HCQS 200", "genericName": "Hydroxychloroquine Sulphate", "manufacturer": "IPCA Laboratories",
        "dosage": "200mg", "uses": ["Rheumatoid arthritis", "SLE (Lupus)", "Malaria treatment and prevention"],
        "sideEffects": ["Retinopathy (long-term)", "GI upset", "Skin rash", "QT prolongation"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lariago 250": {
        "brandName": "Lariago 250", "genericName": "Chloroquine Phosphate", "manufacturer": "IPCA Laboratories",
        "dosage": "250mg", "uses": ["Malaria treatment", "Malaria prophylaxis", "Rheumatoid arthritis"],
        "sideEffects": ["Retinopathy", "Nausea", "Pruritus"],
        "howToUse": "Take as directed. Dosage: 250mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "shelcal 500": {
        "brandName": "Shelcal 500", "genericName": "Calcium Carbonate + Vitamin D3", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "500mg elemental Ca + 250IU D3", "uses": ["Calcium deficiency", "Osteoporosis", "Post-menopausal bone health", "Rickets"],
        "sideEffects": ["Constipation", "Bloating", "Kidney stones (rare)"],
        "howToUse": "Take as directed. Dosage: 500mg elemental Ca + 250IU D3", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "calcimax 500": {
        "brandName": "Calcimax 500", "genericName": "Calcium Carbonate + Vitamin D3 + Zinc", "manufacturer": "Elder Pharmaceuticals",
        "dosage": "500mg", "uses": ["Calcium deficiency", "Bone health", "Osteoporosis"],
        "sideEffects": ["Constipation", "GI upset"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "uprise d3 60k": {
        "brandName": "Uprise D3 60K", "genericName": "Cholecalciferol (Vitamin D3)", "manufacturer": "Sun Pharma",
        "dosage": "60000 IU weekly", "uses": ["Vitamin D deficiency", "Bone health", "Immune support"],
        "sideEffects": ["Hypercalcemia (overdose)", "Nausea (rare)"],
        "howToUse": "Take as directed. Dosage: 60000 IU weekly", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "neurobion forte": {
        "brandName": "Neurobion Forte", "genericName": "Vitamin B1 + B6 + B12 Complex", "manufacturer": "P&G Health",
        "dosage": "Tablet", "uses": ["Vitamin B deficiency", "Peripheral neuropathy", "Nerve regeneration"],
        "sideEffects": ["Very rare"],
        "howToUse": "Take as directed. Dosage: Tablet", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "becosules": {
        "brandName": "Becosules", "genericName": "Vitamin B Complex + Vitamin C", "manufacturer": "Pfizer India",
        "dosage": "Capsule", "uses": ["Vitamin B deficiency", "Mouth ulcers", "Skin health", "Energy"],
        "sideEffects": ["Yellow urine (harmless)", "Nausea (rare)"],
        "howToUse": "Take as directed. Dosage: Capsule", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "revital h": {
        "brandName": "Revital H", "genericName": "Multivitamin + Minerals + Ginseng", "manufacturer": "Sun Pharma",
        "dosage": "Capsule", "uses": ["General weakness", "Physical fatigue", "Mental fatigue", "Nutritional supplement"],
        "sideEffects": ["Nausea", "Stomach upset (rare)"],
        "howToUse": "Take as directed. Dosage: Capsule", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "supradyn": {
        "brandName": "Supradyn", "genericName": "Multivitamin + Multimineral", "manufacturer": "Bayer Zydus",
        "dosage": "Tablet", "uses": ["Vitamin and mineral deficiency", "General weakness", "Stress"],
        "sideEffects": ["Yellow urine", "Nausea (rare)"],
        "howToUse": "Take as directed. Dosage: Tablet", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "limcee 500": {
        "brandName": "Limcee 500", "genericName": "Ascorbic Acid (Vitamin C)", "manufacturer": "Abbott India",
        "dosage": "500mg chewable", "uses": ["Vitamin C deficiency", "Immunity booster", "Antioxidant", "Wound healing"],
        "sideEffects": ["Kidney stones (high doses)", "Stomach upset"],
        "howToUse": "Take as directed. Dosage: 500mg chewable", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "methycobal 500": {
        "brandName": "Methycobal 500", "genericName": "Methylcobalamin (Vitamin B12)", "manufacturer": "Eisai Pharma",
        "dosage": "500mcg", "uses": ["Vitamin B12 deficiency", "Peripheral neuropathy", "Diabetic neuropathy", "Megaloblastic anemia"],
        "sideEffects": ["Nausea (rare)", "Headache"],
        "howToUse": "Take as directed. Dosage: 500mcg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "duphaston 10": {
        "brandName": "Duphaston 10", "genericName": "Dydrogesterone", "manufacturer": "Abbott India",
        "dosage": "10mg", "uses": ["Irregular periods", "Endometriosis", "Threatened abortion", "Progesterone deficiency"],
        "sideEffects": ["Nausea", "Breakthrough bleeding", "Headache"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "susten 200": {
        "brandName": "Susten 200", "genericName": "Progesterone (Micronized)", "manufacturer": "Sun Pharma",
        "dosage": "200mg", "uses": ["Luteal phase support", "IVF support", "Threatened miscarriage", "Endometriosis"],
        "sideEffects": ["Dizziness", "Drowsiness", "Breakthrough bleeding"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "regestrone 5": {
        "brandName": "Regestrone 5", "genericName": "Norethisterone", "manufacturer": "Novartis India",
        "dosage": "5mg", "uses": ["Postponing periods", "Endometriosis", "Menorrhagia", "HRT"],
        "sideEffects": ["Nausea", "Breast tenderness", "Acne"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "gabantin 100": {
        "brandName": "Gabantin 100", "genericName": "Gabapentin", "manufacturer": "Sun Pharma",
        "dosage": "100mg", "uses": ["Neuropathic pain", "Epilepsy", "Post-herpetic neuralgia", "Diabetic neuropathy"],
        "sideEffects": ["Dizziness", "Somnolence", "Ataxia", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "pregabalin 75": {
        "brandName": "Pregabalin 75", "genericName": "Pregabalin", "manufacturer": "Sun Pharma",
        "dosage": "75mg", "uses": ["Neuropathic pain", "Fibromyalgia", "Diabetic neuropathy", "Epilepsy"],
        "sideEffects": ["Dizziness", "Somnolence", "Weight gain", "Blurred vision"],
        "howToUse": "Take as directed. Dosage: 75mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "eptoin 100": {
        "brandName": "Eptoin 100", "genericName": "Phenytoin Sodium", "manufacturer": "Abbott India",
        "dosage": "100mg", "uses": ["Epilepsy", "Seizures", "Status epilepticus", "Trigeminal neuralgia"],
        "sideEffects": ["Drowsiness", "Nystagmus", "Gingival hyperplasia"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "tegrital 200": {
        "brandName": "Tegrital 200", "genericName": "Carbamazepine", "manufacturer": "Novartis India",
        "dosage": "200mg", "uses": ["Epilepsy", "Trigeminal neuralgia", "Bipolar disorder"],
        "sideEffects": ["Dizziness", "Drowsiness", "Hyponatremia"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "valparin 200": {
        "brandName": "Valparin 200", "genericName": "Valproic Acid / Sodium Valproate", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "200mg", "uses": ["Epilepsy", "Bipolar disorder", "Migraine prophylaxis"],
        "sideEffects": ["Nausea", "Weight gain", "Hair loss", "Liver toxicity"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "alprax 0.25": {
        "brandName": "Alprax 0.25", "genericName": "Alprazolam", "manufacturer": "Torrent Pharmaceuticals",
        "dosage": "0.25mg", "uses": ["Anxiety disorder", "Panic attacks", "Insomnia"],
        "sideEffects": ["Drowsiness", "Dependence", "Amnesia"],
        "howToUse": "Take as directed. Dosage: 0.25mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lonazep 0.5": {
        "brandName": "Lonazep 0.5", "genericName": "Clonazepam", "manufacturer": "Sun Pharma",
        "dosage": "0.5mg", "uses": ["Epilepsy", "Anxiety", "Panic disorder"],
        "sideEffects": ["Drowsiness", "Dependence", "Memory impairment"],
        "howToUse": "Take as directed. Dosage: 0.5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "escitalopram 10": {
        "brandName": "Escitalopram 10", "genericName": "Escitalopram Oxalate", "manufacturer": "Sun Pharma",
        "dosage": "10mg", "uses": ["Depression", "Generalized anxiety disorder", "OCD", "Panic disorder"],
        "sideEffects": ["Nausea", "Headache", "Insomnia", "Sexual dysfunction"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "sertraline 50": {
        "brandName": "Sertraline 50", "genericName": "Sertraline Hydrochloride", "manufacturer": "Pfizer India",
        "dosage": "50mg", "uses": ["Depression", "OCD", "PTSD", "Panic disorder"],
        "sideEffects": ["Nausea", "Insomnia", "Headache", "Sexual dysfunction"],
        "howToUse": "Take as directed. Dosage: 50mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "fluoxetine 20": {
        "brandName": "Fluoxetine 20", "genericName": "Fluoxetine Hydrochloride", "manufacturer": "Cadila Healthcare",
        "dosage": "20mg", "uses": ["Depression", "Bulimia nervosa", "OCD", "Panic disorder"],
        "sideEffects": ["Nausea", "Insomnia", "Headache", "Agitation"],
        "howToUse": "Take as directed. Dosage: 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "dulane 20": {
        "brandName": "Dulane 20", "genericName": "Duloxetine Hydrochloride", "manufacturer": "Sun Pharma",
        "dosage": "20mg", "uses": ["Depression", "Diabetic neuropathic pain", "Fibromyalgia", "GAD"],
        "sideEffects": ["Nausea", "Dry mouth", "Constipation", "Insomnia"],
        "howToUse": "Take as directed. Dosage: 20mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "oleanz 5": {
        "brandName": "Oleanz 5", "genericName": "Olanzapine", "manufacturer": "Sun Pharma",
        "dosage": "5mg", "uses": ["Schizophrenia", "Bipolar disorder mania", "Agitation"],
        "sideEffects": ["Weight gain", "Sedation", "Hyperglycemia", "Metabolic syndrome"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "risdone 2": {
        "brandName": "Risdone 2", "genericName": "Risperidone", "manufacturer": "Sun Pharma",
        "dosage": "2mg", "uses": ["Schizophrenia", "Bipolar mania", "Autism-related irritability"],
        "sideEffects": ["EPS", "Tardive dyskinesia", "Hyperprolactinemia", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 2mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zandu nityam": {
        "brandName": "Zandu Nityam", "genericName": "Ayurvedic Herbal Laxative", "manufacturer": "Zandu Pharmaceutical Works",
        "dosage": "1-2 tablets", "uses": ["Constipation relief", "Bowel regularity", "Digestive health"],
        "sideEffects": ["Mild cramping", "Loose stools if overused"],
        "howToUse": "Take as directed. Dosage: 1-2 tablets", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "dulcolax 5": {
        "brandName": "Dulcolax 5", "genericName": "Bisacodyl", "manufacturer": "Sanofi India",
        "dosage": "5mg", "uses": ["Constipation", "Pre-procedure bowel preparation"],
        "sideEffects": ["Abdominal cramping", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "cremaffin plus": {
        "brandName": "Cremaffin Plus", "genericName": "Sodium Picosulfate + Liquid Paraffin + Milk of Magnesia", "manufacturer": "Abbott India",
        "dosage": "Syrup 15ml", "uses": ["Constipation", "Hard stools", "Post-op bowel management"],
        "sideEffects": ["Cramping", "Diarrhea"],
        "howToUse": "Take as directed. Dosage: Syrup 15ml", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "electral ors": {
        "brandName": "Electral ORS", "genericName": "Oral Rehydration Salts (WHO-ORS)", "manufacturer": "FDC Limited",
        "dosage": "Sachet in 200ml water", "uses": ["Dehydration", "Diarrhea", "Vomiting", "Heat exhaustion"],
        "sideEffects": ["Nausea if taken too fast"],
        "howToUse": "Take as directed. Dosage: Sachet in 200ml water", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "enterogermina": {
        "brandName": "Enterogermina", "genericName": "Bacillus clausii spores", "manufacturer": "Sanofi India",
        "dosage": "5ml oral suspension", "uses": ["Diarrhea", "Antibiotic-associated gut disturbance", "IBS", "Dysbiosis"],
        "sideEffects": ["Very rare"],
        "howToUse": "Take as directed. Dosage: 5ml oral suspension", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "strepsils": {
        "brandName": "Strepsils", "genericName": "Amylmetacresol + 2,4-Dichlorobenzyl Alcohol", "manufacturer": "Reckitt Benckiser India",
        "dosage": "Lozenge", "uses": ["Sore throat", "Mouth infections", "Throat irritation"],
        "sideEffects": ["Mild numbing", "Rare hypersensitivity"],
        "howToUse": "Take as directed. Dosage: Lozenge", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "volini spray": {
        "brandName": "Volini Spray", "genericName": "Diclofenac + Methyl Salicylate + Menthol", "manufacturer": "Sun Pharma",
        "dosage": "Gel/Spray", "uses": ["Muscle pain", "Joint pain", "Sprains", "Back pain", "Sports injuries"],
        "sideEffects": ["Skin irritation", "Burning sensation"],
        "howToUse": "Take as directed. Dosage: Gel/Spray", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "moov cream": {
        "brandName": "Moov Cream", "genericName": "Diclofenac + Methyl Salicylate + Menthol", "manufacturer": "Reckitt Benckiser India",
        "dosage": "Cream/Gel", "uses": ["Backache", "Muscle pain", "Arthritis pain", "Sprain"],
        "sideEffects": ["Skin redness", "Mild burning"],
        "howToUse": "Take as directed. Dosage: Cream/Gel", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "betadine solution": {
        "brandName": "Betadine Solution", "genericName": "Povidone Iodine", "manufacturer": "Win-Medicare Pvt Ltd",
        "dosage": "5% and 10% solution", "uses": ["Wound disinfection", "Pre-surgical skin prep", "Minor cuts", "Infection prevention"],
        "sideEffects": ["Skin irritation", "Allergic reaction (rare)"],
        "howToUse": "Take as directed. Dosage: 5% and 10% solution", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "soframycin cream": {
        "brandName": "Soframycin Cream", "genericName": "Framycetin Sulphate", "manufacturer": "Sanofi India",
        "dosage": "1% cream", "uses": ["Skin infections", "Burns", "Wounds", "Cuts", "Infected eczema"],
        "sideEffects": ["Skin sensitization", "Allergic contact dermatitis"],
        "howToUse": "Take as directed. Dosage: 1% cream", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "warf 2": {
        "brandName": "Warf 2", "genericName": "Warfarin Sodium", "manufacturer": "Cipla Ltd",
        "dosage": "2mg", "uses": ["Deep vein thrombosis", "Pulmonary embolism", "AF-related stroke prevention", "Mechanical heart valves"],
        "sideEffects": ["Bleeding", "Bruising", "Hair loss"],
        "howToUse": "Take as directed. Dosage: 2mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "xarelto 10": {
        "brandName": "Xarelto 10", "genericName": "Rivaroxaban", "manufacturer": "Bayer India",
        "dosage": "10mg", "uses": ["DVT prevention", "Pulmonary embolism", "AF-related stroke", "Hip/knee replacement"],
        "sideEffects": ["Bleeding", "Nausea", "Anemia"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "rifampicin 450": {
        "brandName": "Rifampicin 450", "genericName": "Rifampicin", "manufacturer": "Lupin Ltd",
        "dosage": "450mg", "uses": ["Tuberculosis (first-line)", "Leprosy", "Meningococcal prophylaxis"],
        "sideEffects": ["Orange-red urine/saliva/tears", "Hepatotoxicity", "Drug interactions"],
        "howToUse": "Take as directed. Dosage: 450mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "moxifloxacin 400": {
        "brandName": "Moxifloxacin 400", "genericName": "Moxifloxacin Hydrochloride", "manufacturer": "Bayer India",
        "dosage": "400mg", "uses": ["Community-acquired pneumonia", "Sinusitis", "Drug-resistant TB (adjunct)"],
        "sideEffects": ["QT prolongation", "Nausea", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "bosutris 100": {
        "brandName": "Bosutris 100", "genericName": "Bosutinib", "manufacturer": "Mylan Pharmaceuticals India",
        "dosage": "100mg", "uses": ["Chronic myelogenous leukemia (CML)", "Philadelphia chromosome-positive CML"],
        "sideEffects": ["Diarrhea", "Nausea", "Rash", "Fatigue", "Hepatotoxicity", "Myelosuppression"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "imatinib 400": {
        "brandName": "Imatinib 400", "genericName": "Imatinib Mesylate", "manufacturer": "Cipla Ltd",
        "dosage": "400mg", "uses": ["Chronic myelogenous leukemia", "GIST", "Philadelphia chromosome-positive ALL"],
        "sideEffects": ["Nausea", "Edema", "Muscle cramps", "Hepatotoxicity"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "isotretinoin 10": {
        "brandName": "Isotretinoin 10", "genericName": "Isotretinoin", "manufacturer": "Sun Pharma",
        "dosage": "10mg", "uses": ["Severe cystic acne", "Acne resistant to antibiotics"],
        "sideEffects": ["Dry lips/skin", "Teratogenicity", "Liver enzyme elevation", "Hypertriglyceridemia"],
        "howToUse": "Take as directed. Dosage: 10mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "colchicine 0.5": {
        "brandName": "Colchicine 0.5", "genericName": "Colchicine", "manufacturer": "Various",
        "dosage": "0.5mg", "uses": ["Acute gout", "Familial Mediterranean fever", "Pericarditis"],
        "sideEffects": ["Diarrhea", "Nausea", "Vomiting", "Muscle weakness"],
        "howToUse": "Take as directed. Dosage: 0.5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "allopurinol 100": {
        "brandName": "Allopurinol 100", "genericName": "Allopurinol", "manufacturer": "GSK India",
        "dosage": "100mg", "uses": ["Chronic gout", "Hyperuricemia", "Uric acid nephropathy"],
        "sideEffects": ["Rash", "GI upset", "Allopurinol hypersensitivity syndrome (rare)"],
        "howToUse": "Take as directed. Dosage: 100mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lasix 40": {
        "brandName": "Lasix 40", "genericName": "Furosemide (Frusemide)", "manufacturer": "Sanofi India",
        "dosage": "40mg", "uses": ["Edema", "Heart failure", "Hypertension", "Pulmonary edema", "Renal failure"],
        "sideEffects": ["Electrolyte depletion", "Dehydration", "Ototoxicity", "Hyperuricemia"],
        "howToUse": "Take as directed. Dosage: 40mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "aldactone 25": {
        "brandName": "Aldactone 25", "genericName": "Spironolactone", "manufacturer": "Pfizer India",
        "dosage": "25mg", "uses": ["Heart failure", "Hypertension", "Hyperaldosteronism", "Edema", "Hormonal acne"],
        "sideEffects": ["Hyperkalemia", "Gynecomastia", "Menstrual irregularity"],
        "howToUse": "Take as directed. Dosage: 25mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "insulin mixtard 30": {
        "brandName": "Insulin Mixtard 30", "genericName": "Human Insulin (30% soluble + 70% NPH)", "manufacturer": "Novo Nordisk India",
        "dosage": "100 IU/ml", "uses": ["Type 1 diabetes", "Type 2 diabetes insulin therapy"],
        "sideEffects": ["Hypoglycemia", "Injection site reactions", "Weight gain"],
        "howToUse": "Take as directed. Dosage: 100 IU/ml", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "lantus solostar": {
        "brandName": "Lantus Solostar", "genericName": "Insulin Glargine", "manufacturer": "Sanofi India",
        "dosage": "100 IU/ml pen", "uses": ["Type 1 and Type 2 diabetes", "Once-daily basal insulin"],
        "sideEffects": ["Hypoglycemia", "Weight gain", "Injection site reactions"],
        "howToUse": "Take as directed. Dosage: 100 IU/ml pen", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "fluconazole 150": {
        "brandName": "Fluconazole 150", "genericName": "Fluconazole", "manufacturer": "Cipla Ltd",
        "dosage": "150mg", "uses": ["Vaginal candidiasis", "Oral thrush", "Cryptococcal meningitis", "Tinea"],
        "sideEffects": ["Nausea", "Headache", "Abdominal pain", "Liver toxicity (rare)"],
        "howToUse": "Take as directed. Dosage: 150mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "itraconazole 200": {
        "brandName": "Itraconazole 200", "genericName": "Itraconazole", "manufacturer": "Glenmark Pharmaceuticals",
        "dosage": "200mg", "uses": ["Fungal nail infections", "Aspergillosis", "Candidiasis"],
        "sideEffects": ["Nausea", "Headache", "Liver toxicity", "QT prolongation"],
        "howToUse": "Take as directed. Dosage: 200mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "candid b cream": {
        "brandName": "Candid B Cream", "genericName": "Clotrimazole + Beclomethasone", "manufacturer": "Glenmark Pharmaceuticals",
        "dosage": "Cream", "uses": ["Fungal skin infections", "Tinea", "Ringworm", "Eczema with fungal infection"],
        "sideEffects": ["Skin irritation", "Burning", "Skin thinning (long-term)"],
        "howToUse": "Take as directed. Dosage: Cream", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "moxif eye drops": {
        "brandName": "Moxif Eye Drops", "genericName": "Moxifloxacin 0.5%", "manufacturer": "Sun Pharma",
        "dosage": "0.5% w/v", "uses": ["Bacterial conjunctivitis", "Eye infections", "Post-surgery prophylaxis"],
        "sideEffects": ["Burning", "Stinging", "Eye irritation"],
        "howToUse": "Take as directed. Dosage: 0.5% w/v", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "ciplox eye drops": {
        "brandName": "Ciplox Eye Drops", "genericName": "Ciprofloxacin 0.3%", "manufacturer": "Cipla Ltd",
        "dosage": "0.3% w/v", "uses": ["Bacterial eye infections", "Conjunctivitis", "Corneal ulcer"],
        "sideEffects": ["Stinging", "Burning", "Eye irritation"],
        "howToUse": "Take as directed. Dosage: 0.3% w/v", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "luliconazole cream": {
        "brandName": "Luliconazole Cream", "genericName": "Luliconazole", "manufacturer": "Sun Pharma",
        "dosage": "1% cream", "uses": ["Tinea pedis", "Tinea cruris", "Tinea corporis", "Ringworm"],
        "sideEffects": ["Application site reactions", "Contact dermatitis (rare)"],
        "howToUse": "Take as directed. Dosage: 1% cream", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "terbinafine 250": {
        "brandName": "Terbinafine 250", "genericName": "Terbinafine Hydrochloride", "manufacturer": "Cipla Ltd",
        "dosage": "250mg", "uses": ["Onychomycosis (fungal nail)", "Tinea", "Ringworm"],
        "sideEffects": ["Nausea", "Liver toxicity", "Skin rash", "Taste disturbance"],
        "howToUse": "Take as directed. Dosage: 250mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "acyclovir 400": {
        "brandName": "Acyclovir 400", "genericName": "Acyclovir", "manufacturer": "Cipla Ltd",
        "dosage": "400mg", "uses": ["Herpes simplex", "Herpes zoster (shingles)", "Chickenpox", "HSV encephalitis"],
        "sideEffects": ["Nausea", "Headache", "Dizziness", "Nephrotoxicity (high doses)"],
        "howToUse": "Take as directed. Dosage: 400mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "valacyclovir 500": {
        "brandName": "Valacyclovir 500", "genericName": "Valacyclovir Hydrochloride", "manufacturer": "Cipla Ltd",
        "dosage": "500mg", "uses": ["Herpes zoster", "Genital herpes", "CMV retinitis prophylaxis", "Labial herpes"],
        "sideEffects": ["Nausea", "Headache", "Dizziness"],
        "howToUse": "Take as directed. Dosage: 500mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "tenofovir disoproxil 300": {
        "brandName": "Tenofovir Disoproxil 300", "genericName": "Tenofovir Disoproxil Fumarate", "manufacturer": "Cipla Ltd",
        "dosage": "300mg", "uses": ["HIV infection", "Chronic hepatitis B", "HIV-1 treatment (with other ARVs)"],
        "sideEffects": ["Nausea", "Flatulence", "Renal toxicity", "Bone density loss"],
        "howToUse": "Take as directed. Dosage: 300mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "wysolone 5": {
        "brandName": "Wysolone 5", "genericName": "Prednisolone", "manufacturer": "Pfizer India",
        "dosage": "5mg", "uses": ["Autoimmune diseases", "Asthma", "Severe allergy", "Inflammation", "Nephrotic syndrome"],
        "sideEffects": ["Weight gain", "Hyperglycemia", "Osteoporosis", "Hypertension"],
        "howToUse": "Take as directed. Dosage: 5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "dexona 0.5": {
        "brandName": "Dexona 0.5", "genericName": "Dexamethasone", "manufacturer": "Zydus Cadila",
        "dosage": "0.5mg", "uses": ["Severe allergies", "Brain edema", "Adrenal insufficiency", "Anaphylaxis"],
        "sideEffects": ["Hyperglycemia", "Hypertension", "Cushing syndrome (long-term)"],
        "howToUse": "Take as directed. Dosage: 0.5mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "sorbitrate 5": {
        "brandName": "Sorbitrate 5", "genericName": "Isosorbide Dinitrate", "manufacturer": "Abbott India",
        "dosage": "5mg sublingual", "uses": ["Acute angina attack", "Angina prophylaxis", "Heart failure"],
        "sideEffects": ["Headache", "Hypotension", "Flushing", "Tolerance"],
        "howToUse": "Take as directed. Dosage: 5mg sublingual", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "pioglitazone 15": {
        "brandName": "Pioglitazone 15", "genericName": "Pioglitazone Hydrochloride", "manufacturer": "Zydus Cadila",
        "dosage": "15mg", "uses": ["Type 2 diabetes", "Insulin resistance", "NAFLD"],
        "sideEffects": ["Weight gain", "Edema", "Bladder cancer risk (long-term)", "Bone fractures"],
        "howToUse": "Take as directed. Dosage: 15mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "glimepiride 2": {
        "brandName": "Glimepiride 2", "genericName": "Glimepiride", "manufacturer": "Sanofi India",
        "dosage": "2mg", "uses": ["Type 2 diabetes", "Blood sugar control"],
        "sideEffects": ["Hypoglycemia", "Weight gain", "Nausea"],
        "howToUse": "Take as directed. Dosage: 2mg", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "zandu balm": {
        "brandName": "Zandu Balm", "genericName": "Menthol + Camphor + Eucalyptus Oil + Thymol", "manufacturer": "Zandu Pharmaceutical Works",
        "dosage": "Balm/Ointment", "uses": ["Headache", "Body ache", "Cold symptoms", "Nasal congestion", "Joint pain"],
        "sideEffects": ["Skin irritation", "Cooling sensation"],
        "howToUse": "Take as directed. Dosage: Balm/Ointment", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "vicks vaporub": {
        "brandName": "Vicks VapoRub", "genericName": "Menthol + Camphor + Eucalyptus Oil", "manufacturer": "Procter & Gamble India",
        "dosage": "Ointment", "uses": ["Common cold", "Nasal congestion", "Cough", "Muscle aches", "Headache"],
        "sideEffects": ["Skin irritation", "Burning if applied near eyes"],
        "howToUse": "Take as directed. Dosage: Ointment", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "patanjali divya gashar churna": {
        "brandName": "Patanjali Divya Gashar Churna", "genericName": "Ayurvedic Gas Relief Churna", "manufacturer": "Patanjali Ayurved Ltd",
        "dosage": "3g twice daily", "uses": ["Gas", "Bloating", "Indigestion", "Flatulence", "Constipation"],
        "sideEffects": ["Minimal – mild diarrhea if overused"],
        "howToUse": "Take as directed. Dosage: 3g twice daily", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "himalaya liv.52": {
        "brandName": "Himalaya Liv.52", "genericName": "Caper Bush + Chicory (Hepatoprotective herbal formulation)", "manufacturer": "Himalaya Drug Company",
        "dosage": "2 tablets twice daily", "uses": ["Liver disorders", "Hepatitis", "Fatty liver", "Alcoholic liver disease", "Loss of appetite"],
        "sideEffects": ["Very rare – mild GI upset"],
        "howToUse": "Take as directed. Dosage: 2 tablets twice daily", "storage": "Store below 30°C in a cool dry place.", "warnings": []
    },
    "himalaya ashwagandha": {
        "brandName": "Himalaya Ashwagandha", "genericName": "Withania somnifera (Ashwagandha)", "manufacturer": "Himalaya Drug Company",
        "dosage": "1-2 tablets daily", "uses": ["Stress", "Anxiety", "Immune support", "Physical stamina", "Hormone balance"],
        "sideEffects": ["GI upset in high doses", "Drowsiness"],
        "howToUse": "Take as directed. Dosage: 1-2 tablets daily", "storage": "Store below 30°C in a cool dry place.", "warnings": []
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
