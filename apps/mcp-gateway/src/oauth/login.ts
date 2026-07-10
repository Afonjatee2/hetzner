import { createHmac, timingSafeEqual } from "node:crypto";

export function createCsrfToken(secret: Buffer): string {
  const issuedAt = Date.now().toString(36);
  const mac = createHmac("sha256", secret).update(issuedAt).digest("hex");
  return `${issuedAt}.${mac}`;
}

export function verifyCsrfToken(secret: Buffer, token: string | undefined, maxAgeMs = 10 * 60 * 1000): boolean {
  if (!token) return false;
  const [issuedAt, mac] = token.split(".");
  if (!issuedAt || !mac) return false;
  const expected = createHmac("sha256", secret).update(issuedAt).digest("hex");
  const provided = Buffer.from(mac, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) return false;
  const issuedMs = parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedMs)) return false;
  return Date.now() - issuedMs <= maxAgeMs && Date.now() >= issuedMs;
}

// Rate-limits failed login attempts only: a correct password is never counted
// and blocking is decided purely per-IP. This deliberately means an attacker
// flooding wrong-password POSTs (from one IP or many) can never lock the real
// operator out of their own login - the operator's IP starts every window
// with a clean slate regardless of what any other IP has done. The global
// failure count is still tracked so operators get an audit signal if a
// distributed credential-stuffing attempt is under way, but it never blocks.
export class LoginRateLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly windowMs = 15 * 60 * 1000,
    private readonly perIpLimit = 5,
    private readonly globalSurgeThreshold = 20
  ) {}

  private prunedIp(ip: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const timestamps = (this.perIp.get(ip) ?? []).filter((timestamp) => timestamp > cutoff);
    this.perIp.set(ip, timestamps);
    return timestamps;
  }

  private prunedGlobal(now: number): number[] {
    const cutoff = now - this.windowMs;
    this.global = this.global.filter((timestamp) => timestamp > cutoff);
    return this.global;
  }

  /** Read-only pre-check: gates the (comparatively expensive) password verification. */
  isBlocked(ip: string): boolean {
    return this.prunedIp(ip, Date.now()).length >= this.perIpLimit;
  }

  /** Records a failed attempt (wrong CSRF token or wrong password). Never call this for a successful login. */
  recordFailure(ip: string): void {
    const now = Date.now();
    const ipTimestamps = this.prunedIp(ip, now);
    ipTimestamps.push(now);
    this.perIp.set(ip, ipTimestamps);
    this.prunedGlobal(now).push(now);
  }

  /** True once accumulated failures across all IPs cross the surge threshold; informational only, never blocks. */
  isGlobalSurgeDetected(): boolean {
    return this.prunedGlobal(Date.now()).length >= this.globalSurgeThreshold;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

export interface LoginFormParams {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  error?: string;
}

export function renderLoginPage(params: LoginFormParams, csrfToken: string): string {
  const hidden = (name: string, value: string | undefined): string =>
    value !== undefined ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : "";
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Sign in - Hetzner Dev Workspace</title></head>
<body>
<h1>Hetzner Dev Workspace</h1>
${params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("client_id", params.clientId)}
${hidden("redirect_uri", params.redirectUri)}
${hidden("state", params.state)}
${hidden("scope", params.scope)}
${hidden("resource", params.resource)}
${hidden("code_challenge", params.codeChallenge)}
${hidden("code_challenge_method", params.codeChallengeMethod)}
${hidden("response_type", params.responseType)}
${hidden("csrf_token", csrfToken)}
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
