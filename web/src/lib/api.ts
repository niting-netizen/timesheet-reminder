import type { FieldError } from '../../../shared/settings';

const TOKEN_KEY = 'tsr-token';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fieldErrors: FieldError[] = [],
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}
let memoryToken: string | null = null;
export function setToken(t: string | null) {
  memoryToken = t;
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: keep in memory only */
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the Timesheet Reminder server. Check that it is running.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; fieldErrors?: FieldError[] };
  if (res.status === 401 && path !== '/api/auth/login') {
    setToken(null);
    onUnauthorized();
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`, data.fieldErrors ?? []);
  return data as T;
}
