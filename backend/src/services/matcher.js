/**
 * matcher.js – Fuzzy + phonetic medicine matcher.
 *
 * Given OCR candidate strings, ranks them against the medicine database
 * using Fuse.js (fuzzy), string-similarity (Dice), Levenshtein, and
 * phonetic matching (Double Metaphone + Soundex from `natural`).
 *
 * Returns top-N matches with composite scores.
 */

import Fuse from 'fuse.js';
import stringSimilarity from 'string-similarity';
import natural from 'natural';
import { Medicine } from '../models/Medicine.js';
import { cacheService } from './cacheService.js';
import { normalizeKey } from './postProcess.js';
import { logger } from '../config/logger.js';

const { DoubleMetaphone, SoundEx } = natural;
const metaphone = new DoubleMetaphone();
const soundex = new SoundEx();

/* ── internal helpers ────────────────────────────────────────────────── */

const levenshtein = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
};

const levSimilarity = (a, b) => {
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / maxLen;
};

const phoneticMatch = (a, b) => {
  try {
    const ma = metaphone.process(a);
    const mb = metaphone.process(b);
    if (ma[0] === mb[0] || ma[0] === mb[1] || ma[1] === mb[0]) return 0.92;
    const sa = soundex.process(a);
    const sb = soundex.process(b);
    if (sa === sb) return 0.84;
  } catch { /* ignore */ }
  return 0;
};

/* ── Fuse.js index (cached in memory) ────────────────────────────────── */

let fuseIndex = null;
let fuseData = [];
let fuseBuiltAt = 0;
const FUSE_TTL_MS = 5 * 60 * 1000; // rebuild every 5 min

const buildFuseIndex = async () => {
  const now = Date.now();
  if (fuseIndex && now - fuseBuiltAt < FUSE_TTL_MS) return;

  fuseData = await Medicine.find({})
    .select('name genericName aliases category dosage uses sideEffects barcode')
    .lean();

  fuseIndex = new Fuse(fuseData, {
    keys: [
      { name: 'name', weight: 0.45 },
      { name: 'genericName', weight: 0.30 },
      { name: 'aliases', weight: 0.25 }
    ],
    threshold: 0.45,
    distance: 120,
    includeScore: true,
    minMatchCharLength: 3
  });

  fuseBuiltAt = now;
  logger.info(`Fuse index built with ${fuseData.length} medicines`);
};

/* ── composite scoring ───────────────────────────────────────────────── */

/**
 * Score a single candidate against a single medicine document.
 * Returns 0..1 composite.
 */
const compositeScore = (candidate, med) => {
  const normCand = normalizeKey(candidate);

  const targets = [
    med.name || '',
    med.genericName || '',
    ...(med.aliases || [])
  ].map((t) => normalizeKey(t)).filter(Boolean);

  let bestLev = 0;
  let bestDice = 0;
  let bestPhonetic = 0;

  for (const target of targets) {
    bestLev = Math.max(bestLev, levSimilarity(normCand, target));
    bestDice = Math.max(bestDice, stringSimilarity.compareTwoStrings(normCand, target));
    bestPhonetic = Math.max(bestPhonetic, phoneticMatch(normCand, target));

    // Prefix / contains bonuses
    if (target.startsWith(normCand) || normCand.startsWith(target)) {
      bestLev = Math.max(bestLev, 0.88);
    }
    if (target.includes(normCand) || normCand.includes(target)) {
      bestLev = Math.max(bestLev, 0.82);
    }
  }

  // Weighted composite: Levenshtein 35%, Dice 30%, Fuse/fuzzy 20%, Phonetic 15%
  // Fuse score is handled externally; we use Dice as proxy here
  return bestLev * 0.35 + bestDice * 0.35 + bestPhonetic * 0.30;
};

/* ── public API ──────────────────────────────────────────────────────── */

/**
 * Match OCR candidates against the medicine DB, return top-N results.
 *
 * @param {string[]} candidates – ranked OCR tokens
 * @param {object} [opts]
 * @param {number} [opts.limit=5] – how many matches to return
 * @param {number} [opts.minScore=0.52] – minimum composite score
 * @returns {Promise<Array<{ candidate, score, matchedBy, medicine }>>}
 */
export const matchCandidates = async (candidates, opts = {}) => {
  const limit = Number(opts.limit) || 5;
  const minScore = Number(opts.minScore) || 0.52;

  await buildFuseIndex();

  const cleaned = Array.from(
    new Set((candidates || []).map(normalizeKey).filter((c) => c.length >= 3))
  ).slice(0, 80);

  if (!cleaned.length) return [];

  const results = new Map(); // medicine _id → best result

  for (const candidate of cleaned) {
    // 1. Fuse.js fuzzy search
    const fuseResults = fuseIndex.search(candidate, { limit: 6 });

    for (const fr of fuseResults) {
      const med = fr.item;
      const fuseScore = 1 - (fr.score || 0); // Fuse returns 0=perfect
      const compScore = compositeScore(candidate, med);

      // Blend Fuse score + composite
      const finalScore = fuseScore * 0.35 + compScore * 0.65;

      if (finalScore < minScore) continue;

      const id = med._id.toString();
      const existing = results.get(id);
      if (!existing || finalScore > existing.score) {
        results.set(id, {
          candidate,
          score: Number(finalScore.toFixed(4)),
          matchedBy: 'fuzzy+phonetic',
          medicine: med
        });
      }
    }

    // 2. Direct composite scoring against full DB (for candidates Fuse misses)
    for (const med of fuseData) {
      const compScore = compositeScore(candidate, med);
      if (compScore < minScore) continue;

      const id = med._id.toString();
      const existing = results.get(id);
      if (!existing || compScore > existing.score) {
        results.set(id, {
          candidate,
          score: Number(compScore.toFixed(4)),
          matchedBy: 'composite',
          medicine: med
        });
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

/**
 * Autocomplete / suggestion helper: given OCR word tokens, return DB
 * medicines that begin with those prefixes.
 */
export const suggestFromTokens = async (tokens, opts = {}) => {
  const limit = Number(opts.limit) || 12;
  const suggestions = new Map();

  const cleanTokens = Array.from(
    new Set((tokens || []).map(normalizeKey).filter((t) => t.length >= 3))
  ).slice(0, 30);

  for (const token of cleanTokens) {
    const prefix = token.slice(0, 8);
    const cacheKey = `match:suggest:${prefix}`;
    let items = cacheService.get(cacheKey);

    if (!items) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      items = await Medicine.find({
        $or: [
          { name: { $regex: `^${escaped}`, $options: 'i' } },
          { genericName: { $regex: `^${escaped}`, $options: 'i' } },
          { aliases: { $regex: `^${escaped}`, $options: 'i' } }
        ]
      })
        .select('name genericName category')
        .limit(5)
        .lean();
      cacheService.set(cacheKey, items, 120);
    }

    for (const item of items) {
      if (!item?.name) continue;
      const key = item.name.toLowerCase();
      if (!suggestions.has(key)) {
        suggestions.set(key, {
          basedOn: token,
          name: item.name,
          genericName: item.genericName || '',
          category: item.category || ''
        });
      }
    }

    if (suggestions.size >= limit) break;
  }

  return Array.from(suggestions.values()).slice(0, limit);
};
