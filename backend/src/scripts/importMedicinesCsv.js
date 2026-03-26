import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from '../config/db.js';
import { env } from '../config/env.js';
import { Medicine } from '../models/Medicine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const toArray = (value) =>
  String(value || '')
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);

const parseCsv = (csv) => {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const cols = raw.split(',').map((c) => c.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    rows.push(row);
  }

  return rows;
};

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const run = async () => {
  await connectDB(env.mongoUri);

  const inputPath = process.argv[2] || path.join(__dirname, '../data/medicines.india.seed.csv');
  const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);

  const csv = await fs.readFile(absolutePath, 'utf8');
  const rows = parseCsv(csv);

  if (!rows.length) {
    console.log('No rows found in CSV.');
    process.exit(0);
  }

  let upserted = 0;
  for (const row of rows) {
    const name = row.name || row.medicineName || '';
    if (!name) continue;

    const doc = {
      name,
      genericName: row.genericName || '',
      aliases: toArray(row.aliases),
      category: row.category || '',
      manufacturer: row.manufacturer || '',
      dosage: row.dosage || '',
      uses: toArray(row.uses),
      sideEffects: toArray(row.sideEffects),
      alternatives: toArray(row.alternatives),
      barcode: row.barcode || ''
    };

    const key = normalizeName(doc.name);
    if (!key) continue;

    await Medicine.updateOne(
      { $or: [{ name: doc.name }, { aliases: doc.name }] },
      {
        $set: doc,
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    upserted += 1;
  }

  console.log(`Imported/updated ${upserted} medicines from CSV: ${absolutePath}`);
  process.exit(0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
