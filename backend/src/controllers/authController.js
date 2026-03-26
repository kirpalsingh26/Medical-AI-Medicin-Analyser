import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { signToken } from '../utils/jwt.js';
import { AppError } from '../utils/AppError.js';

const tokenResponse = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  preferredLanguage: user.preferredLanguage,
  token: signToken({ id: user._id }, env.jwtSecret, env.jwtExpiresIn)
});

export const register = async (req, res, next) => {
  const { name, email, password } = req.body;
  const exists = await User.findOne({ email });
  if (exists) return next(new AppError('Email already in use', 409));

  const hash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email, password: hash });
  return res.status(201).json({ success: true, data: tokenResponse(user) });
};

export const login = async (req, res, next) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return next(new AppError('Invalid credentials', 401));

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return next(new AppError('Invalid credentials', 401));

  return res.status(200).json({ success: true, data: tokenResponse(user) });
};

export const me = async (req, res) => {
  res.status(200).json({ success: true, data: req.user });
};