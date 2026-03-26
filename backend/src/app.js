import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes from './routes/authRoutes.js';
import medicineRoutes from './routes/medicineRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';

import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { env } from './config/env.js';

const app = express();

const allowedOrigins = new Set(
  [env.clientUrl, ...String(env.clientUrls || '').split(',')]
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;

  // Allow Vite localhost dynamic ports (e.g. 5173-5199) during development.
  if (/^https?:\/\/(localhost|127\.0\.0\.1):51\d{2}$/.test(origin)) return true;

  return false;
};

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error('CORS not allowed'));
    }
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use(apiLimiter);

app.get('/api/health', (_req, res) => {
  res.status(200).json({ success: true, message: 'MedVision API healthy' });
});

app.use('/api/auth', authRoutes);
app.use('/api/medicines', medicineRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analytics', analyticsRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;