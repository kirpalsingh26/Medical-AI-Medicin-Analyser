import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

await connectDB(env.mongoUri);

app.listen(env.port, () => {
  logger.info(`MedVision backend running on port ${env.port}`);
});