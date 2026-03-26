import NodeCache from 'node-cache';
import { env } from '../config/env.js';

const cache = new NodeCache({ stdTTL: env.cacheTTLSeconds, checkperiod: 60 });

export const cacheService = {
  get: (key) => cache.get(key),
  set: (key, value, ttl = env.cacheTTLSeconds) => cache.set(key, value, ttl),
  del: (key) => cache.del(key),
  flush: () => cache.flushAll()
};