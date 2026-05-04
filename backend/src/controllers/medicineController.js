import fetch from 'node-fetch';
import { medicineService } from '../services/medicineService.js';
import { ocrService } from '../services/ocrService.js';
import { SearchHistory } from '../models/SearchHistory.js';
import { AppError } from '../utils/AppError.js';

const OCR_SERVICE_URL = `http://localhost:${process.env.OCR_SERVICE_PORT || 5050}`;

/** Call the Python Gemini-Vision OCR microservice. Returns null if unavailable. */
async function callPythonOcr(imageBase64) {
  try {
    const resp = await fetch(`${OCR_SERVICE_URL}/ocr-analyze-base64`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
      signal: AbortSignal.timeout(35_000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.success ? data : null;
  } catch {
    return null; // service not running – fall back gracefully
  }
}

export const searchMedicines = async (req, res) => {
  const query = req.query.q || '';
  const data = await medicineService.search(query);

  if (req.user && query) {
    await SearchHistory.create({
      user: req.user._id,
      query,
      source: 'text',
      resultCount: data.length
    });
  }

  res.status(200).json({ success: true, data });
};

export const autocompleteMedicines = async (req, res) => {
  const query = req.query.q || '';
  const limit = Number(req.query.limit || 8);
  const includeAll = String(req.query.includeAll || '').toLowerCase() === 'true';

  const data = await medicineService.autocomplete(query, { limit, includeAll });
  res.status(200).json({ success: true, data });
};

export const medicineCatalog = async (req, res) => {
  const limit = Number(req.query.limit || 500);
  const data = await medicineService.listCatalog(limit);
  res.status(200).json({ success: true, data });
};

export const barcodeLookup = async (req, res) => {
  const { barcode } = req.query;
  const data = await medicineService.findByBarcode(barcode);
  res.status(200).json({ success: true, data });
};

export const compareMedicines = async (req, res) => {
  const { medicineA, medicineB } = req.body;
  if (!medicineA || !medicineB) {
    throw new AppError('Please provide both medicine names to compare.', 400);
  }

  const data = await medicineService.compare(medicineA, medicineB);

  if (!data.a || !data.b) {
    const missing = [];
    if (!data.a) missing.push(`"${medicineA}"`);
    if (!data.b) missing.push(`"${medicineB}"`);
    throw new AppError(`Medicine not found in catalog: ${missing.join(', ')}`, 404);
  }

  res.status(200).json({ success: true, data });
};

export const ocrScan = async (req, res) => {
  const { imageBase64, lang = 'eng', ocrOptions = {} } = req.body;
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  // ── 1. Try Python Gemini-Vision OCR (primary) ─────────────────────────────
  const pythonResult = await callPythonOcr(imageBase64);

  // ── 2. Tesseract fallback ─────────────────────────────────────────────────
  const pipelineResult = await ocrService.fullPipeline(imageBuffer, lang, {
    mode: ocrOptions.mode,
    minWordConfidence: ocrOptions.minWordConfidence,
    maxNgram: ocrOptions.maxNgram,
    matchLimit: 5,
    preprocessOpts: ocrOptions.preprocessOpts
  });

  // ── 3. Build candidate list ───────────────────────────────────────────────
  // Prefer Gemini medicine name, augment with Tesseract candidates
  const geminiName = pythonResult?.medicine?.name || '';
  const candidateSet = new Set([
    ...(geminiName ? [geminiName] : []),
    ...(pipelineResult.candidates || [])
  ]);
  const allCandidates = [...candidateSet];

  // ── 4. DB matching ────────────────────────────────────────────────────────
  const matched = [];
  const seenTokens = new Set();
  for (const candidate of allCandidates.slice(0, 8)) {
    const results = await medicineService.search(candidate);
    if (results.length) {
      matched.push({ candidate, matches: results.slice(0, 3) });
      continue;
    }
    const tokenized = candidate
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z]/g, '').trim())
      .filter((t) => t.length >= 4);
    for (const token of tokenized) {
      const norm = token.toLowerCase();
      if (seenTokens.has(norm)) continue;
      seenTokens.add(norm);
      const tokenResults = await medicineService.search(token);
      if (tokenResults.length) {
        matched.push({ candidate: token, matches: tokenResults.slice(0, 3) });
      }
    }
  }

  res.status(200).json({
    success: true,
    data: {
      // quality signal – take best of the two engines
      confidence: Math.max(
        pythonResult?.confidence ?? 0,
        pipelineResult.confidence ?? 0
      ),
      // Gemini AI details (may be null if Python service not running)
      aiDetails: pythonResult
        ? {
            source: pythonResult.source,
            confidence: pythonResult.confidence,
            medicineName: pythonResult.medicine?.name,
            genericName: pythonResult.medicine?.genericName,
            manufacturer: pythonResult.medicine?.manufacturer,
            dosage: pythonResult.medicine?.dosage,
            uses: pythonResult.medicine?.uses,
            sideEffects: pythonResult.medicine?.sideEffects,
            howToUse: pythonResult.medicine?.howToUse,
            storage: pythonResult.medicine?.storage,
            warnings: pythonResult.medicine?.warnings,
            detectedText: pythonResult.detectedText,
            elapsedMs: pythonResult.elapsedMs
          }
        : null,
      // Tesseract pipeline results (kept for DB matching)
      bestPassConfidence: pipelineResult.bestPassConfidence,
      passCount: pipelineResult.passCount,
      fallbackUsed: pipelineResult.fallbackUsed,
      ocrMode: pipelineResult.ocrMode,
      preprocessMeta: pipelineResult.preprocessMeta,
      candidates: allCandidates,
      matched,
      detectedMedicines: pipelineResult.detectedMedicines,
      suggestions: pipelineResult.suggestions,
      wordTokens: pipelineResult.wordTokens,
      rawText: pythonResult?.detectedText || pipelineResult.rawText,
      elapsedMs: (pythonResult?.elapsedMs || 0) + (pipelineResult.elapsedMs || 0)
    }
  });
};