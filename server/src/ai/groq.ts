/**
 * Groq is used ONLY to help admins word email templates. It never receives
 * employee names, emails or hours: only template text with placeholders intact.
 */
import type { AiAssistKind } from '../../../shared/settings';
import { placeholdersIn } from '../../../shared/templates';
import { describeStatus, ProbeError, request, type FetchFn, type ProbeResult } from '../testers/http';

const API = 'https://api.groq.com/openai/v1';

export async function testGroq(apiKey: string | undefined, model: string, fetchFn: FetchFn): Promise<ProbeResult> {
  const key = apiKey?.trim();
  if (!key) throw new ProbeError('Enter the Groq API key.');
  if (!key.startsWith('gsk_')) throw new ProbeError('Groq keys start with gsk_. Check that you copied the whole key.');
  const r = await request(fetchFn, `${API}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (r.status !== 200) return { ok: false, message: describeStatus(r.status, 'API key') };
  const ids = ((r.body as { data?: { id: string }[] })?.data ?? []).map((m) => m.id);
  return ids.includes(model)
    ? { ok: true, message: `Key works and ${model} is available.` }
    : { ok: false, message: `Key works, but ${model} is not available to this account. Pick another model.` };
}

const INSTRUCTIONS: Record<AiAssistKind, string> = {
  polish: 'Fix grammar, spelling and clarity. Keep the meaning, structure and length about the same.',
  shorten: 'Make it noticeably shorter and easier to read on a phone. Keep every instruction that matters.',
  firm: 'Make the tone firmer and more direct, while staying professional and polite.',
  friendly: 'Make the tone warmer and friendlier, while staying professional.',
};

export async function assist(
  kind: AiAssistKind,
  text: string,
  apiKey: string,
  model: string,
  fetchFn: FetchFn,
): Promise<string> {
  const r = await request(fetchFn, `${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'You edit corporate email templates. Words in curly braces such as {week_start} are placeholders: ' +
            'copy every placeholder exactly, keep them all, and never add new ones. Keep bullet lines starting with "•". ' +
            'Return only the rewritten template text, with no preface or explanation.',
        },
        { role: 'user', content: `${INSTRUCTIONS[kind]}\n\nTemplate:\n${text}` },
      ],
    }),
  });
  if (r.status !== 200) throw new ProbeError(`AI assist is unavailable: ${describeStatus(r.status, 'Groq API key')}`);
  const out = ((r.body as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? '').trim();
  if (!out) throw new ProbeError('AI assist returned nothing. Try again.');

  const before = placeholdersIn(text).sort().join(',');
  const after = placeholdersIn(out).sort().join(',');
  if (before !== after) {
    throw new ProbeError('The suggestion changed the placeholders, so it was discarded. Try again or edit by hand.');
  }
  return out;
}
