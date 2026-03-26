import { Medicine } from '../models/Medicine.js';
import { cacheService } from './cacheService.js';

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const similarityScore = (candidate, target) => {
  const a = normalizeName(candidate);
  const b = normalizeName(target);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.86;

  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - distance / maxLen;
};

const overlap = (left = [], right = []) => {
  const a = new Set((left || []).map((x) => normalizeName(x)).filter(Boolean));
  const b = new Set((right || []).map((x) => normalizeName(x)).filter(Boolean));
  return [...a].filter((item) => b.has(item));
};

const overlapPercent = (left = [], right = []) => {
  const a = new Set((left || []).map((x) => normalizeName(x)).filter(Boolean));
  const b = new Set((right || []).map((x) => normalizeName(x)).filter(Boolean));
  const maxSize = Math.max(a.size, b.size, 1);
  const shared = [...a].filter((item) => b.has(item)).length;
  return Math.round((shared / maxSize) * 100);
};

const similarityPercent = (left, right) => {
  if (!left || !right) return 0;
  return Math.max(0, Math.min(100, Math.round(similarityScore(left, right) * 100)));
};

const hasSimilarText = (source = [], target = []) => {
  const sourceList = (source || []).map((x) => normalizeName(x)).filter(Boolean);
  const targetList = (target || []).map((x) => normalizeName(x)).filter(Boolean);
  if (!sourceList.length || !targetList.length) return false;

  return sourceList.some((left) =>
    targetList.some((right) => {
      if (left === right) return true;
      if (left.includes(right) || right.includes(left)) return true;
      return similarityScore(left, right) >= 0.82;
    })
  );
};

const findBestMatchForCompare = async (input) => {
  const normalized = normalizeName(input);
  if (!normalized) return { medicine: null, matchedBy: null };

  const safePattern = escapeRegex(normalized);

  const exactName = await Medicine.findOne({ name: { $regex: `^${safePattern}$`, $options: 'i' } }).lean();
  if (exactName) return { medicine: exactName, matchedBy: 'name-exact' };

  const exactAlias = await Medicine.findOne({ aliases: { $regex: `^${safePattern}$`, $options: 'i' } }).lean();
  if (exactAlias) return { medicine: exactAlias, matchedBy: 'alias-exact' };

  const exactGeneric = await Medicine.findOne({ genericName: { $regex: `^${safePattern}$`, $options: 'i' } }).lean();
  if (exactGeneric) return { medicine: exactGeneric, matchedBy: 'generic-exact' };

  const startsWith = await Medicine.findOne({
    $or: [
      { name: { $regex: `^${safePattern}`, $options: 'i' } },
      { aliases: { $regex: `^${safePattern}`, $options: 'i' } },
      { genericName: { $regex: `^${safePattern}`, $options: 'i' } }
    ]
  }).lean();
  if (startsWith) return { medicine: startsWith, matchedBy: 'prefix' };

  const loose = await Medicine.findOne({
    $or: [
      { name: { $regex: safePattern, $options: 'i' } },
      { aliases: { $regex: safePattern, $options: 'i' } },
      { genericName: { $regex: safePattern, $options: 'i' } }
    ]
  }).lean();
  if (loose) return { medicine: loose, matchedBy: 'contains' };

  return { medicine: null, matchedBy: null };
};

