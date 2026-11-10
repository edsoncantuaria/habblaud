// Login por um provedor OIDC na porta remota: um IAM compartilhado entre sistemas no lugar do usuário e senha do Habblaud.
// Fluxo authorization code com PKCE (cliente público). O `state` fica guardado aqui e amarrado ao navegador por um cookie
// (sem ele, alguém faria a vítima entrar na conta do atacante), vale uma vez e expira em minutos. O id_token só é aceito
// com assinatura conferida nas chaves do provedor e com emissor, cliente e validade certos; e o e-mail precisa estar
// na lista: ter conta no IAM não dá acesso a este sistema.
//   HABBLAUD_REMOTE_OIDC_ISSUER        https do provedor (ex.: https://auth.exemplo.com)
//   HABBLAUD_REMOTE_OIDC_CLIENT_ID     client id do app no provedor
//   HABBLAUD_REMOTE_OIDC_REDIRECT_URI  endereço público de /oidc/callback, registrado no provedor
//   HABBLAUD_REMOTE_OIDC_ALLOW         e-mails que podem entrar, separados por vírgula
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { tr } from '../../shared/i18n';

export const OIDC_LOGIN_PATH = '/oidc/login';
export const OIDC_CALLBACK_PATH = '/oidc/callback';
export const OIDC_STATE_COOKIE = 'habblaud_oidc';
const STATE_MS = 10 * 60_000;
/** Limite de logins em andamento: /oidc/login é público e não pode encher a memória. */
const MAX_PENDING = 256;
const REQUEST_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_S = 30;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  allowedEmails: ReadonlySet<string>;
}

export function parseOidcConfig(env: NodeJS.ProcessEnv): { oidc?: OidcConfig; warning?: string } {
  const issuer = env.HABBLAUD_REMOTE_OIDC_ISSUER?.trim().replace(/\/+$/, '') ?? '';
  const clientId = env.HABBLAUD_REMOTE_OIDC_CLIENT_ID?.trim() ?? '';
  const redirectUri = env.HABBLAUD_REMOTE_OIDC_REDIRECT_URI?.trim() ?? '';
  const allowedEmails = new Set((env.HABBLAUD_REMOTE_OIDC_ALLOW ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (!issuer && !clientId && !redirectUri && !allowedEmails.size) return {};
  if (!/^https:\/\//.test(issuer) || !clientId || !/^https:\/\//.test(redirectUri) || !allowedEmails.size) {
    return { warning: tr('login OIDC desligado: confira HABBLAUD_REMOTE_OIDC_ISSUER, _CLIENT_ID, _REDIRECT_URI e _ALLOW') };
  }
  return { oidc: { issuer, clientId, redirectUri, allowedEmails } };
}

type Rec = Record<string, unknown>;

function decodeSegment(segment: string | undefined): Rec | undefined {
  if (!segment) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : undefined;
  } catch {
    return undefined;
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export type OidcResult = { ok: true; email: string } | { ok: false; reason: 'state' | 'denied' | 'token' };

export interface OidcLoginOptions {
  now?: () => number;
  fetch?: typeof fetch;
}

export class OidcLogin {
  private readonly pending = new Map<string, { verifier: string; expiresAt: number }>();
  private readonly now: () => number;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly config: OidcConfig,
    opts: OidcLoginOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? fetch;
  }

  /** Começa um login: para onde mandar o navegador e o `state` que vai no cookie dele. */
  async begin(): Promise<{ location: string; state: string }> {
    const discovery = await this.discover();
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.remember(state, verifier);
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid profile',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { location: url.href, state };
  }

  /** Termina o login com a volta do provedor. `browserState` é o valor do cookie deste navegador. */
  async finish(params: URLSearchParams, browserState: string | undefined): Promise<OidcResult> {
    const state = params.get('state');
    const code = params.get('code');
    if (!state || state !== browserState) return { ok: false, reason: 'state' };
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= this.now() || !code) return { ok: false, reason: 'state' };

    const discovery = await this.discover();
    const response = await this.fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: pending.verifier }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: 'token' };
    const idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    const email = typeof idToken === 'string' ? await this.verifiedEmail(idToken, discovery) : undefined;
    if (!email) return { ok: false, reason: 'token' };
    return this.config.allowedEmails.has(email) ? { ok: true, email } : { ok: false, reason: 'denied' };
  }

  private remember(state: string, verifier: string): void {
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    this.pending.set(state, { verifier, expiresAt: now + STATE_MS });
  }

  private async discover(): Promise<Discovery> {
    const response = await this.fetch(`${this.config.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`OIDC discovery: HTTP ${response.status}`);
    const discovery = (await response.json()) as Discovery;
    if (discovery.issuer !== this.config.issuer) throw new Error('OIDC discovery: emissor diferente do configurado');
    return discovery;
  }

  /** O e-mail do id_token, se ele for válido para este app. */
  private async verifiedEmail(token: string, discovery: Discovery): Promise<string | undefined> {
    const [rawHeader, rawPayload, rawSignature, extra] = token.split('.');
    if (!rawSignature || extra !== undefined) return undefined;
    const header = decodeSegment(rawHeader);
    const payload = decodeSegment(rawPayload);
    if (header?.alg !== 'RS256' || !payload) return undefined;

    const response = await this.fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const { keys = [] } = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return undefined;
    const signed = Buffer.from(`${rawHeader}.${rawPayload}`);
    if (!verifySignature('RSA-SHA256', signed, createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(rawSignature, 'base64url'))) return undefined;

    const nowS = this.now() / 1000;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const valid =
      payload.iss === this.config.issuer &&
      aud.includes(this.config.clientId) &&
      typeof payload.exp === 'number' &&
      payload.exp > nowS &&
      (typeof payload.nbf !== 'number' || payload.nbf <= nowS + CLOCK_SKEW_S);
    return valid && typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : undefined;
  }
}
