import mongoose from 'mongoose';

const searchHistorySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    query: { type: String, required: true },
    source: {
      type: String,
      enum: ['text', 'ocr', 'voice', 'barcode', 'chatbot', 'prescription'],
      default: 'text'
    },
    resultCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const SearchHistory = mongoose.model('SearchHistory', searchHistorySchema);