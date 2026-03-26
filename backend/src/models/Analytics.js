import mongoose from 'mongoose';

const analyticsSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metadata: { type: Object, default: {} }
  },
  { timestamps: true }
);

export const Analytics = mongoose.model('Analytics', analyticsSchema);