import Tesseract from 'tesseract.js';

const normalizeMedicineToken = (value) =>
  String(value || '')
    .replace(/[0]/g, 'o')
    .replace(/[1]/g, 'l')
    .replace(/[5]/g, 's')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
      data = await recognizeWithPsm(imagePathOrBuffer, lang, 6);
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

    const lineCandidates = lines
      .filter((line) => line.length >= 3)
      .slice(0, 24);

    const confidentWordTokens = (words || [])
      .filter((w) => w.confidence >= minWordConfidence)
      .map((w) => w.text)
      .filter((token) => /^[a-zA-Z][a-zA-Z0-9-]{2,}$/.test(token));

    const textTokens = cleanedText
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => /^[a-zA-Z][a-zA-Z0-9-]{2,}$/.test(token));

    const ngramCandidates = [];
    const mergedTokens = [...confidentWordTokens, ...textTokens].slice(0, 60);
    for (let i = 0; i < mergedTokens.length; i += 1) {
      for (let size = 1; size <= maxNgram; size += 1) {
        const ngram = mergedTokens.slice(i, i + size).join(' ').trim();
        if (ngram.length >= 3) ngramCandidates.push(ngram);
      }
    }

    const deduped = Array.from(new Set([...lineCandidates, ...ngramCandidates].map((v) => normalizeMedicineToken(v))))
      .filter(Boolean)
      .slice(0, 50);

    return {
      candidates: deduped,
      confidence,
      rawText: text,
      wordTokens: confidentWordTokens.slice(0, 40),
      ocrMode: options.mode || 'balanced'
    };
  }
};