export const medicineService = {
  async search(query) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return [];

    const key = `med:search:${normalizedQuery.toLowerCase()}`;
    const cached = cacheService.get(key);
    if (cached) return cached;

    const safeQuery = escapeRegex(normalizedQuery);

    const result = await Medicine.find({
      $or: [
        { name: { $regex: safeQuery, $options: 'i' } },
        { genericName: { $regex: safeQuery, $options: 'i' } },
        { aliases: { $regex: safeQuery, $options: 'i' } },
        { category: { $regex: safeQuery, $options: 'i' } }
      ]
    })
      .limit(20)
      .lean();

    cacheService.set(key, result);
    return result;
  },

  async autocomplete(query, { limit = 8, includeAll = false } = {}) {
    const normalizedQuery = String(query || '').trim();
    const safeQuery = escapeRegex(normalizedQuery);

    if (!normalizedQuery && !includeAll) return [];

    const maxLimit = Math.min(Math.max(Number(limit) || 8, 1), 2000);

    const filter = !normalizedQuery
      ? {}
      : {
          $or: [
          { name: { $regex: `^${safeQuery}`, $options: 'i' } },
          { aliases: { $regex: `^${safeQuery}`, $options: 'i' } },
          { genericName: { $regex: `^${safeQuery}`, $options: 'i' } }
        ]
      };

    return Medicine.find(filter)
      .sort({ name: 1 })
      .select('name genericName category')
      .limit(maxLimit)
      .lean();
  },

  async listCatalog(limit = 200) {
    const maxLimit = Math.min(Math.max(Number(limit) || 200, 1), 2000);

    return Medicine.find({})
      .sort({ name: 1 })
      .select('name genericName category aliases')
      .limit(maxLimit)
      .lean();
  },

  async findByBarcode(barcode) {
    return Medicine.findOne({ barcode }).lean();
  },

  async compare(medicineA, medicineB) {
    const [resolvedA, resolvedB] = await Promise.all([
      findBestMatchForCompare(medicineA),
      findBestMatchForCompare(medicineB)
    ]);

    const a = resolvedA.medicine;
    const b = resolvedB.medicine;

    const sideEffectOverlap = overlap(a?.sideEffects, b?.sideEffects);
    const useOverlap = overlap(a?.uses, b?.uses);
    const alternativeOverlap = overlap(a?.alternatives, b?.alternatives);

    const bIdentityTokens = [b?.name, b?.genericName, ...(b?.aliases || [])].filter(Boolean);
    const aIdentityTokens = [a?.name, a?.genericName, ...(a?.aliases || [])].filter(Boolean);
    const aMentionsBAsAlternative = hasSimilarText(a?.alternatives || [], bIdentityTokens);
    const bMentionsAAsAlternative = hasSimilarText(b?.alternatives || [], aIdentityTokens);
    const alternativeCrossReference = aMentionsBAsAlternative || bMentionsAAsAlternative;

    const categoryMatch = a?.category && b?.category ? normalizeName(a.category) === normalizeName(b.category) : false;
    const genericMatch =
      a?.genericName && b?.genericName
        ? normalizeName(a.genericName) === normalizeName(b.genericName)
        : false;

    const categorySimilarity = similarityPercent(a?.category, b?.category);
    const genericSimilarity = similarityPercent(a?.genericName, b?.genericName);
    const sideEffectOverlapPercent = overlapPercent(a?.sideEffects, b?.sideEffects);
    const useOverlapPercent = overlapPercent(a?.uses, b?.uses);
    const alternativeOverlapPercent = overlapPercent(a?.alternatives, b?.alternatives);
    const alternativeSimilarity = Math.max(alternativeOverlapPercent, alternativeCrossReference ? 100 : 0);

    const overallSimilarity = Math.round(
      categorySimilarity * 0.22 +
        genericSimilarity * 0.32 +
        useOverlapPercent * 0.22 +
        sideEffectOverlapPercent * 0.14 +
        alternativeSimilarity * 0.1
    );

    return {
      a,
      b,
      meta: {
        inputA: medicineA,
        inputB: medicineB,
        matchedByA: resolvedA.matchedBy,
        matchedByB: resolvedB.matchedBy
      },
      comparison: {
        sameCategory: categoryMatch,
        sameGeneric: genericMatch,
        sideEffectOverlap,
        useOverlap,
        alternativeOverlap,
        alternativeCrossReference,
        alternativeCrossReferenceDetails: {
          aMentionsBAsAlternative,
          bMentionsAAsAlternative
        },
        scores: {
          categorySimilarity,
          genericSimilarity,
          sideEffectOverlapPercent,
          useOverlapPercent,
          alternativeOverlapPercent,
          alternativeSimilarity,
          overallSimilarity
        }
      }
    };
  },

  async matchBestFromCandidates(candidates, limit = 8) {
    const cleanedCandidates = Array.from(
      new Set((candidates || []).map((c) => normalizeName(c)).filter((c) => c.length >= 3))
    ).slice(0, 60);

    if (!cleanedCandidates.length) return [];

    const medicines = await Medicine.find({})
      .select('name genericName aliases category dosage uses sideEffects barcode')
      .lean();
    const matched = [];

    for (const candidate of cleanedCandidates) {
      let best = null;
      let bestScore = 0;

      for (const med of medicines) {
        const aliasBest = (med.aliases || []).reduce((best, alias) => {
          return Math.max(best, similarityScore(candidate, alias));
        }, 0);

        const score = Math.max(
          similarityScore(candidate, med.name),
          similarityScore(candidate, med.genericName || ''),
          aliasBest
        );
        if (score > bestScore) {
          bestScore = score;
          best = med;
        }
      }

      if (best && bestScore >= 0.64) {
        matched.push({ candidate, score: Number(bestScore.toFixed(3)), medicine: best });
      }
    }

    const uniqueByMedicine = new Map();
    for (const item of matched.sort((a, b) => b.score - a.score)) {
      if (!uniqueByMedicine.has(item.medicine._id.toString())) {
        uniqueByMedicine.set(item.medicine._id.toString(), item);
      }
    }

    return Array.from(uniqueByMedicine.values()).slice(0, limit);
  }
};