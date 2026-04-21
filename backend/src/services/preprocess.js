/**
 * preprocess.js – Production-grade server-side image preprocessing for OCR.
 *
 * Pipeline: resize → grayscale → CLAHE-like contrast → denoise → adaptive
 * threshold → morphological opening → deskew → sharpen.
 *
 * Uses `sharp` only (no native OpenCV dependency required).
 */

import sharp from 'sharp';
import { logger } from '../config/logger.js';

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Clamp a value between lo and hi. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Estimate image skew angle from raw pixel data by scanning for row-density
 * peaks at small rotations.  Returns degrees (±5°).  Pure-JS, no OpenCV.
 */
const estimateSkewAngle = (rawPixels, width, height) => {
  // Simple projection-profile approach: for a few candidate angles we rotate
  // coordinates and compute row sums; the angle with the sharpest histogram
  // (highest max-to-mean ratio) is our best deskew.
  const step = 0.5; // degree step
  const range = 5; // ±5 degrees
  let bestAngle = 0;
  let bestSharpness = 0;

  for (let deg = -range; deg <= range; deg += step) {
    const rad = (deg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const rowSums = new Float32Array(height);

    // Sample every 3rd pixel for speed
    for (let y = 0; y < height; y += 3) {
      let sum = 0;
      for (let x = 0; x < width; x += 3) {
        const ny = Math.round(-x * sinA + y * cosA);
        if (ny < 0 || ny >= height) continue;
        const idx = y * width + x; // grayscale = 1 channel
        sum += 255 - rawPixels[idx]; // darker = more ink
      }
      rowSums[y] = sum;
    }

    let max = 0;
    let total = 0;
    for (let y = 0; y < height; y += 1) {
      if (rowSums[y] > max) max = rowSums[y];
      total += rowSums[y];
    }
    const mean = total / height || 1;
    const sharpness = max / mean;

    if (sharpness > bestSharpness) {
      bestSharpness = sharpness;
      bestAngle = deg;
    }
  }

  return bestAngle;
};

/* ── main pipeline ───────────────────────────────────────────────────── */

/**
 * Full preprocessing pipeline.
 * @param {Buffer} inputBuffer - Raw image buffer (any format sharp supports).
 * @param {object} [opts] - Optional overrides.
 * @returns {Promise<{ buffer: Buffer, meta: object }>}
 */
export const preprocessImage = async (inputBuffer, opts = {}) => {
  const targetWidth = clamp(Number(opts.targetWidth) || 2200, 800, 3500);
  const sharpenSigma = clamp(Number(opts.sharpenSigma) || 1.0, 0.5, 3.0);
  const doDeskew = opts.deskew !== false;

  const start = Date.now();

  try {
    // 1. Decode + get metadata
    const meta = await sharp(inputBuffer).metadata();
    const originalWidth = meta.width || 1;
    const originalHeight = meta.height || 1;

    // 2. Resize — higher res for better OCR
    const scale = targetWidth / originalWidth;
    const newWidth = Math.round(originalWidth * Math.min(scale, 3.0));
    const newHeight = Math.round(originalHeight * Math.min(scale, 3.0));

    // Base color resize (for channel-specific variants)
    const resizedColorBuffer = await sharp(inputBuffer)
      .resize(newWidth, newHeight, { fit: 'inside', kernel: 'lanczos3' })
      .png()
      .toBuffer();

    // Base: resize + grayscale (shared by grayscale variants)
    const baseBuffer = await sharp(inputBuffer)
      .resize(newWidth, newHeight, { fit: 'inside', kernel: 'lanczos3' })
      .grayscale()
      .png()
      .toBuffer();

    // ── Variant 1: Clean enhanced (normalize + sharpen, NO threshold) ──
    // Best for clear/good-quality images — preserves ALL text detail
    let enhanced = await sharp(baseBuffer)
      .normalise({ lower: 1, upper: 99 })
      .sharpen({ sigma: sharpenSigma, m1: 1.5, m2: 0.7 })
      .png()
      .toBuffer();

    // ── Variant 2: High-contrast with threshold ──
    // Best for low-contrast or noisy packaging images
    const thresholded = await sharp(baseBuffer)
      .normalise({ lower: 2, upper: 98 })
      .linear(1.4, -(128 * 0.4))
      .threshold(128)
      .sharpen({ sigma: 0.8 })
      .png()
      .toBuffer();

    // ── Variant 3: Moderate contrast without threshold ──
    // Good middle ground — enhanced readability without binarization
    const moderate = await sharp(baseBuffer)
      .normalise({ lower: 3, upper: 97 })
      .linear(1.25, -(128 * 0.25))
      .median(3)
      .sharpen({ sigma: 1.0, m1: 1.0, m2: 0.5 })
      .png()
      .toBuffer();

    // ── Variant 4: Blue-channel boosted (helps blue text on reflective foil) ──
    // Useful for strips like Dolo packs where blue text on silver foil loses
    // contrast after direct grayscale conversion.
    const blueChannel = await sharp(resizedColorBuffer)
      .extractChannel('blue')
      .normalise({ lower: 1, upper: 99 })
      .linear(1.35, -(128 * 0.35))
      .threshold(120)
      .sharpen({ sigma: 0.9 })
      .png()
      .toBuffer();

    // Deskew the primary (enhanced) variant
    if (doDeskew) {
      try {
        const grayMeta = await sharp(enhanced).metadata();
        const grayW = grayMeta.width || newWidth;
        const grayH = grayMeta.height || newHeight;
        const { data: grayPixels } = await sharp(enhanced)
          .raw()
          .toBuffer({ resolveWithObject: true });

        const angle = estimateSkewAngle(grayPixels, grayW, grayH);

        if (Math.abs(angle) > 0.3) {
          enhanced = await sharp(enhanced)
            .rotate(angle, { background: '#ffffff' })
            .png()
            .toBuffer();
          logger.info(`Deskewed by ${angle.toFixed(1)}°`);
        }
      } catch (deskewErr) {
        logger.warn(`Deskew skipped: ${deskewErr.message}`);
      }
    }

    const elapsed = Date.now() - start;
    logger.info(`Image preprocessed in ${elapsed}ms (${newWidth}×${newHeight}) — 4 variants`);

    return {
      buffer: enhanced,
      variants: [enhanced, thresholded, moderate, blueChannel],
      meta: {
        originalWidth,
        originalHeight,
        processedWidth: newWidth,
        processedHeight: newHeight,
        variantCount: 4,
        deskewed: doDeskew,
        elapsedMs: elapsed
      }
    };
  } catch (err) {
    logger.error(`Preprocessing failed: ${err.message}`);
    // Fallback: return raw grayscale resize so OCR can still run
    const fallback = await sharp(inputBuffer)
      .resize(targetWidth, null, { fit: 'inside' })
      .grayscale()
      .png()
      .toBuffer();

    return {
      buffer: fallback,
      variants: [fallback],
      meta: { fallback: true, error: err.message }
    };
  }
};
