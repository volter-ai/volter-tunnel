/**
 * VolterClient — a typed HTTP client for the relay's management + self-service
 * API. This is the SDK layer the CLI subcommands and the MCP server both build
 * on, so account/usage logic lives here once rather than in each front end.
 *
 * Auth is a bearer token: an api/login token (vta_) for self-service (`whoami`,
 * `usage`), or the root token (vtr_) for the admin operations.
 */

/** One usage/limit window (credits). */
export interface UsageWindow {
  used: number;
  leased: number;
  limit: number;
  remaining: number;
  pct: number;
}

/** Per-account usage as returned by the relay's /usage view. */
export interface AccountUsage {
  slug: string;
  status: 'active' | 'suspended';
  day: UsageWindow;
  month: UsageWindow;
  openTunnels: number;
  concurrentMax: number;
  resetAt: { day: string; month: string };
  usd: { dayUsed: number; dayLimit: number; monthUsed: number; monthLimit: number };
  raw?: Record<string, number>;
}

/** Result of `whoami()` — the caller's own account + usage. */
export interface Me {
  slug: string;
  name?: string;
  usage: AccountUsage;
}

export interface VolterClientOptions {
  /** Relay base URL, e.g. https://voltertest.xyz */
  host: string;
  /** Bearer token: api/login token for self-service, root token for admin ops. */
  token: string;
  /** Injectable fetch (defaults to global fetch) — handy for tests. */
  fetch?: typeof fetch;
}

/** Thrown when the relay returns a non-2xx response. */
export class VolterApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'VolterApiError';
  }
}

export class VolterClient {
  private readonly host: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: VolterClientOptions) {
    this.host = opts.host.replace(/\/$/, '');
    this.token = opts.token;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.doFetch(`${this.host}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
          ? parsed.error
          : res.statusText) || `HTTP ${res.status}`;
      throw new VolterApiError(res.status, message, parsed);
    }
    return parsed as T;
  }

  // ── self-service (api/login token) ─────────────────────────────────────────

  /** The caller's own account + usage. */
  whoami(): Promise<Me> {
    return this.request<Me>('GET', '/me');
  }

  /** Just the usage portion of the caller's account. */
  async usage(): Promise<AccountUsage> {
    return (await this.whoami()).usage;
  }

  // ── admin (root token) ───────────────────────────────────────────────────────

  listAccounts(): Promise<unknown> {
    return this.request('GET', '/admin/accounts');
  }
  createAccount(body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/admin/accounts', body);
  }
  patchLimits(slug: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `/admin/accounts/${encodeURIComponent(slug)}/limits`, body);
  }
  setStatus(slug: string, status: 'active' | 'suspended'): Promise<unknown> {
    return this.request('POST', `/admin/accounts/${encodeURIComponent(slug)}/${status === 'suspended' ? 'suspend' : 'resume'}`);
  }
  accountUsage(slug: string): Promise<unknown> {
    return this.request('GET', `/admin/accounts/${encodeURIComponent(slug)}/usage`);
  }
  usageSummary(): Promise<unknown> {
    return this.request('GET', '/admin/usage');
  }
  reports(): Promise<unknown> {
    return this.request('GET', '/admin/reports');
  }
  waitlist(): Promise<unknown> {
    return this.request('GET', '/admin/waitlist');
  }
  removeWaitlistEntry(githubUser: string): Promise<unknown> {
    return this.request('DELETE', `/admin/waitlist/${encodeURIComponent(githubUser)}`);
  }
  revokeReservation(tunnelId: string): Promise<unknown> {
    return this.request('DELETE', `/admin/reservations/${encodeURIComponent(tunnelId)}`);
  }
}
