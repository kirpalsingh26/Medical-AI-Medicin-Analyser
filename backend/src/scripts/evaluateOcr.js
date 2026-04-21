/**
 * evaluateOcr.js – Evaluate the OCR pipeline on a labelled test set.
 *
 * Usage:
 *   node src/scripts/evaluateOcr.js [path/to/testset.json]
 *
 * Test-set format (JSON array):
 * [
 *   { "image": "path/to/image.jpg", "expected": ["Paracetamol", "Dolo 650"] },
 *   ...
 * ]
 *
 * If no test-set file is given, runs a synthetic test with sample data.
 *
 * Reports top-1, top-3, top-5 accuracy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

import mongoose from 'mongoose';
import { ocrService } from '../services/ocrService.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/* ── helpers ─────────────────────────────────────────────────────────── */

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

const isMatch = (expected, detected) => {
  const e = normalize(expected);
  if (!e) return false;
  return detected.some((d) => {
    const n = normalize(d);
    return n === e || n.includes(e) || e.includes(n);
  });
};

const hitAtK = (expectedList, detectedNames, k) => {
  const topK = detectedNames.slice(0, k);
  return expectedList.some((exp) => isMatch(exp, topK));
};

/* ── main ────────────────────────────────────────────────────────────── */

const run = async () => {
  const testSetPath = process.argv[2];

  let testSet;
  if (testSetPath) {
    const raw = fs.readFileSync(testSetPath, 'utf-8');
    testSet = JSON.parse(raw);
  } else {
    // Provide a synthetic example so the script always runs
    logger.info('No test-set file provided – running synthetic demo test.');
    testSet = [
      {
        image: null,
        text: 'Dolo 650 Tablet\nParacetamol 650mg\nMicro Labs Ltd',
        expected: ['Dolo 650', 'Paracetamol']
      },
      {
        image: null,
        text: 'Azithromycin 500mg Tablets IP\nZithromax',
        expected: ['Azithromycin', 'Zithromax']
      },
      {
        image: null,
        text: 'Amoxicillin Capsules IP 500mg\nCipmox 500',
        expected: ['Amoxicillin', 'Cipmox']
      }
    ];
  }

  // Connect to DB for matching
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000, family: 4 });
  logger.info(`Connected to MongoDB. Evaluating ${testSet.length} samples…`);

  const stats = { total: 0, hit1: 0, hit3: 0, hit5: 0 };
  const details = [];

  for (const sample of testSet) {
    stats.total += 1;

    let pipelineResult;

    if (sample.image) {
      // Real image file
      const imgPath = path.resolve(path.dirname(testSetPath || '.'), sample.image);
      const imgBuffer = fs.readFileSync(imgPath);
      pipelineResult = await ocrService.fullPipeline(imgBuffer, 'eng', { mode: 'accurate' });
    } else if (sample.text) {
      // Synthetic: skip OCR, go straight to post-process + match
      const { postProcessOcr } = await import('../services/postProcess.js');
      const { matchCandidates, suggestFromTokens } = await import('../services/matcher.js');

      const fakeOcrResult = {
        text: sample.text,
        confidence: 80,
        words: sample.text.split(/\s+/).map((t) => ({ text: t, confidence: 80 }))
      };
      const pp = postProcessOcr(fakeOcrResult);
      const matches = await matchCandidates([...pp.candidates, ...pp.wordTokens], { limit: 5 });

      pipelineResult = {
        candidates: pp.candidates,
        detectedMedicines: matches.map((m) => ({
          candidate: m.candidate,
          score: m.score,
          medicine: m.medicine
        }))
      };
    } else {
      logger.warn(`Sample #${stats.total} has no image or text, skipping`);
      continue;
    }

    // Collect detected names (from detectedMedicines + candidates)
    const detectedNames = [
      ...(pipelineResult.detectedMedicines || []).map((d) => d.medicine?.name || d.candidate),
      ...(pipelineResult.candidates || []).slice(0, 10)
    ];

    const h1 = hitAtK(sample.expected, detectedNames, 1);
    const h3 = hitAtK(sample.expected, detectedNames, 3);
    const h5 = hitAtK(sample.expected, detectedNames, 5);

    if (h1) stats.hit1 += 1;
    if (h3) stats.hit3 += 1;
    if (h5) stats.hit5 += 1;

    details.push({
      expected: sample.expected,
      detected: detectedNames.slice(0, 5),
      top1: h1,
      top3: h3,
      top5: h5
    });
  }

  // Report
  console.log('\n═══════════════════════════════════════════');
  console.log('  OCR PIPELINE EVALUATION REPORT');
  console.log('═══════════════════════════════════════════');
  console.log(`  Samples : ${stats.total}`);
  console.log(`  Top-1   : ${stats.hit1}/${stats.total} = ${((stats.hit1 / stats.total) * 100).toFixed(1)}%`);
  console.log(`  Top-3   : ${stats.hit3}/${stats.total} = ${((stats.hit3 / stats.total) * 100).toFixed(1)}%`);
  console.log(`  Top-5   : ${stats.hit5}/${stats.total} = ${((stats.hit5 / stats.total) * 100).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════\n');

  for (let i = 0; i < details.length; i += 1) {
    const d = details[i];
    const status = d.top1 ? '✅' : d.top3 ? '🟡' : d.top5 ? '🔶' : '❌';
    console.log(`  ${status} Sample ${i + 1}: expected=${JSON.stringify(d.expected)}`);
    console.log(`       detected=${JSON.stringify(d.detected)}`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Evaluation failed:', err.message);
  process.exit(1);
});
