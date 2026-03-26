import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_PRIORITY = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-flash'];
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache = { models: [], expiresAt: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const listGenerateContentModels = async () => {
  const now = Date.now();
  if (modelsCache.expiresAt > now && modelsCache.models.length) {
    return modelsCache.models;
  }

  const response = await fetch(`${GEMINI_BASE_URL}?key=${env.geminiApiKey}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini model listing failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const models = (data?.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);

  const prioritized = [
    ...MODEL_PRIORITY.filter((name) => models.includes(name)),
    ...models.filter((name) => !MODEL_PRIORITY.includes(name))
  ];

  modelsCache = {
    models: prioritized,
    expiresAt: now + MODELS_CACHE_TTL_MS
  };

  return prioritized;
};

export const geminiService = {
  async generate(prompt, options = {}) {
    if (!env.geminiApiKey) {
      throw new AppError('Gemini API key is missing', 500);
    }

    const retries = options.retries ?? 3;
    const initialBackoff = options.initialBackoff ?? 800;
    const temperature = options.temperature ?? 0.5;
    const maxOutputTokens = options.maxOutputTokens ?? 700;

    const candidateModels = await listGenerateContentModels();
    if (!candidateModels.length) {
      throw new AppError('No compatible Gemini models available for generateContent', 502);
    }

    let lastError = null;

    for (const model of candidateModels) {
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${env.geminiApiKey}`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(options.systemInstruction
                ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
                : {}),
              contents: [
                {
                  parts: [{ text: prompt }]
                }
              ],
              generationConfig: {
                temperature,
                maxOutputTokens
              }
            })
          });

          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini ${model} failed (${response.status}): ${errorBody}`);
          }

          const data = await response.json();
          const text =
            data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') ||
            'No AI response generated.';

          return text;
        } catch (error) {
          lastError = error;
          if (attempt < retries) {
            await sleep(initialBackoff * attempt);
          }
        }
      }
    }

    throw new AppError(`Gemini failed after retries: ${lastError?.message || 'Unknown error'}`, 502);
  }
};