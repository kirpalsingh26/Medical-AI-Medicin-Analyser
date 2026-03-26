import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    preferredLanguage: { type: String, default: 'en-US' }
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);