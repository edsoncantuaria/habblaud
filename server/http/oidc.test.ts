import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OidcLogin, parseOidcConfig, type OidcConfig } from './oidc';

const ISSUER = 'https://auth.exemplo.com';
const T0 = 1_800_000_000_000;
const NOW_S = T0 / 1000;
const CONFIG: OidcConfig = { issuer: ISSUER, clientId: 'cliente', redirectUri: 'https://app.exemplo.com/oidc/callback', allowedEmails: new Set(['dono@exemplo.com']) };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function idToken(over: Record<string, unknown> = {}, opts: { alg?: string; key?: typeof privateKey } = {}): string {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: 'k1' });
  const body = b64({ iss: ISSUER, aud: 'cliente', sub: 'u1', email: 'Dono@exemplo.com', exp: NOW_S + 600, ...over });
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function setup(token: string = idToken(), discoveryIssuer = ISSUER) {
  const requests: Array<{ url: string; body?: string }> = [];
  let clock = T0;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.endsWith('/openid-configuration')) return new Response(JSON.stringify({ issuer: discoveryIssuer, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` }));
    if (url.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }] }));
    return new Response(JSON.stringify({ id_token: token }));
  });
  const login = new OidcLogin(CONFIG, { now: () => clock, fetch: fetchMock as unknown as typeof fetch });
  return { login, requests, advance: (ms: number) => void (clock += ms) };
}

async function callback(login: OidcLogin, over: { state?: string; browser?: string; code?: string } = {}) {
  const { state } = await login.begin();
  return login.finish(new URLSearchParams({ state: over.state ?? state, code: over.code ?? 'codigo' }), over.browser ?? state);
}

describe('OidcLogin', () => {
  it('pede code com PKCE S256 e troca o verifier correspondente', async () => {
    const { login, requests } = setup();
    const { location, state } = await login.begin();
    const url = new URL(location);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'cliente', redirect_uri: CONFIG.redirectUri, state, code_challenge_method: 'S256' });
    await expect(login.finish(new URLSearchParams({ state, code: 'c' }), state)).resolves.toEqual({ ok: true, email: 'dono@exemplo.com' });
    const verifier = new URLSearchParams(requests.find((r) => r.url.endsWith('/token'))?.body).get('code_verifier') as string;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });

  it('o state precisa bater com o navegador, vale uma vez e expira', async () => {
    const a = setup();
    await expect(callback(a.login, { browser: 'de-outro-navegador' })).resolves.toEqual({ ok: false, reason: 'state' });

    const b = setup();
    const { state } = await b.login.begin();
    const params = new URLSearchParams({ state, code: 'c' });
    expect((await b.login.finish(params, state)).ok).toBe(true);
    await expect(b.login.finish(params, state)).resolves.toEqual({ ok: false, reason: 'state' });

    const c = setup();
    const started = await c.login.begin();
    c.advance(10 * 60_000);
    await expect(c.login.finish(new URLSearchParams({ state: started.state, code: 'c' }), started.state)).resolves.toEqual({ ok: false, reason: 'state' });
  });

  it('e-mail fora da lista não entra, mesmo com token válido', async () => {
    await expect(callback(setup(idToken({ email: 'outro@exemplo.com' })).login)).resolves.toEqual({ ok: false, reason: 'denied' });
  });

  it.each([
    ['outro cliente', idToken({ aud: 'outro' })],
    ['outro emissor', idToken({ iss: 'https://evil.exemplo.com' })],
    ['vencido', idToken({ exp: NOW_S - 1 })],
    ['sem e-mail', idToken({ email: undefined })],
    ['outra chave', idToken({}, { key: other.privateKey })],
    ['alg none', `${b64({ alg: 'none', kid: 'k1' })}.${b64({ iss: ISSUER, aud: 'cliente', email: 'dono@exemplo.com', exp: NOW_S + 60 })}.`],
    ['alg HS256', idToken({}, { alg: 'HS256' })],
  ])('recusa id_token: %s', async (_name, token) => {
    await expect(callback(setup(token).login)).resolves.toEqual({ ok: false, reason: 'token' });
  });

  it('recusa provedor que se apresenta com outro emissor', async () => {
    await expect(setup(idToken(), 'https://evil.exemplo.com').login.begin()).rejects.toThrow();
  });

  it('não acumula logins abandonados sem limite', async () => {
    const { login } = setup();
    const first = await login.begin();
    for (let i = 0; i < 256; i++) await login.begin();
    await expect(login.finish(new URLSearchParams({ state: first.state, code: 'c' }), first.state)).resolves.toEqual({ ok: false, reason: 'state' });
  });
});

describe('parseOidcConfig', () => {
  const full = { HABBLAUD_REMOTE_OIDC_ISSUER: `${ISSUER}/`, HABBLAUD_REMOTE_OIDC_CLIENT_ID: 'c', HABBLAUD_REMOTE_OIDC_REDIRECT_URI: CONFIG.redirectUri, HABBLAUD_REMOTE_OIDC_ALLOW: ' A@b.c , d@e.f' };

  it('fica desligado sem variáveis e normaliza as informadas', () => {
    expect(parseOidcConfig({})).toEqual({});
    const { oidc } = parseOidcConfig(full);
    expect(oidc?.issuer).toBe(ISSUER);
    expect([...(oidc?.allowedEmails ?? [])]).toEqual(['a@b.c', 'd@e.f']);
  });

  it('avisa se faltar algo, se não for https ou se a lista estiver vazia', () => {
    expect(parseOidcConfig({ ...full, HABBLAUD_REMOTE_OIDC_CLIENT_ID: '' }).warning).toBeTruthy();
    expect(parseOidcConfig({ ...full, HABBLAUD_REMOTE_OIDC_ISSUER: 'http://auth.exemplo.com' }).warning).toBeTruthy();
    expect(parseOidcConfig({ ...full, HABBLAUD_REMOTE_OIDC_ALLOW: ' , ' }).warning).toBeTruthy();
  });
});
