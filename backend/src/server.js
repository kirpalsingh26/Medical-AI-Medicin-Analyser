import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

const startServer = async () => {
  try {
    await connectDB(env.mongoUri);

    const server = app.listen(env.port, () => {
      logger.info(`MedVision backend running on port ${env.port}`);
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${env.port} is already in use. Stop the existing process and retry.`);
      } else {
        logger.error(`Server startup error: ${error.message}`);
      }
      process.exit(1);
    });
  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
};

startServer();