import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { analyticsSummary, trackEvent } from '../controllers/analyticsController.js';
import { protect } from '../middleware/auth.js';

const router = Router();

router.post('/track', protect, asyncHandler(trackEvent));
router.get('/summary', protect, asyncHandler(analyticsSummary));

export default router;