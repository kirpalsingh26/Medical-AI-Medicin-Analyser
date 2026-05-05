import fetch from 'node-fetch';
import { medicineService } from '../services/medicineService.js';
import { ocrService } from '../services/ocrService.js';
import { SearchHistory } from '../models/SearchHistory.js';
import { AppError } from '../utils/AppError.js';

const OCR_SERVICE_URL = `http://localhost:${process.env.OCR_SERVICE_PORT || 5050}`;

/**
 * Query OpenFDA drug label API for a given medicine name.
 * Returns enriched medicine data or null if not found.
 * Free API – no key required.
 */
async function callOpenFDA(medicineName) {
  if (!medicineName) return null;
  const enc = encodeURIComponent(medicineName.trim());
  const urls = [
    `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${enc}"&limit=1`,
    `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${enc}"&limit=1`,
    `https://api.fda.gov/drug/label.json?search=openfda.brand_name:${enc}&limit=1`
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const r = data?.results?.[0];
      if (!r) continue;
      const openFda = r.openfda || {};
      return {
        source: 'OpenFDA',
        name: openFda.brand_name?.[0] || medicineName,
        genericName: openFda.generic_name?.[0] || '',
        manufacturer: openFda.manufacturer_name?.[0] || '',
        uses: r.indications_and_usage || [],
        sideEffects: r.adverse_reactions || [],
        warnings: r.warnings || r.boxed_warning || [],
        dosage: r.dosage_and_administration?.[0] || '',
        howToUse: r.dosage_and_administration?.[0] || '',
        storage: r.storage_and_handling?.[0] || '',
        category: openFda.pharm_class_cs?.[0] || openFda.pharm_class_epc?.[0] || 'Medicine'
      };
    } catch {
      // continue to next URL
    }
  }
  return null;
}

/**
 * Query RxNorm API to get the standardized drug name and rxcui for a medicine.
 * Free API – no key required.
 */
async function callRxNorm(medicineName) {
  if (!medicineName) return null;
  try {
    const enc = encodeURIComponent(medicineName.trim());
    const resp = await fetch(
      `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${enc}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const groups = data?.drugGroup?.conceptGroup || [];
    for (const g of groups) {
      const props = g.conceptProperties || [];
      if (props.length) {
        return {
          rxcui: props[0].rxcui,
          normalizedName: props[0].name,
          synonym: props[0].synonym || ''
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

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

/**
 * POST /medicines/ocr-feedback
 * Save user-corrected medicine name from a scan.
 * Used to improve matching — stored in SearchHistory with source='ocr-feedback'.
 * Also seeds the DB if the corrected medicine doesn't exist yet.
 */
export const ocrFeedback = async (req, res) => {
  const { detectedName, correctName, confidence, detectedText } = req.body;
  if (!correctName) throw new AppError('correctName is required', 400);

  // Save correction to search history
  if (req.user) {
    await SearchHistory.create({
      user: req.user._id,
      query: correctName,
      source: 'ocr-feedback',
      resultCount: 1,
      meta: { detectedName, confidence, detectedText }
    });
  }

  // Check if this medicine is already in the DB
  const existing = await medicineService.search(correctName);
  let enriched = null;

  if (!existing.length) {
    // Try to enrich from OpenFDA then add to DB
    enriched = await callOpenFDA(correctName);
    if (enriched) {
      const { Medicine } = await import('../models/Medicine.js');
      try {
        await Medicine.create({
          name: enriched.name || correctName,
          genericName: enriched.genericName || '',
          manufacturer: enriched.manufacturer || '',
          dosage: enriched.dosage || '',
          uses: enriched.uses || [],
          sideEffects: enriched.sideEffects || [],
          warnings: enriched.warnings || [],
          howToUse: enriched.howToUse || '',
          storage: enriched.storage || '',
          category: enriched.category || 'Medicine',
          source: 'user-feedback'
        });
      } catch (e) {
        if (e.code !== 11000) throw e; // ignore duplicate key
      }
    }
  }

  res.status(200).json({
    success: true,
    message: 'Feedback saved. Thank you for improving MedVision!',
    addedToDb: !!enriched && !existing.length
  });
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
  // Also try Gemini's generic name as extra candidate
  const geminiGeneric = pythonResult?.medicine?.genericName || '';
  if (geminiGeneric && !candidateSet.has(geminiGeneric)) allCandidates.push(geminiGeneric);

  const matched = [];
  const seenTokens = new Set();
  for (const candidate of allCandidates.slice(0, 10)) {
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

  // ── 4b. Multi-source enrichment fallback ────────────────────────────────
  //   When DB has no match but Gemini/OCR identified a name, try:
  //   1. OpenFDA (free drug label API) for authoritative drug data
  //   2. RxNorm (free) for standardized name + rxcui
  //   3. Gemini AI data as final fallback
  const aiMed = pythonResult?.medicine;
  if (matched.length === 0 && aiMed?.name) {
    // Run OpenFDA + RxNorm in parallel
    const [fdaData, rxData] = await Promise.allSettled([
      callOpenFDA(aiMed.name),
      callRxNorm(aiMed.name)
    ]);
    const fda = fdaData.status === 'fulfilled' ? fdaData.value : null;
    const rx  = rxData.status  === 'fulfilled' ? rxData.value  : null;

    // Also try generic name if brand lookup failed
    let fdaByGeneric = null;
    if (!fda && aiMed.genericName) {
      try { fdaByGeneric = await callOpenFDA(aiMed.genericName); } catch {}
    }
    const bestFda = fda || fdaByGeneric;

    matched.push({
      candidate: aiMed.name,
      fromAI: true,
      fdaEnriched: !!bestFda,
      rxNormCui: rx?.rxcui || null,
      matches: [{
        _id: `ai-${Date.now()}`,
        name: bestFda?.name || aiMed.name,
        genericName: bestFda?.genericName || aiMed.genericName || rx?.normalizedName || '',
        category: bestFda?.category || aiMed.category || 'Medicine',
        manufacturer: bestFda?.manufacturer || aiMed.manufacturer || '',
        dosage: bestFda?.dosage || aiMed.dosage || '',
        uses: (bestFda?.uses?.length ? bestFda.uses : null) || aiMed.uses || [],
        sideEffects: (bestFda?.sideEffects?.length ? bestFda.sideEffects : null) || aiMed.sideEffects || [],
        alternatives: aiMed.alternatives || [],
        warnings: (bestFda?.warnings?.length ? bestFda.warnings : null) || aiMed.warnings || [],
        howToUse: bestFda?.howToUse || aiMed.howToUse || '',
        storage: bestFda?.storage || aiMed.storage || '',
        rxcui: rx?.rxcui || null,
        dataSources: ['Gemini AI', bestFda ? 'OpenFDA' : null, rx ? 'RxNorm' : null].filter(Boolean),
        score: pythonResult.confidence / 100
      }]
    });
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
            elapsedMs: pythonResult.elapsedMs,
            enrichmentSources: ['Gemini Vision', 'OpenFDA', 'RxNorm']
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