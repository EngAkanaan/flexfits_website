export async function getProductRecommendation(prompt: string): Promise<string> {
  const normalizedPrompt = String(prompt || '').trim().slice(0, 1200);
  if (!normalizedPrompt) return 'Tell us what you are looking for and we will help you choose.';

  try {
    const response = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'recommendation',
        prompt: normalizedPrompt,
      }),
    });

    if (!response.ok) {
      return 'AI recommendations currently unavailable.';
    }

    const result = await response.json() as { ok?: boolean; text?: unknown };
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    return text || 'Something went wrong. Feel free to browse our authentic collections!';
  } catch {
    return 'Something went wrong. Feel free to browse our authentic collections!';
  }
}
