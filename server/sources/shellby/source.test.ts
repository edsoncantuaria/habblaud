// Integração da fonte do Shellby: um servidor HTTP local no formato da API do dashboard, o AccountsService e o Office.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { MessageRegistry } from '../../messages/registry';
import { Office } from '../../model/office';
import { describeCall, GONE_AFTER_MS, parseAgent, ShellbySource, THINKING_MS, type ShellbyAgent } from './source';

setQuiet(true);

const T0 = 1_800_000_000_000;

function call(id: string, over: Partial<ShellbyAgent['recent'][number]> = {}): ShellbyAgent['recent'][number] {
  return { id, tool: 'shell_run', summary: 'ls', detail: 'ls', detailLanguage: 'bash', startedAt: T0, status: 'running', ...over };
}

function agent(over: Partial<ShellbyAgent> = {}): ShellbyAgent {
  return { id: 'agent-1', firstSeenAt: T0, lastSeenAt: T0, recent: [], ...over };
}

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function setup(initial: ShellbyAgent[], opts: { steerStatus?: number } = {}) {
  let clock = T0;
  const clients = new Set<http.ServerResponse>();
  const steered: Array<{ url: string; body: unknown }> = [];
  const shellby = { agents: initial };
  const server = http.createServer((req, res) => {
    if (req.url === '/ui/api/agents') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ agents: shellby.agents }));
    } else if (req.url === '/ui/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      clients.add(res);
      req.once('close', () => clients.delete(res));
    } else if (req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        steered.push({ url: req.url ?? '', body: JSON.parse(raw) });
        res.statusCode = opts.steerStatus ?? 202;
        res.end('{}');
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const late: { office?: Office } = {};
  const now = () => clock;
  const accounts = new AccountsService({ dirs: [], home: '/nao-existe', env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({ names: new NameStore(null), version: 'teste', startedAt: clock, accounts: (s) => accounts.list(s), sources: () => [], accountName: (id) => accounts.find(id)?.detected.name, now });
  late.office = office;
  const source = new ShellbySource({ accounts, office, url: `${url}/`, now });
  cleanups.push(async () => {
    source.stop();
    for (const c of clients) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  source.start();
  await vi.waitFor(() => expect(source.sources()[0].ok).toBe(true));
  return {
    source,
    office,
    steered,
    emit: async (a: ShellbyAgent) => {
      for (const c of clients) c.write(`data: ${JSON.stringify({ type: 'agent_changed', agent: a })}\n\n`);
    },
    advance: (ms: number) => void (clock += ms),
    dropAll: () => {
      for (const c of clients) c.destroy();
    },
    key: `shellby:agent-1:${T0}`,
  };
}

describe('ShellbySource', () => {
  it('coloca na sala shellby o agente da foto inicial, com título e atividade', async () => {
    const s = await setup([agent({ taskSlug: 'corrigir-login', current: call('call-1') })]);
    const a = s.office.get(s.key);
    expect(a).toMatchObject({ provider: 'shellby', account: 'shellby', status: 'working', title: 'corrigir-login' });
    expect(a?.roomId).toContain('shellby');
    expect(a?.activity?.tool).toBe('Bash');
    expect(a?.stats.toolCalls).toBe(1);
    expect(s.source.sources()[0]).toMatchObject({ provider: 'shellby', sessions: 1, ok: true });
  });

  it('acompanha o SSE sem repetir chamadas e registra a falha de uma que estava rodando', async () => {
    const s = await setup([agent({ current: call('call-1') })]);
    await s.emit(agent({ lastSeenAt: T0 + 1, recent: [call('call-1', { status: 'failed', finishedAt: T0 + 1 })] }));
    await vi.waitFor(() => expect(s.office.get(s.key)?.activity?.kind).toBe('error'));
    expect(s.office.get(s.key)?.stats.toolCalls).toBe(1);
    expect(s.office.get(s.key)?.activity?.error).toBe(true);
  });

  it('ignora evento mais velho que o que já viu', async () => {
    const s = await setup([agent({ lastSeenAt: T0 + 10, current: call('call-2', { startedAt: T0 + 10 }), recent: [call('call-1', { status: 'completed' })] })]);
    await s.emit(agent({ lastSeenAt: T0 + 1, current: call('call-1') }));
    await s.emit(agent({ lastSeenAt: T0 + 20, current: call('call-3', { startedAt: T0 + 20 }), recent: [call('call-2', { status: 'completed' }), call('call-1', { status: 'completed' })] }));
    await vi.waitFor(() => expect(s.office.get(s.key)?.stats.toolCalls).toBe(3));
  });

  it('fica ocioso depois de um tempo sem chamadas, sai ao sumir e volta na próxima chamada', async () => {
    const s = await setup([agent()]);
    expect(s.office.get(s.key)?.status).toBe('working');
    s.advance(THINKING_MS);
    s.source.tick();
    expect(s.office.get(s.key)?.status).toBe('idle');
    s.advance(GONE_AFTER_MS);
    s.source.tick();
    expect(s.office.get(s.key)?.status).toBe('offline');
    await s.emit(agent({ lastSeenAt: T0 + THINKING_MS + GONE_AFTER_MS, current: call('call-9') }));
    await vi.waitFor(() => expect(s.office.get(s.key)?.status).toBe('working'));
  });

  it('não põe no escritório um agente que já estava sumido ao conectar', async () => {
    const s = await setup([agent({ lastSeenAt: T0 - GONE_AFTER_MS })]);
    expect(s.office.get(s.key)).toBeUndefined();
  });

  it('um reinício do Shellby (mesmo id, outro firstSeenAt) é outro agente', async () => {
    const s = await setup([agent()]);
    await s.emit(agent({ firstSeenAt: T0 + 5, lastSeenAt: T0 + 5 }));
    await vi.waitFor(() => expect(s.office.get(`shellby:agent-1:${T0 + 5}`)?.status).toBe('working'));
    expect(s.office.get(s.key)?.status).toBe('offline');
  });

  it('sem conexão, todos saem e a fonte informa o erro', async () => {
    const s = await setup([agent()]);
    s.dropAll();
    await vi.waitFor(() => expect(s.office.get(s.key)?.status).toBe('offline'));
    expect(s.source.sources()[0].ok).toBe(false);
  });

  it('entrega a instrução ao endpoint de steer e devolve a recusa como erro', async () => {
    const ok = await setup([agent()]);
    await ok.source.deliver(ok.key, 'pare e rode os testes');
    expect(ok.steered).toEqual([{ url: '/ui/api/agents/agent-1/steer', body: { message: 'pare e rode os testes' } }]);
    await expect(ok.source.deliver('desconhecido', 'x')).rejects.toThrow();

    const refused = await setup([agent()], { steerStatus: 404 });
    await expect(refused.source.deliver(refused.key, 'x')).rejects.toThrow('404');
  });
});

describe('mensagens ao Shellby', () => {
  it('o composer alcança o agente e a mensagem vira delivered depois do steer', async () => {
    const s = await setup([agent()]);
    const messages = new MessageRegistry({ office: s.office, shellby: s.source });
    expect(messages.reachable().has(s.key)).toBe(true);
    const sent = messages.send({ agentId: s.key, text: 'rode os testes' });
    if (!('message' in sent)) throw new Error('não enviou');
    await vi.waitFor(() => expect(messages.get(sent.message.id)?.status).toBe('delivered'));
    expect(s.steered[0].body).toEqual({ message: 'rode os testes' });
  });

  it('a recusa do Shellby vira failed com o motivo', async () => {
    const s = await setup([agent()], { steerStatus: 404 });
    const messages = new MessageRegistry({ office: s.office, shellby: s.source });
    const sent = messages.send({ agentId: s.key, text: 'x' });
    if (!('message' in sent)) throw new Error('não enviou');
    await vi.waitFor(() => expect(messages.get(sent.message.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('404') }));
  });
});

describe('parseAgent e describeCall', () => {
  it('rejeita agentes sem o essencial e descarta chamadas inválidas', () => {
    expect(parseAgent({ id: 'a' })).toBeUndefined();
    expect(parseAgent(agent({ recent: [{ id: 'x' } as never, call('ok')] }))?.recent.map((c) => c.id)).toEqual(['ok']);
  });

  it('traduz as ferramentas do Shellby para atividades do escritório', () => {
    expect(describeCall(call('c')).kind).toBe('read');
    expect(describeCall(call('c', { summary: '2 parallel commands', detail: 'a\n\nb' })).kind).toBe('run');
    expect(describeCall(call('c', { tool: 'apply_patch', detail: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' })).kind).toBe('edit');
    expect(describeCall(call('c', { tool: 'fetch_url', summary: 'https://example.com' })).kind).toBe('web');
    expect(describeCall(call('c', { tool: 'computer_click', summary: '' })).kind).toBe('browser');
    expect(describeCall(call('c', { tool: 'skill_load', summary: 'token=abc123456789012345678901234567890' })).kind).toBe('mcp');
  });
});
