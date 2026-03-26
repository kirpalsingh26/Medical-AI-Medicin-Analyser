import { analyticsService } from '../services/analyticsService.js';

export const trackEvent = async (req, res) => {
  const { event, metadata } = req.body;
  const data = await analyticsService.track(event, req.user?._id, metadata);
  res.status(201).json({ success: true, data });
};

export const analyticsSummary = async (_req, res) => {
  const data = await analyticsService.summary();
  res.status(200).json({ success: true, data });
};