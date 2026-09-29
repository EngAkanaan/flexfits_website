import { GoogleGenAI } from '@google/genai';
import { allowMethod, assertAllowedKeys, getClientIp, normalizePlainObject, normalizeText, rateLimit, readJsonBody, sendJson, withTimeout } from './_lib/security';

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const DEFAULT_TIMEOUT_MS = 9000;
const MAX_BODY_BYTES = 24 * 1024;
const MAX_PROMPT_LENGTH = 1200;
const MAX_RESPONSE_LENGTH = 900;

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

function sanitizePrompt(body: unknown): string {
  const payload = normalizePlainObject(body);
  assertAllowedKeys(payload, ['operation', 'prompt']);
  const operation = normalizeText(payload.operation || 'recommendation', 32);
  if (operation !== 'recommendation') {
    throw new Error('Unsupported operation.');
  }

  const prompt = normalizeText(payload.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) {
    throw new Error('Prompt is required.');
  }

  return prompt;
}

export default async function handler(req: any, res: any): Promise<void> {
  if (!allowMethod(req, res, ['POST'])) return;

  const rate = rateLimit(`gemini:${getClientIp(req)}`, 12, 60_000);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    sendJson(res, 429, { ok: false, error: 'Too many requests.' });
    return;
  }

  if (!ai) {
    sendJson(res, 503, { ok: false, error: 'AI service unavailable.' });
    return;
  }

  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const prompt = sanitizePrompt(body);

    const result = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `You are an AI assistant for "FLEX Fits", a premium retail brand specializing in 100% authentic footwear and apparel.\nThe customer wants to know: ${prompt}.\nGive a short, professional, and sophisticated recommendation about our products (Shoes, Tshirts, Socks, Hoodies).\nStrongly emphasize that everything we sell is real, authentic, and never a copy. Keep it under 60 words.`,
      }),
      DEFAULT_TIMEOUT_MS,
      'Gemini request'
    );

    const text = normalizeText(result.text || 'Something went wrong. Feel free to browse our authentic collections!', MAX_RESPONSE_LENGTH);
    sendJson(res, 200, { ok: true, text: text || 'Something went wrong. Feel free to browse our authentic collections!' });
  } catch {
    sendJson(res, 400, { ok: false, error: 'Unable to generate recommendation.' });
  }
}
