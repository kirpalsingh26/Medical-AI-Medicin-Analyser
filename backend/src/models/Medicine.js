import mongoose from 'mongoose';

const medicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    genericName: String,
    aliases: [String],
    category: String,
    manufacturer: String,
    dosage: String,
    uses: [String],
    sideEffects: [String],
    alternatives: [String],
    barcode: { type: String, index: true }
  },
  { timestamps: true }
);

medicineSchema.index({ name: 'text', genericName: 'text', aliases: 'text', category: 'text' });

export const Medicine = mongoose.model('Medicine', medicineSchema);