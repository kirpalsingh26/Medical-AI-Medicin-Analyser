import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  autocompleteMedicines,
  barcodeLookup,
  compareMedicines,
  medicineCatalog,
  ocrFeedback,
  ocrScan,
  searchMedicines
} from '../controllers/medicineController.js';
import { protect } from '../middleware/auth.js';

const router = Router();

router.get('/search', protect, asyncHandler(searchMedicines));
router.get('/autocomplete', protect, asyncHandler(autocompleteMedicines));
router.get('/catalog', protect, asyncHandler(medicineCatalog));
router.get('/barcode', protect, asyncHandler(barcodeLookup));
router.post('/compare', protect, asyncHandler(compareMedicines));
router.post('/ocr-scan', protect, asyncHandler(ocrScan));
router.post('/ocr-feedback', protect, asyncHandler(ocrFeedback));

export default router;