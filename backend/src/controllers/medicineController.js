import { medicineService } from '../services/medicineService.js';
import { ocrService } from '../services/ocrService.js';
import { SearchHistory } from '../models/SearchHistory.js';
import { AppError } from '../utils/AppError.js';

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
  const data = await ocrService.extractMedicineCandidates(imageBuffer, lang, ocrOptions);

  const matched = [];
  const seenTokens = new Set();
  for (const candidate of data.candidates.slice(0, 10)) {
    const results = await medicineService.search(candidate);
    if (results.length) {
      matched.push({ candidate, matches: results.slice(0, 3) });
      continue;
    }

    const tokenized = candidate
      .split(/\s+/)
      .map((token) => token.replace(/[^a-zA-Z]/g, '').trim())
      .filter((token) => token.length >= 4);

    for (const token of tokenized) {
      const normalized = token.toLowerCase();
      if (seenTokens.has(normalized)) continue;
      seenTokens.add(normalized);

      const tokenResults = await medicineService.search(token);
      if (tokenResults.length) {
        matched.push({ candidate: token, matches: tokenResults.slice(0, 3) });
      }
    }
  }

  const fuzzyDetected = await medicineService.matchBestFromCandidates(
    [...data.candidates, ...(data.wordTokens || [])],
    8
  );

  const detectedMedicines = fuzzyDetected.map((item) => ({
    candidate: item.candidate,
    score: item.score,
    medicine: item.medicine
  }));

  const suggestionSet = new Map();
  const suggestionTokens = [...(data.wordTokens || []), ...data.candidates]
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .slice(0, 30);

  for (const token of suggestionTokens) {
    const suggestions = await medicineService.autocomplete(token.slice(0, 8));
    for (const item of suggestions.slice(0, 3)) {
      if (!item?.name) continue;
      if (!suggestionSet.has(item.name.toLowerCase())) {
        suggestionSet.set(item.name.toLowerCase(), {
          basedOn: token,
          name: item.name,
          genericName: item.genericName || '',
          category: item.category || ''
        });
      }
    }
    if (suggestionSet.size >= 12) break;
  }

  const suggestions = Array.from(suggestionSet.values()).slice(0, 12);

  res.status(200).json({
    success: true,
    data: {
      confidence: data.confidence,
      ocrMode: data.ocrMode,
      candidates: data.candidates,
      matched,
      detectedMedicines,
      suggestions,
      wordTokens: data.wordTokens || [],
      rawText: data.rawText
    }
  });
};