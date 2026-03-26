import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { alternativeSuggestions, chatbot, generateInsights } from '../controllers/aiController.js';
import { protect } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.post('/insights', protect, aiLimiter, asyncHandler(generateInsights));
router.post('/alternatives', protect, aiLimiter, asyncHandler(alternativeSuggestions));
router.post('/chat', protect, aiLimiter, asyncHandler(chatbot));

export default router;