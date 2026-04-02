import mongoose from 'mongoose';
import { logger } from './logger.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const connectDB = async (mongoUri) => {
  const maxAttempts = Number(process.env.MONGO_RETRY_ATTEMPTS || 5);
  const baseDelayMs = Number(process.env.MONGO_RETRY_DELAY_MS || 2000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000,
        family: 4
      });
      logger.info('MongoDB connected');
      return;
    } catch (error) {
      const remaining = maxAttempts - attempt;
      logger.error(
        `MongoDB connection failed (attempt ${attempt}/${maxAttempts}): ${error.message}`
      );

      if (remaining <= 0) {
        throw new Error(
          `Unable to connect to MongoDB after ${maxAttempts} attempts. Check MONGODB_URI and network/DNS.`
        );
      }

      await wait(baseDelayMs * attempt);
    }
  }

  throw new Error('Unable to connect to MongoDB');
};