/**
 * ocrService.js – Production-grade multi-pass Tesseract OCR service.
 *
 * Features:
 *  • Server-side preprocessing via preprocess.js (sharp).
 *  • Multi-pass recognition: PSM 3, 4, 6, 11 with OEM 1 (LSTM).
 *  • Multi-language support (eng, eng+hin).
 *  • Confidence-based result merging across passes.
 *  • Post-processing via postProcess.js.
 *  • Fuzzy + phonetic matching via matcher.js.
 *  • Hybrid fallback stub (low-confidence → cloud OCR if configured).
 */

import Tesseract from 'tesseract.js';
import { preprocessImage } from './preprocess.js';
import { postProcessOcr } from './postProcess.js';
import { matchCandidates, suggestFromTokens } from './matcher.js';
import { logger } from '../config/logger.js';

/* ── constants ───────────────────────────────────────────────────────── */

/** Page segmentation modes to try (ordered by typical usefulness). */
const PSM_MODES = [6, 3, 4, 11];

/** Minimum overall confidence to accept without fallback. */
const CONFIDENCE_FALLBACK_THRESHOLD = 35;

/* ── internal helpers ────────────────────────────────────────────────── */

/**
 * Run a single Tesseract recognition pass.
 */
const recognizePass = async (imageBuffer, lang, psm, oem = 1) => {
  try {
    const { data } = await Tesseract.recognize(imageBuffer, lang, {
      tessedit_pageseg_mode: String(psm),
      tessedit_ocr_engine_mode: String(oem),
      preserve_interword_spaces: '1'
    });
    return data;
  } catch (err) {
    logger.warn(`Tesseract pass PSM=${psm} OEM=${oem} failed: ${err.message}`);
    return null;
  }
};

/**
 * Merge word-level results from multiple passes.
 * For duplicate words keeps the one with higher confidence.
 */
