/**
 * postProcess.js – Production-grade OCR text post-processing.
 *
 * Normalises raw OCR text, removes packaging noise, tokenises, scores
 * candidates by confidence / length / n-gram, and returns a ranked list.
 */

/* ── stopwords: packaging / dosage / irrelevant labels ───────────────── */

export const OCR_STOPWORDS = new Set([
  // dosage forms
  'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules',
  'syrup', 'syrp', 'suspension', 'susp', 'injection', 'inj', 'cream',
  'ointment', 'drops', 'gel', 'lotion', 'solution', 'powder', 'sachet',
  'inhaler', 'spray',
  // packaging
  'mrp', 'batch', 'mfg', 'exp', 'expiry', 'date', 'strip', 'pack', 'box',
  'bottle', 'vial', 'ampoule', 'blister',
  // dosage units
  'mg', 'ml', 'mcg', 'gm', 'gms', 'gram', 'grams', 'iu',
  // general filler
  'dosage', 'dose', 'use', 'uses', 'each', 'qty', 'quantity', 'rx', 'only',
  'no', 'of', 'for', 'and', 'the', 'with', 'per', 'is', 'to', 'in', 'on',
  'by', 'as', 'at', 'or', 'be', 'not', 'this', 'that', 'from', 'are',
  // regulatory
  'schedule', 'drug', 'licence', 'license', 'composition', 'store', 'keep',
  'below', 'above', 'room', 'temperature', 'children', 'away', 'reach',
  'warning', 'caution', 'contraindication', 'indications',
  // manufacturer filler
  'ltd', 'pvt', 'limited', 'private', 'india', 'pharma', 'pharmaceutical',
  'laboratories', 'lab', 'labs', 'manufactured', 'marketed', 'division',
  // packaging text extras
  'uncoated', 'coated', 'film', 'contains', 'directed', 'physician',
  'doctor', 'overdose', 'dry', 'dark', 'place', 'exceeding', 'injurious',
  'liver', 'made', 'regd', 'trade', 'mark', 'road', 'each',
  // common OCR noise from medicine packs
  'usp', 'ip', 'directions', 'content', 'netcontent', 'pregnancy', 'water'
]);

/* ── confusion-character map (OCR digit ↔ letter swaps) ──────────────── */

/** Symbol-only confusion corrections (always safe to apply). */
const SYMBOL_CORRECTIONS = [
  [/\$/g, 's'],
  [/@/g, 'a'],
  [/\|/g, 'l'],
  [/!/g, 'i']
];

/**
 * Digit→letter map (only applied to isolated digits within alpha context,
 * NOT to digit runs like "650" in medicine names).
 */
const DIGIT_LETTER_MAP = {
  '0': 'o', '1': 'l', '5': 's', '8': 'b', '6': 'g', '7': 't'
};

/* ── public helpers ──────────────────────────────────────────────────── */

/**
 * Apply confusion-map corrections to a single token.
 * Context-aware: preserves digit runs (medicine strengths like "650")
 * and only converts isolated digits surrounded by letters.
 */
export const applyConfusionCorrections = (token) => {
  let result = String(token || '');

  // Always apply symbol corrections
  for (const [pattern, replacement] of SYMBOL_CORRECTIONS) {
    result = result.replace(pattern, replacement);
  }

  // Context-aware digit→letter: only replace a digit when it is
  // surrounded by letters (likely an OCR misread, e.g. "D0lo" → "Dolo")
  result = result.replace(/([a-zA-Z])(\d)([a-zA-Z])/g, (_, pre, digit, post) => {
    return pre + (DIGIT_LETTER_MAP[digit] || digit) + post;
  });

  // Leading digit before 2+ letters (e.g. "0olo" → "oolo")
  result = result.replace(/^(\d)([a-zA-Z]{2,})/g, (_, digit, rest) => {
    return (DIGIT_LETTER_MAP[digit] || digit) + rest;
  });

  // Trailing digit after 2+ letters (e.g. "hell0" → "hello")
  result = result.replace(/([a-zA-Z]{2,})(\d)$/g, (_, pre, digit) => {
    return pre + (DIGIT_LETTER_MAP[digit] || digit);
  });

  return result;
};

/**
 * Normalize an OCR token for comparison / dedup.
 */
export const normalizeToken = (value) =>
  applyConfusionCorrections(String(value || ''))
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeKey = (value) => normalizeToken(value).toLowerCase();

/**
 * Returns true when a token looks like it could be a medicine name.
 */
export const looksLikeMedicine = (token) => {
  const k = normalizeKey(token);
  if (!k) return false;
  if (OCR_STOPWORDS.has(k)) return false;
  if (/^\d+$/.test(k)) return false;
  if (/^\d+(mg|ml|mcg|gm|iu)$/i.test(k)) return false;
  if (k.length < 3) return false;
  // Standard: starts with letter, may contain digits and hyphens
  if (/^[a-z][a-z0-9-]{2,}$/.test(k)) return true;
  // Medicine+strength pattern: "dolo-650", "crocin-500", "azithral-250"
  if (/^[a-z]{2,}[-]?\d{2,4}$/.test(k)) return true;
  return false;
};

/**
 * Score boost based on token length (longer = more likely medicine name).
 */
export const lengthBoost = (token) => {
  const k = normalizeKey(token);
  if (k.length >= 10) return 0.18;
  if (k.length >= 8) return 0.14;
  if (k.length >= 5) return 0.10;
  return 0.04;
};

/* ── main post-processing pipeline ───────────────────────────────────── */

/**
 * Process raw OCR output into a ranked candidate list.
 *
 * @param {object} ocrResult – { text, confidence, words[] }
 * @param {object} [opts]
 * @returns {{ candidates: string[], wordTokens: string[], confidence: number, rawText: string }}
 */
