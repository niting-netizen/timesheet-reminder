export type FetchFn = typeof fetch;

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export const TIMEOUT_MS = 10_000;

export class ProbeError extends Error {}

/** Normalise and check a base URL before any credentials are sent to it. */
export function checkBaseUrl(raw: string, allowInsecure: boolean): URL {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new ProbeError('Enter the base URL.');
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new ProbeError('The base URL is not a valid address. Use the full address, for example https://yourcompany.atlassian.net.');
  }
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) {
    throw new ProbeError('The base URL must start with https:// so credentials are encrypted in transit.');
  }
  if (u.username || u.password) throw new ProbeError('Remove the username and password from the URL. Use the fields instead.');
  return u;
}

export function joinUrl(base: URL, path: string): string {
  return base.toString().replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

export async function request(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ProbeError(describeNetworkError(e));
  }
  const text = await res.text().catch(() => '');
  if (isCloudflareChallenge(res, text)) {
    throw new ProbeError(
      'Blocked by Cloudflare bot protection before reaching the application, so the key was not checked. ' +
        'Ask the site owner to allow this server (for example a Cloudflare service token, a WAF rule for its IP, or an internal URL).',
    );
  }
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

function isCloudflareChallenge(res: Response, text: string): boolean {
  if (res.headers.get('cf-mitigated') === 'challenge') return true;
  return (
    (res.status === 403 || res.status === 503) &&
    (res.headers.get('server') ?? '').toLowerCase().includes('cloudflare') &&
    /<title>Just a moment/i.test(text)
  );
}

export function describeNetworkError(e: unknown): string {
  const err = e as { name?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `No response within ${TIMEOUT_MS / 1000} seconds. Check the URL and that the server is reachable from this machine.`;
  const code = err?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Could not find that server. Check the spelling of the base URL.';
  if (code === 'ECONNREFUSED') return 'The server refused the connection. Check the URL and port.';
  if (code === 'ECONNRESET') return 'The connection was reset. A firewall or proxy may be blocking it.';
  if (code.startsWith('CERT_') || code.includes('SELF_SIGNED') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'The server certificate could not be verified.';
  return `Could not connect${code ? ` (${code})` : ''}.`;
}

/** Turn an HTTP status into a message an admin can act on. */
export function describeStatus(status: number, credential: string): string {
  if (status === 401) return `401 Unauthorized. The ${credential} was rejected. Check it and try again.`;
  if (status === 403) return `403 Forbidden. The account signed in but is not allowed to read this. Check its permissions.`;
  if (status === 404) return '404 Not found. Check the base URL (and the test path, if any).';
  if (status >= 300 && status < 400) return `The server redirected (${status}). Check the base URL; it may need https or a different path.`;
  if (status === 429) return '429 Too many requests. Wait a minute and test again.';
  if (status >= 500) return `The server returned an error (${status}). Try again later.`;
  return `Unexpected response (${status}).`;
}
