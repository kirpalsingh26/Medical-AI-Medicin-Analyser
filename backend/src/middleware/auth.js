import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { verifyToken } from '../utils/jwt.js';
import { AppError } from '../utils/AppError.js';

export const protect = async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('Unauthorized', 401));
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token, env.jwtSecret);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return next(new AppError('User not found', 404));
    return next();
  } catch {
    return next(new AppError('Invalid or expired token', 401));
  }
};