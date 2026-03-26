import jwt from 'jsonwebtoken';

export const signToken = (payload, secret, expiresIn) => jwt.sign(payload, secret, { expiresIn });

export const verifyToken = (token, secret) => jwt.verify(token, secret);