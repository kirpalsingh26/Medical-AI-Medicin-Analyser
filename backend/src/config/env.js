import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root workspace .env regardless of current working directory.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
// Optional fallback to backend/.env if present.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });

export const env = {
  port: process.env.PORT || 5000,
  mongoUri:
    process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/medvision',
  jwtSecret: process.env.JWT_SECRET || 'dev_secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  clientUrls: process.env.CLIENT_URLS || '',
  cacheTTLSeconds: Number(process.env.CACHE_TTL_SECONDS || 300)
};