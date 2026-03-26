import mongoose from 'mongoose';
import { logger } from './logger.js';

export const connectDB = async (mongoUri) => {
  try {
    await mongoose.connect(mongoUri);
    logger.info('MongoDB connected');
  } catch (error) {
    logger.error(`MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};