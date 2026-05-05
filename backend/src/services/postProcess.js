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
  [/!/g, 'i'],
  [/\{/g, '('],
  [/\}/g, ')'],
  [/©/g, 'c'],
  [/®/g, ''],
  [/™/g, ''],
  // Common OCR misreads on medicine packaging
  [/[`´]/g, "'"],
  [/[°º]/g, 'o'],
  [/[¡]/g, 'i'],
  [/\\n/g, ' ']
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
  // Special case: digit '1' could be 'i' or 'l' — prefer 'i' when between vowels,
  // otherwise use standard map ('l').
  result = result.replace(/([a-zA-Z])(\d)([a-zA-Z])/g, (_, pre, digit, post) => {
    if (digit === '1') {
      // '1' between two vowel-adjacent letters → prefer 'i' (e.g. Az1thral → Azithral)
      const vowels = 'aeiouAEIOU';
      if (vowels.includes(pre) || vowels.includes(post)) return pre + 'i' + post;
      return pre + 'l' + post;
    }
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
 * Also generates OCR-variant candidates by trying both 'i' and 'l' for digit '1'.
 */
export const normalizeToken = (value) =>
  applyConfusionCorrections(String(value || ''))
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Return all plausible token variants for ambiguous OCR characters.
 * e.g. "Az1thral" → ["Azithral", "Azlthral"]
 */
export const tokenVariants = (value) => {
  const base = normalizeToken(value);
  const variants = new Set([base]);
  // For tokens containing '1' in alpha context, try both 'i' and 'l' substitutions
  if (/[a-zA-Z][1][a-zA-Z]/.test(String(value || ''))) {
    const withI = String(value || '').replace(/([a-zA-Z])1([a-zA-Z])/g, '$1i$2');
    const withL = String(value || '').replace(/([a-zA-Z])1([a-zA-Z])/g, '$1l$2');
    variants.add(normalizeToken(withI));
    variants.add(normalizeToken(withL));
  }
  return Array.from(variants).filter(Boolean);
};

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
  const minWordConfidence = Number(opts.minWordConfidence ?? 30);
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

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineBonus = lineIdx === 0 ? 0.18 : lineIdx === 1 ? 0.08 : 0.0;

    const medicineWords = line
      .split(/\s+/)
      .filter((tok) => looksLikeMedicine(tok));
    if (!medicineWords.length) continue;

    const joined = medicineWords.join(' ');
    addCandidate(joined, 0.55 + lineBonus + Math.min(0.2, medicineWords.length * 0.06));

    // Also add individual words from lines — including OCR variants (i vs l for '1')
    for (const w of medicineWords) {
      const baseScore = 0.42 + lineBonus + lengthBoost(w);
      for (const variant of tokenVariants(w)) {
        addCandidate(variant, baseScore);
      }
    }
  }

  /* ── 1b. Pattern-based brand+strength extraction ─────────────────── */

  /* ── 1c. Raw-text digit-ambiguity variants ────────────────────────── */
  // Generate OCR character variants from the RAW text (before normalization strips '1' → 'l').
  // This catches cases like "Az1thral" → also try "Azithral" (1→i) in addition to "Azlthral" (1→l).
  for (const rawWord of String(text || '').split(/[\s\n\r,;|:/+]+/).filter(Boolean)) {
    if (rawWord.length < 4) continue;
    if (!/[a-zA-Z][0-9][a-zA-Z]/.test(rawWord)) continue; // only words with digit in alpha context
    const variants = tokenVariants(rawWord);
    for (const variant of variants) {
      if (looksLikeMedicine(variant)) {
        addCandidate(variant, 0.68 + lengthBoost(variant));
      }
    }
  }

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

  // Pattern C: brand+strength fused with no separator — e.g. "Dolo650", "Azithral500", "Metpure500"
  for (const match of String(text || '').matchAll(/\b([A-Za-z]{3,})([0-9]{2,4})\b/g)) {
    const brand = normalizeToken(match[1]);
    const dose = match[2];
    if (!looksLikeMedicine(brand)) continue;

    addCandidate(`${brand} ${dose}`, 0.78);
    addCandidate(`${brand}-${dose}`, 0.76);
    addCandidate(brand, 0.60 + lengthBoost(brand));
  }

  // Pattern D: ALL-CAPS single words — very common on Indian packaging (e.g. "DOLO", "CROCIN", "COMBIFLAM")
  // Use single-word capture only to avoid greedily eating stopwords (e.g. "COMBIFLAM TABLETS")
  for (const match of String(text || '').matchAll(/\b([A-Z]{3,})\b/g)) {
    const brand = normalizeToken(match[1]);
    if (!looksLikeMedicine(brand) || brand.length < 3) continue;
    // Score by line position: check if this match is on line 0
    const matchPos = match.index || 0;
    const firstNewline = String(text || '').indexOf('\n');
    const isFirstLine = firstNewline === -1 || matchPos < firstNewline;
    const posBonus = isFirstLine ? 0.20 : 0.05;
    addCandidate(brand, 0.72 + posBonus + lengthBoost(brand));
    // Title-cased version too
    const titled = brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase();
    addCandidate(titled, 0.70 + posBonus + lengthBoost(titled));
  }

  // Pattern D2: consecutive ALL-CAPS words as multi-word brand (e.g. "MONTAIR LC", "AUGMENTIN DUO")
  for (const match of String(text || '').matchAll(/\b([A-Z]{3,}(?:\s+[A-Z]{2,})+)\b/g)) {
    const raw = match[1].trim();
    const brand = normalizeToken(raw);
    // Must not be purely stopwords
    const parts = brand.toLowerCase().split(/\s+/);
    if (parts.every(p => OCR_STOPWORDS.has(p))) continue;
    if (brand.length < 4) continue;
    addCandidate(brand, 0.76 + lengthBoost(brand));
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
