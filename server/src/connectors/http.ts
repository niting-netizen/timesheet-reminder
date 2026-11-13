import { describeStatus, ProbeError, request } from '../testers/http';
import { SourceUnavailable, type ConnectorContext } from './types';

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

/**
 * GET JSON with retries for rate limits and transient server errors.
 * Any other failure means the source's data is incomplete: SourceUnavailable.
 */
export async function getJson<T>(ctx: ConnectorContext, url: string, headers: Record<string, string>, credential: string): Promise<T> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let r: { status: number; body: unknown };
    try {
      r = await request(ctx.fetch, url, { headers: { Accept: 'application/json', ...headers } });
    } catch (e) {
      if (e instanceof ProbeError) {
        if (attempt < MAX_RETRIES && /No response within|reset/.test(e.message)) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new SourceUnavailable(e.message);
      }
      throw e;
    }
    if (r.status >= 200 && r.status < 300) return r.body as T;
    if (RETRYABLE.has(r.status) && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new SourceUnavailable(describeStatus(r.status, credential));
  }
}

/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
