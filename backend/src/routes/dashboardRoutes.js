import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { deleteRecentSearch, myDashboard } from '../controllers/dashboardController.js';
import { protect } from '../middleware/auth.js';

const router = Router();

router.get('/me', protect, asyncHandler(myDashboard));
router.delete('/search/:id', protect, asyncHandler(deleteRecentSearch));

export default router;