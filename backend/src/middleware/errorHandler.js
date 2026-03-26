import { logger } from '../config/logger.js';

export const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  logger.error(err.message, { stack: err.stack, statusCode });
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
};