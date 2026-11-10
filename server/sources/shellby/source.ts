// Fonte de agentes do Shellby (AgentSource 'shellby', ver sources/source.ts): agentes do ChatGPT que usam o Shellby por
// MCP. Eles não gravam arquivos na máquina; o estado vive em memória no servidor do Shellby e sai pela API local do
// dashboard dele: GET /ui/api/agents (a foto) e GET /ui/api/events (SSE, a foto inteira do agente a cada mudança).
// HABBLAUD_SHELLBY_URL (ex.: http://127.0.0.1:3333) liga a fonte; a porta muda com a instância do Shellby.
//
// O que o Shellby não informa e, portanto, o escritório não mostra: pasta do projeto (todos ficam na sala "shellby"),
// tokens e uso da conta, pedidos de permissão, vínculo entre subagente e pai, transcript (o terminal fica vazio).
//
// Presença: o Shellby não avisa o fim de uma conversa. Com uma ferramenta rodando ou uma chamada há menos de
// THINKING_MS o agente está trabalhando (entre chamadas, o modelo está pensando); depois fica ocioso e, sem nenhum sinal
// por GONE_AFTER_MS, sai do escritório até a próxima chamada. A numeração dos agentes é refeita a cada reinício do
// Shellby, então a identidade aqui inclui o firstSeenAt; sem conexão, todos saem (o estado do Shellby se perdeu).
import type { Activity, SourceInfo } from '../../../shared/types';
import { describeTool, maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { describeCodexTool } from '../codex/rollout';
import type { AgentSource } from '../source';

/** Mesma janela do dashboard do Shellby para considerar um agente ativo. */
export const THINKING_MS = 30_000;
export const GONE_AFTER_MS = 60 * 60_000;
const TICK_MS = 5_000;
const RETRY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;
const ROOM_CWD = '/shellby';
const ACCOUNT_ID = 'shellby';
const ROLE = tr('Agente principal (Shellby)');

type CallStatus = 'running' | 'completed' | 'failed';

interface ShellbyCall {
  id: string;
  tool: string;
  summary: string;
  detail?: string;
  detailLanguage?: string;
  startedAt: number;
  finishedAt?: number;
  status: CallStatus;
}

export interface ShellbyAgent {
  id: string;
  taskSlug?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  current?: ShellbyCall;
  recent: ShellbyCall[];
}

interface Tracker {
  key: string;
  agent: ShellbyAgent;
  /** Situação das chamadas ainda na foto do Shellby (uma chamada que saiu dela não volta). */
  calls: Map<string, CallStatus>;
  toolCalls: number;
  inOffice: boolean;
}

export interface ShellbySourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Origem do servidor do Shellby. */
  url: string;
  now?: () => number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function parseCall(raw: unknown): ShellbyCall | undefined {
  const r = rec(raw);
  if (!r || !isStr(r.id) || !isStr(r.tool) || !isNum(r.startedAt)) return undefined;
  if (r.status !== 'running' && r.status !== 'completed' && r.status !== 'failed') return undefined;
  return {
    id: r.id,
    tool: r.tool,
    summary: isStr(r.summary) ? r.summary : '',
    startedAt: r.startedAt,
    status: r.status,
    ...(isStr(r.detail) ? { detail: r.detail } : {}),
    ...(isStr(r.detailLanguage) ? { detailLanguage: r.detailLanguage } : {}),
    ...(isNum(r.finishedAt) ? { finishedAt: r.finishedAt } : {}),
  };
}

/** Valida um agente vindo da API do Shellby; undefined se faltar o essencial. */
export function parseAgent(raw: unknown): ShellbyAgent | undefined {
  const r = rec(raw);
  if (!r || !isStr(r.id) || !r.id || !isNum(r.firstSeenAt) || !isNum(r.lastSeenAt)) return undefined;
  const current = parseCall(r.current);
  return {
    id: r.id,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    recent: Array.isArray(r.recent) ? r.recent.map(parseCall).filter((c): c is ShellbyCall => !!c) : [],
    ...(isStr(r.taskSlug) && r.taskSlug ? { taskSlug: r.taskSlug } : {}),
    ...(current ? { current } : {}),
  };
}

/** O que mostrar de uma chamada: o dashboard do Shellby já resume a entrada em `summary` e `detail`. */
export function describeCall(call: ShellbyCall): Pick<Activity, 'kind' | 'icon' | 'text' | 'detail' | 'tool'> {
  const fromCodex = (name: string, input: Rec) => {
    const { desc, tool } = describeCodexTool(name, input);
    return { ...desc, tool };
  };
  const { tool, summary, detail } = call;
  if (tool === 'shell_run') {
    if (/^\d+ parallel commands$/.test(summary)) return { kind: 'run', icon: '⚙️', text: tr('Rodando comandos em paralelo'), detail: masked(detail), tool };
    return fromCodex('shell', { command: detail ?? summary });
  }
  if (tool.startsWith('shell_')) return fromCodex('write_stdin', {});
  if (tool === 'apply_patch') return fromCodex('apply_patch', { patch: detail ?? '' });
  if (tool === 'image_view') return fromCodex('view_image', { path: summary });
  if (tool === 'subagent_run') return fromCodex('Agent', { prompt: summary });
  if (tool === 'fetch_url') return { ...describeTool('WebFetch', { url: summary }), tool: 'WebFetch' };
  if (tool.startsWith('web_')) return { kind: 'web', icon: '🌐', text: tool, detail: masked(summary), tool };
  if (tool.startsWith('computer_')) return { kind: 'browser', icon: '🖱️', text: tr('Usando o computador'), detail: masked(summary), tool };
  return { kind: 'mcp', icon: '🔌', text: tool, detail: masked(summary), tool };
}

function masked(text: string | undefined): string | undefined {
  return text ? truncate(maskSecrets(text), 300) : undefined;
}

export class ShellbySource implements AgentSource {
  readonly provider = 'shellby' as const;
  private readonly base: string;
  private readonly now: () => number;
  private readonly trackers = new Map<string, Tracker>();
  private conn?: AbortController;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private error?: string = tr('conectando');

  constructor(private readonly opts: ShellbySourceOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
    opts.accounts.setProviderAccounts('shellby', [
      { dir: this.base, detected: { id: ACCOUNT_ID, configDir: this.base, short: 'S', name: 'Shellby', color: '#2ec4b6' } },
    ]);
  }

  start(): void {
    void this.run();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = null;
    this.retry = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.trackers.values()) if (t.inOffice) sessions++;
    return [{ label: ACCOUNT_ID, provider: 'shellby', path: this.base, sessions, ok: !this.error, ...(this.error ? { error: this.error } : {}) }];
  }

  transcriptPathOf(): undefined {
    return undefined;
  }

  /** Reavalia quem está pensando, ocioso ou ausente: o tempo passa sem eventos do Shellby. */
  tick(): void {
    for (const t of this.trackers.values()) if (t.inOffice) this.applyPresence(t);
  }

  /** Entrega a instrução ao Shellby, que a escreve no chat do agente (ou na resposta da próxima ferramenta). */
  async deliver(agentKey: string, text: string): Promise<void> {
    const t = [...this.trackers.values()].find((x) => x.key === agentKey);
    if (!t) throw new Error(tr('o agente saiu do escritório'));
    const res = await fetch(`${this.base}/ui/api/agents/${encodeURIComponent(t.agent.id)}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 202) throw new Error(tr('o Shellby recusou a mensagem (HTTP {0})', [res.status]));
  }

  /** Conecta, sincroniza e acompanha, para sempre: a cada queda, esvazia a sala e tenta de novo. */
  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const body = await this.connect();
        this.error = undefined;
        this.opts.office.markDirty();
        await this.pump(body);
        throw new Error(tr('conexão encerrada'));
      } catch (err) {
        if (this.stopped) return;
        this.disconnected(errMsg(err));
      }
      await new Promise<void>((resolve) => {
        this.retry = setTimeout(resolve, RETRY_MS);
        this.retry.unref?.();
      });
    }
  }

  /** Abre o SSE antes de ler a foto: o que mudar no meio fica na fila do stream e nada se perde. */
  private async connect(): Promise<ReadableStream<Uint8Array>> {
    const conn = new AbortController();
    this.conn = conn;
    const deadline = setTimeout(() => conn.abort(), REQUEST_TIMEOUT_MS);
    try {
      const events = await fetch(`${this.base}/ui/api/events`, { signal: conn.signal });
      if (!events.ok || !events.body) throw new Error(`/ui/api/events: HTTP ${events.status}`);
      const res = await fetch(`${this.base}/ui/api/agents`, { signal: conn.signal });
      if (!res.ok) throw new Error(`/ui/api/agents: HTTP ${res.status}`);
      const list = rec(await res.json())?.agents;
      this.reconcile((Array.isArray(list) ? list : []).map(parseAgent).filter((a): a is ShellbyAgent => !!a));
      return events.body;
    } finally {
      clearTimeout(deadline);
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        this.frame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
  }

  private frame(frame: string): void {
    if (!frame.startsWith('data: ')) return;
    let event: Rec | undefined;
    try {
      event = rec(JSON.parse(frame.slice('data: '.length)));
    } catch (err) {
      log.warnOnce(`shellby-frame:${errMsg(err)}`, tr('Shellby: evento inválido ({0}).', [errMsg(err)]));
      return;
    }
    const agent = event?.type === 'agent_changed' ? parseAgent(event.agent) : undefined;
    if (agent) this.apply(agent, true);
  }

  private reconcile(agents: readonly ShellbyAgent[]): void {
    const { office } = this.opts;
    office.beginBoot();
    try {
      const alive = new Set(agents.map((a) => a.id));
      for (const [id, t] of this.trackers) {
        if (alive.has(id)) continue;
        this.leave(t);
        this.trackers.delete(id);
      }
      for (const agent of agents) this.apply(agent, false);
    } finally {
      office.endBoot();
    }
  }

  private disconnected(reason: string): void {
    this.error = reason;
    log.warnOnce(`shellby:${reason}`, tr('Shellby: sem conexão com {0} ({1}).', [this.base, reason]));
    for (const t of this.trackers.values()) this.leave(t);
    this.trackers.clear();
    this.opts.office.markDirty();
  }

  private apply(agent: ShellbyAgent, live: boolean): void {
    let t = this.trackers.get(agent.id);
    if (t && t.agent.firstSeenAt !== agent.firstSeenAt) {
      this.leave(t);
      t = undefined;
    }
    if (!t) {
      t = { key: `${ACCOUNT_ID}:${agent.id}:${agent.firstSeenAt}`, agent, calls: new Map(), toolCalls: 0, inOffice: false };
      this.trackers.set(agent.id, t);
    }
    // A foto lida ao conectar pode ser mais nova que os eventos que estavam na fila do stream.
    if (agent.lastSeenAt < t.agent.lastSeenAt) return;
    t.agent = agent;
    const inOffice = this.enter(t);
    this.applyCalls(t, inOffice, live);
    if (!inOffice) return;
    this.applyPresence(t);
    this.opts.office.applyTranscript(t.key, {
      title: agent.taskSlug,
      tasks: [],
      stats: { toolCalls: t.toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 },
      lastAt: agent.lastSeenAt,
    });
  }

  /** Entra no escritório se há sinal de vida. Devolve se o agente está nele. */
  private enter(t: Tracker): boolean {
    if (t.inOffice) return true;
    if (this.statusOf(t.agent) === 'gone') return false;
    this.opts.office.addMain({
      id: t.key,
      provider: 'shellby',
      account: ACCOUNT_ID,
      sessionId: t.key,
      cwd: ROOM_CWD,
      role: ROLE,
      startedAt: t.agent.firstSeenAt,
      status: 'working',
    });
    t.inOffice = true;
    return true;
  }

  private applyCalls(t: Tracker, inOffice: boolean, live: boolean): void {
    const { agent } = t;
    const calls = [...agent.recent];
    if (agent.current && !calls.some((c) => c.id === agent.current?.id)) calls.push(agent.current);
    calls.sort((a, b) => a.startedAt - b.startedAt);

    const next = new Map<string, CallStatus>();
    calls.forEach((call, index) => {
      next.set(call.id, call.status);
      const before = t.calls.get(call.id);
      if (before && (before === call.status || call.status !== 'failed')) return;
      if (!before) t.toolCalls++;
      if (!inOffice) return;
      const id = `${t.key}#${call.id}`;
      const failed = call.status === 'failed';
      const duration = call.finishedAt === undefined ? {} : { durationMs: call.finishedAt - call.startedAt };
      const activity: Activity = before
        ? { ...describeCall(call), id: `${id}#failed`, kind: 'error', at: call.finishedAt ?? call.startedAt, error: true, ...duration }
        : { ...describeCall(call), id, at: call.startedAt, ...(failed ? { error: true } : {}), ...duration };
      this.opts.office.addActivity(t.key, activity, index === calls.length - 1, { feed: live });
    });
    t.calls = next;
  }

  private statusOf(agent: ShellbyAgent): 'working' | 'idle' | 'gone' {
    if (agent.current?.status === 'running') return 'working';
    const quiet = this.now() - agent.lastSeenAt;
    return quiet < THINKING_MS ? 'working' : quiet < GONE_AFTER_MS ? 'idle' : 'gone';
  }

  private applyPresence(t: Tracker): void {
    const status = this.statusOf(t.agent);
    if (status === 'gone') this.leave(t);
    else this.opts.office.setStatus(t.key, status);
  }

  private leave(t: Tracker): void {
    if (!t.inOffice) return;
    t.inOffice = false;
    this.opts.office.closeMain(t.key);
  }
}
