import app from './app.js';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

const listenWithFallback = (preferredPort, maxAttempts = 20) =>
  new Promise((resolve, reject) => {
    const basePort = Number(preferredPort) || 5000;

    const tryPort = (offset) => {
      const port = basePort + offset;
      const server = app.listen(port, () => {
        resolve({ server, port, preferredPort: basePort });
      });

      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE' && offset < maxAttempts) {
          logger.warn(`Port ${port} is already in use. Trying port ${port + 1}...`);
          return tryPort(offset + 1);
        }
        return reject(error);
      });
    };

    tryPort(0);
  });

const startServer = async () => {
  try {
    await connectDB(env.mongoUri);

    const { server, port, preferredPort } = await listenWithFallback(env.port);

    if (port !== preferredPort) {
      logger.warn(`Preferred port ${preferredPort} was busy. Running on fallback port ${port}.`);
    }

    logger.info(`MedVision backend running on port ${port}`);

    server.on('error', (error) => {
      logger.error(`Server runtime error: ${error.message}`);
    });
  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
};

startServer();