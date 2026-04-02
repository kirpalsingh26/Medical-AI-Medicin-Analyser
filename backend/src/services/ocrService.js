import Tesseract from 'tesseract.js';

const OCR_STOPWORDS = new Set([
  'tab',
  'tabs',
  'tablet',
  'tablets',
  'cap',
  'caps',
  'capsule',
  'capsules',
  'syrup',
  'suspension',
  'injection',
  'mrp',
  'batch',
  'mfg',
  'exp',
  'expiry',
  'date',
  'strip',
  'dosage',
  'use',
  'uses',
  'each',
  'qty',
  'rx',
  'no',
  'of',
  'for',
  'and',
  'the',
  'with',
  'per',
  'mg',
  'ml',
  'mcg',
  'gm'
]);

const normalizeMedicineToken = (value) =>
  String(value || '')
    .replace(/[0]/g, 'o')
    .replace(/[1]/g, 'l')
    .replace(/[5]/g, 's')
    .replace(/[8]/g, 'b')
    .replace(/[6]/g, 'g')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeForKey = (value) => normalizeMedicineToken(value).toLowerCase();

const looksLikeMedicine = (token) => {
  const normalized = normalizeForKey(token);
  if (!normalized) return false;
  if (OCR_STOPWORDS.has(normalized)) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (/^\d+(mg|ml|mcg|gm)$/i.test(normalized)) return false;

  return /^[a-z][a-z0-9-]{2,}$/.test(normalized);
};

const scoreBoostForToken = (token) => {
  const normalized = normalizeForKey(token);
  if (normalized.length >= 8) return 0.12;
  if (normalized.length >= 5) return 0.08;
  return 0.04;
};

const addCandidateScore = (store, candidate, score) => {
  const normalized = normalizeMedicineToken(candidate);
  const key = normalizeForKey(candidate);
  if (!normalized || !key) return;
  if (OCR_STOPWORDS.has(key)) return;

  const existing = store.get(key);
  if (!existing) {
    store.set(key, { value: normalized, score });
    return;
  }

  existing.score = Math.max(existing.score, score);
};

const recognizeWithPsm = async (imagePathOrBuffer, lang, psm) => {
  const { data } = await Tesseract.recognize(imagePathOrBuffer, lang, {
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: '1'
  });
  return data;
};

export const ocrService = {
  extractTextWithConfidence: async (imagePathOrBuffer, lang = 'eng', options = {}) => {
    const mode = options.mode || 'balanced';

    let data;
    if (mode === 'accurate') {
      const passes = await Promise.all([
        recognizeWithPsm(imagePathOrBuffer, lang, 6),
        recognizeWithPsm(imagePathOrBuffer, lang, 11)
      ]);
      data = passes.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    } else if (mode === 'fast') {
      data = await recognizeWithPsm(imagePathOrBuffer, lang, 11);
    } else {
      const primary = await recognizeWithPsm(imagePathOrBuffer, lang, 6);
      if ((primary.confidence || 0) >= 60) {
        data = primary;
      } else {
        const secondary = await recognizeWithPsm(imagePathOrBuffer, lang, 11);
        data = (secondary.confidence || 0) > (primary.confidence || 0) ? secondary : primary;
      }
    }

    const words = data.words || [];
    const avgConfidence =
      words.length > 0
        ? words.reduce((sum, w) => sum + (w.confidence || 0), 0) / words.length
        : data.confidence || 0;

    return {
      text: data.text || '',
      confidence: Number(avgConfidence.toFixed(2)),
      words: words.map((w) => ({
        text: normalizeMedicineToken(w.text),
        confidence: Number((w.confidence || 0).toFixed(2))
      }))
    };
  },

  extractMedicineCandidates: async (imagePathOrBuffer, lang = 'eng', options = {}) => {
    const minWordConfidence = Number(options.minWordConfidence ?? 42);
    const maxNgram = Math.min(4, Math.max(2, Number(options.maxNgram ?? 3)));

    const { text, confidence, words } = await ocrService.extractTextWithConfidence(
      imagePathOrBuffer,
      lang,
      options
    );

    const cleanedText = normalizeMedicineToken(text);
    const lines = text
      .split(/\r?\n/)
      .map((line) => normalizeMedicineToken(line))
      .filter(Boolean);

    const scoredCandidates = new Map();

    const lineCandidates = lines
      .flatMap((line) =>
        line
          .split(/[,;|:/]+/)
          .map((part) => normalizeMedicineToken(part))
          .filter(Boolean)
      )
      .filter((line) => line.length >= 3)
      .slice(0, 36);

    for (const line of lineCandidates) {
      const lineKey = normalizeForKey(line);
      if (OCR_STOPWORDS.has(lineKey)) continue;

      const lineWords = line
        .split(/\s+/)
        .map((token) => normalizeMedicineToken(token))
        .filter((token) => looksLikeMedicine(token));

      if (!lineWords.length) continue;
      addCandidateScore(scoredCandidates, lineWords.join(' '), 0.52 + Math.min(0.2, lineWords.length * 0.05));
    }

    const confidentWordTokens = (words || [])
      .filter((w) => w.confidence >= minWordConfidence)
      .map((w) => ({
        token: normalizeMedicineToken(w.text),
        confidence: Number(w.confidence || 0)
      }))
      .filter((w) => looksLikeMedicine(w.token));

    for (const item of confidentWordTokens) {
      const baseScore = 0.45 + Math.min(0.4, item.confidence / 200) + scoreBoostForToken(item.token);
      addCandidateScore(scoredCandidates, item.token, baseScore);
    }

    const textTokens = cleanedText
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => looksLikeMedicine(token));

    for (const token of textTokens) {
      addCandidateScore(scoredCandidates, token, 0.36 + scoreBoostForToken(token));
    }

    const ngramCandidates = [];
    const mergedTokens = Array.from(
      new Map(
        [...confidentWordTokens.map((w) => [normalizeForKey(w.token), w]), ...textTokens.map((t) => [normalizeForKey(t), { token: t, confidence: minWordConfidence }])]
      ).values()
    ).slice(0, 70);

    for (let i = 0; i < mergedTokens.length; i += 1) {
      for (let size = 1; size <= maxNgram; size += 1) {
        const chunk = mergedTokens.slice(i, i + size);
        if (!chunk.length) continue;

        const ngram = chunk
          .map((item) => item.token)
          .join(' ')
          .trim();

        if (ngram.length < 3) continue;

        const avgChunkConfidence = chunk.reduce((sum, item) => sum + item.confidence, 0) / chunk.length;
        const ngramScore = 0.42 + Math.min(0.32, avgChunkConfidence / 220) + Math.min(0.12, (size - 1) * 0.05);
        ngramCandidates.push({ value: ngram, score: ngramScore });
      }
    }

    for (const ngram of ngramCandidates) {
      addCandidateScore(scoredCandidates, ngram.value, ngram.score);
    }

    const deduped = Array.from(scoredCandidates.values())
      .sort((a, b) => b.score - a.score || a.value.length - b.value.length)
      .map((item) => item.value)
      .filter(Boolean)
      .slice(0, 50);

    const topWordTokens = Array.from(
      new Set(confidentWordTokens.map((w) => normalizeMedicineToken(w.token)).filter(Boolean))
    ).slice(0, 40);

    return {
      candidates: deduped,
      confidence,
      rawText: text,
      wordTokens: topWordTokens,
      ocrMode: options.mode || 'balanced'
    };
  }
};