const mergePassResults = (passes) => {
  const validPasses = passes.filter(Boolean);
  if (!validPasses.length) {
    return { text: '', confidence: 0, words: [], passCount: 0, bestPassConfidence: 0 };
  }

  validPasses.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const best = validPasses[0];

  const wordMap = new Map();
  for (const pass of validPasses) {
    for (const w of pass.words || []) {
      const key = (w.text || '').toLowerCase().trim();
      if (!key) continue;
      const existing = wordMap.get(key);
      if (!existing || (w.confidence || 0) > (existing.confidence || 0)) {
        wordMap.set(key, w);
      }
    }
  }

  const mergedWords = Array.from(wordMap.values());
  const avgConfidence = mergedWords.length > 0
    ? mergedWords.reduce((s, w) => s + (w.confidence || 0), 0) / mergedWords.length
    : best.confidence || 0;

  const lineSet = new Set();
  let combinedText = '';
  for (const pass of validPasses) {
    for (const line of (pass.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const key = line.toLowerCase();
      if (!lineSet.has(key)) {
        lineSet.add(key);
        combinedText += line + '\n';
      }
    }
  }

  return {
    text: combinedText.trim(),
    confidence: Number(avgConfidence.toFixed(2)),
    words: mergedWords.map((w) => ({
      text: w.text || '',
      confidence: Number((w.confidence || 0).toFixed(2))
    })),
    passCount: validPasses.length,
    bestPassConfidence: Number((best.confidence || 0).toFixed(2))
  };
};

/* ── cloud OCR fallback stub ─────────────────────────────────────────── */

/**
 * Fallback to Google Vision when Tesseract confidence is below threshold.
 * Set GOOGLE_VISION_API_KEY in .env to enable.
 */
const cloudOcrFallback = async (imageBuffer, _lang) => {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return null;

  try {
    const base64 = imageBuffer.toString('base64');
    const body = {
      requests: [{
        image: { content: base64 },
        features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
      }]
    };

    const resp = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    if (!resp.ok) {
      logger.warn(`Cloud OCR HTTP ${resp.status}`);
      return null;
    }

    const json = await resp.json();
    const annotation = json.responses?.[0]?.fullTextAnnotation;
    if (!annotation) return null;

    logger.info('Cloud OCR fallback returned text');
    return {
      text: annotation.text || '',
      confidence: 85,
      words: (annotation.text || '').split(/\s+/).map((t) => ({ text: t, confidence: 85 }))
    };
  } catch (err) {
    logger.warn(`Cloud OCR fallback error: ${err.message}`);
    return null;
  }
};

/* ── public API ──────────────────────────────────────────────────────── */

export const ocrService = {
  /**
   * Full OCR pipeline: preprocess → multi-pass Tesseract → merge →
   * optional cloud fallback → post-process → fuzzy match.
   */
  async fullPipeline(rawImageBuffer, lang = 'eng', opts = {}) {
    const start = Date.now();
    const mode = opts.mode || 'balanced';

    // 1. Preprocess — returns multiple image variants
    const { buffer: preprocessedBuffer, variants = [], meta: preprocessMeta } =
      await preprocessImage(rawImageBuffer, opts.preprocessOpts);

    // 2. Multi-pass Tesseract across preprocessing variants
    let psmModes;
    if (mode === 'fast') {
      psmModes = [6];
    } else if (mode === 'accurate') {
      psmModes = PSM_MODES;
    } else {
      psmModes = [6, 3, 11];
    }

    const imagesToProcess = variants.length > 0 ? variants : [preprocessedBuffer];

    // Primary passes: all PSM modes on the best variant
    const primaryPasses = await Promise.all(
      psmModes.map((psm) => recognizePass(imagesToProcess[0], lang, psm, 1))
    );

    // Supplementary passes: PSM 6 on remaining variants for extra coverage.
    const supplementaryPasses = await Promise.all(
      imagesToProcess.slice(1).map((v) => recognizePass(v, lang, 6, 1))
    );

    const allPasses = [...primaryPasses, ...supplementaryPasses];

    const merged = mergePassResults(allPasses);

    // 3. Hybrid fallback
    let fallbackUsed = false;
    if (merged.confidence < CONFIDENCE_FALLBACK_THRESHOLD) {
      logger.info(`Confidence ${merged.confidence}% below threshold, trying cloud fallback…`);
      const cloudResult = await cloudOcrFallback(preprocessedBuffer, lang);
      if (cloudResult) {
        const cloudMerged = mergePassResults([
          { text: merged.text, confidence: merged.confidence, words: merged.words },
          { text: cloudResult.text, confidence: cloudResult.confidence, words: cloudResult.words }
        ]);
        Object.assign(merged, cloudMerged);
        fallbackUsed = true;
      }
    }

    // 4. Post-process
    const postProcessed = postProcessOcr(merged, {
      minWordConfidence: opts.minWordConfidence,
      maxNgram: opts.maxNgram
    });

    // 5. Fuzzy + phonetic matching
    const matchLimit = Number(opts.matchLimit) || 5;
    const topMatches = await matchCandidates(
      [...postProcessed.candidates, ...postProcessed.wordTokens],
      { limit: matchLimit, minScore: 0.42 }
    );

    // 6. Suggestions
    const suggestions = await suggestFromTokens(
      [...postProcessed.wordTokens, ...postProcessed.candidates],
      { limit: 12 }
    );

    const elapsed = Date.now() - start;
    logger.info(`OCR pipeline completed in ${elapsed}ms, ${topMatches.length} matches, confidence=${merged.confidence}%`);

    return {
      confidence: merged.confidence,
      bestPassConfidence: merged.bestPassConfidence,
      passCount: merged.passCount,
      fallbackUsed,
      ocrMode: mode,
      preprocessMeta,
      candidates: postProcessed.candidates,
      wordTokens: postProcessed.wordTokens,
      rawText: postProcessed.rawText,
      detectedMedicines: topMatches.map((m) => ({
        candidate: m.candidate,
        score: m.score,
        matchedBy: m.matchedBy,
        medicine: m.medicine
      })),
      suggestions,
      elapsedMs: elapsed
    };
  },

  /**
   * Legacy compatibility wrapper.
   */
  async extractMedicineCandidates(imageBuffer, lang = 'eng', options = {}) {
    return this.fullPipeline(imageBuffer, lang, options);
  }
};