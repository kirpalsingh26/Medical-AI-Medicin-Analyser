import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from '../config/db.js';
import { env } from '../config/env.js';
import { Medicine } from '../models/Medicine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const normalize = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const mergeByName = (medicines) => {
  const map = new Map();

  for (const med of medicines) {
    const key = normalize(med.name || med.genericName);
    if (!key) continue;

    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...med, aliases: Array.from(new Set(med.aliases || [])) });
      continue;
    }

    map.set(key, {
      ...prev,
      ...med,
      aliases: Array.from(new Set([...(prev.aliases || []), ...(med.aliases || [])]))
    });
  }

  return Array.from(map.values());
};

const run = async () => {
  await connectDB(env.mongoUri);

  const baseSeedPath = path.join(__dirname, '../data/medicines.seed.json');
  const indiaSeedPath = path.join(__dirname, '../data/medicines.india.seed.json');

  const [baseContent, indiaContent] = await Promise.all([
    fs.readFile(baseSeedPath, 'utf8'),
    fs.readFile(indiaSeedPath, 'utf8')
  ]);

  const baseMedicines = JSON.parse(baseContent);
  const indiaMedicines = JSON.parse(indiaContent);

  const merged = mergeByName([...baseMedicines, ...indiaMedicines]);

  await Medicine.deleteMany({});
  await Medicine.insertMany(merged, { ordered: false });

  console.log(`Seeded ${merged.length} medicines (base + India catalog).`);
  process.exit(0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
