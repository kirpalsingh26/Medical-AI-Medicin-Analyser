import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from '../config/db.js';
import { env } from '../config/env.js';
import { Medicine } from '../models/Medicine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const run = async () => {
  await connectDB(env.mongoUri);
  const filePath = path.join(__dirname, '../data/medicines.seed.json');
  const content = await fs.readFile(filePath, 'utf8');
  const medicines = JSON.parse(content);

  await Medicine.deleteMany({});
  await Medicine.insertMany(medicines);
  console.log(`Seeded ${medicines.length} medicines.`);
  process.exit(0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});