export const postProcessOcr = (ocrResult, opts = {}) => {
  const { text = '', confidence = 0, words = [] } = ocrResult;
  const minWordConfidence = Number(opts.minWordConfidence ?? 38);
  const maxNgram = Math.min(4, Math.max(2, Number(opts.maxNgram ?? 3)));

  const scored = new Map(); // key → { value, score }

  const addCandidate = (candidate, score) => {
    const value = normalizeToken(candidate);
    const key = normalizeKey(candidate);
    if (!value || !key || key.length < 3) return;
    if (OCR_STOPWORDS.has(key)) return;

    const existing = scored.get(key);
    if (!existing) {
      scored.set(key, { value, score });
    } else {
      existing.score = Math.max(existing.score, score);
    }
  };

  /* ── 1. Line-level candidates ─────────────────────────────────────── */

  const lines = text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[,;|:/]+/))
    .map((seg) => normalizeToken(seg))
    .filter(Boolean)
    .filter((seg) => seg.length >= 3)
    .slice(0, 40);

  for (const line of lines) {
    const medicineWords = line
      .split(/\s+/)
      .filter((tok) => looksLikeMedicine(tok));
    if (!medicineWords.length) continue;

    const joined = medicineWords.join(' ');
    addCandidate(joined, 0.55 + Math.min(0.2, medicineWords.length * 0.06));

    // Also add individual words from lines
    for (const w of medicineWords) {
      addCandidate(w, 0.42 + lengthBoost(w));
    }
  }

  /* ── 1b. Pattern-based brand+strength extraction ─────────────────── */

  // Normalize OCR-confused numeric strings like "6SO" → "650".
  const normalizeStrengthNumber = (value) => String(value || '')
    .replace(/[oO]/g, '0')
    .replace(/[sS]/g, '5')
    .replace(/[lI]/g, '1')
    .replace(/[^0-9]/g, '');

  // Pattern A: "Dolo-650" / "Dolo:650" / "Dolo 650"
  for (const match of String(text || '').matchAll(/\b([A-Za-z]{3,})\s*[-: ]\s*([0-9oOsSlI]{2,4})\b/g)) {
    const brand = normalizeToken(match[1]);
    const dose = normalizeStrengthNumber(match[2]);
    if (!looksLikeMedicine(brand) || dose.length < 2) continue;

    addCandidate(`${brand}-${dose}`, 0.82);
    addCandidate(`${brand} ${dose}`, 0.78);
  }

  // Pattern B: "Azithromycin 250 mg" / "Amoxicillin 500mg"
  for (const match of String(text || '').matchAll(/\b([A-Za-z]{4,})\s+([0-9oOsSlI]{2,4})\s*(mg|ml|mcg|gm|iu)\b/gi)) {
    const name = normalizeToken(match[1]);
    const dose = normalizeStrengthNumber(match[2]);
    if (!looksLikeMedicine(name) || dose.length < 2) continue;

    addCandidate(`${name}-${dose}`, 0.80);
    addCandidate(name, 0.62 + lengthBoost(name));
  }

  /* ── 2. Confident word tokens ─────────────────────────────────────── */

  const confidentWords = words
    .filter((w) => (w.confidence || 0) >= minWordConfidence)
    .map((w) => ({
      token: normalizeToken(w.text),
      confidence: w.confidence || 0
    }))
    .filter((w) => looksLikeMedicine(w.token));

  for (const item of confidentWords) {
    const baseScore = 0.50 + Math.min(0.35, item.confidence / 180) + lengthBoost(item.token);
    addCandidate(item.token, baseScore);
  }

  /* ── 3. Text-body tokens ──────────────────────────────────────────── */

  const cleanedText = normalizeToken(text);
  const bodyTokens = cleanedText
    .split(/\s+/)
    .filter((tok) => looksLikeMedicine(tok));

  for (const tok of bodyTokens) {
    addCandidate(tok, 0.38 + lengthBoost(tok));
  }

  /* ── 4. N-gram candidates ─────────────────────────────────────────── */

  const tokenPool = new Map();
  for (const w of confidentWords) {
    tokenPool.set(normalizeKey(w.token), w);
  }
  for (const t of bodyTokens) {
    if (!tokenPool.has(normalizeKey(t))) {
      tokenPool.set(normalizeKey(t), { token: t, confidence: minWordConfidence });
    }
  }

  const mergedArray = Array.from(tokenPool.values()).slice(0, 80);

  for (let i = 0; i < mergedArray.length; i += 1) {
    for (let size = 2; size <= maxNgram; size += 1) {
      const chunk = mergedArray.slice(i, i + size);
      if (chunk.length < size) continue;

      const ngram = chunk.map((it) => it.token).join(' ').trim();
      if (ngram.length < 4) continue;

      const avgConf = chunk.reduce((s, it) => s + it.confidence, 0) / chunk.length;
      const ngramScore = 0.48 + Math.min(0.3, avgConf / 200) + (size - 1) * 0.06;
      addCandidate(ngram, ngramScore);
    }
  }

  /* ── 5. Sort by score, deduplicate, return ────────────────────────── */

  const candidates = Array.from(scored.values())
    .sort((a, b) => b.score - a.score || a.value.length - b.value.length)
    .map((it) => it.value)
    .filter(Boolean)
    .slice(0, 60);

  const wordTokens = Array.from(
    new Set(confidentWords.map((w) => normalizeToken(w.token)).filter(Boolean))
  ).slice(0, 50);

  return {
    candidates,
    wordTokens,
    confidence: Number(confidence.toFixed(2)),
    rawText: text
  };
};
