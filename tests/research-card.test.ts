import assert from 'node:assert/strict';
import test from 'node:test';
import type { OwnedSubscription, PaseoAgent, PaseoAgentListResult, PaseoApi, SubscriptionObserver } from '@getpaseo/client';
import { hasResearchPermission, isGeminiResearchUrl, ResearchCardState } from '../client/research-card-state';
import type { ResearchCard } from '../shared/research';

const card: ResearchCard = { phase: 'plan', status: '계획 확인', plan: 'IANA 자료 조사', permissionId: 'research-1' };
const permission = { id: 'research-1', provider: 'gemini-web', name: 'deep_research', kind: 'plan' as const };
const agent = (overrides: Partial<PaseoAgent> = {}) => ({ id: 'agent-1', provider: 'gemini-web', status: 'running', pendingPermissions: [permission], ...overrides }) as PaseoAgent;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let observer: SubscriptionObserver<PaseoAgentListResult & { subscriptionId: string }> | undefined;
  let refreshed: PaseoAgent | null = agent();
  let refreshWait = Promise.resolve();
  let respondWait = Promise.resolve();
  let respondFailure: Error | undefined;
  let releases = 0, unsubscriptions = 0, refreshes = 0;
  let signal: AbortSignal | undefined;
  const responses: unknown[] = [];
  const snapshot = (agents: PaseoAgent[]) => ({ subscriptionId: 'sub', entries: agents.map(agent => ({ agent })) }) as PaseoAgentListResult & { subscriptionId: string };
  const subscription = {
    subscribe(next: typeof observer) { observer = next; observer!.snapshot(snapshot([agent()])); return () => { unsubscriptions++; }; },
    release: async () => { releases++; },
  } as OwnedSubscription<PaseoAgentListResult>;
  const paseo = { agents: {
    list: async (options: { signal: AbortSignal }) => { signal = options.signal; return { subscription }; },
    ref: () => ({
      refresh: async () => { refreshes++; await refreshWait; return refreshed ? { agent: refreshed } : null; },
      respondToPermission: async (value: unknown) => { responses.push(value); await respondWait; if (respondFailure) throw respondFailure; },
    }),
  } } as unknown as Pick<PaseoApi, 'agents'>;
  const state = new ResearchCardState(paseo);
  state.start();
  return {
    state, responses,
    snapshot: (agents: PaseoAgent[]) => observer!.snapshot(snapshot(agents)),
    update: (next: PaseoAgent) => observer!.update({ type: 'agent_update', payload: { kind: 'upsert', agent: next } } as any),
    remove: () => observer!.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'agent-1' } } as any),
    fail: () => observer!.error?.(new Error('disconnected')),
    refreshWith: (value: PaseoAgent | null, wait = Promise.resolve()) => { refreshed = value; refreshWait = wait; },
    respondWith: (wait: Promise<void>, error?: Error) => { respondWait = wait; respondFailure = error; },
    cleanupCounts: () => ({ releases, unsubscriptions, aborted: signal?.aborted }),
    refreshes: () => refreshes,
  };
}

test('research card approves only its matching live Gemini research plan permission', () => {
  assert.equal(hasResearchPermission(agent(), 'research-1'), true);
  assert.equal(hasResearchPermission(agent(), 'older-request'), false);
  assert.equal(hasResearchPermission(agent({ provider: 'claude' }), 'research-1'), false);
  assert.equal(hasResearchPermission(agent({ status: 'closed' }), 'research-1'), false);
  for (const invalid of [{ ...permission, name: 'read_file' }, { ...permission, kind: 'tool' as const }, { ...permission, provider: 'claude' }]) {
    assert.equal(hasResearchPermission(agent({ pendingPermissions: [invalid] }), 'research-1'), false);
  }
});

test('historical, completed, removed and replaced-snapshot cards cannot be approved', async t => {
  const h = harness(); t.after(() => h.state.close()); await flush();
  assert.equal(h.state.canRespond('agent-1', card), true);
  assert.equal(h.state.canRespond('agent-1', { ...card, phase: 'completed' }), false);
  assert.equal(h.state.canRespond('other-agent', card), false);
  h.remove(); assert.equal(h.state.canRespond('agent-1', card), false);
  h.update(agent()); assert.equal(h.state.canRespond('agent-1', card), true);
  h.snapshot([]); assert.equal(h.state.canRespond('agent-1', card), false);
  h.snapshot([agent()]); h.fail(); assert.equal(h.state.canRespond('agent-1', card), false);
  assert.match(h.state.unavailableMessage(), /연결/);
  await assert.rejects(h.state.respond('agent-1', card, 'allow'), /유효하지/);
  assert.equal(h.responses.length, 0);
});

test('approval rechecks the daemon and rejects a plan resolved after the last subscription snapshot', async t => {
  const h = harness(); t.after(() => h.state.close()); await flush();
  h.refreshWith(agent({ pendingPermissions: [] }));
  await assert.rejects(h.state.respond('agent-1', card, 'allow'), /이미 처리/);
  assert.equal(h.responses.length, 0);
  assert.equal(h.state.isBusy('agent-1', card.permissionId), false);
  assert.equal(h.state.canRespond('agent-1', card), false);
});

test('duplicate clicks across panes send a single response to the exact request', async t => {
  const h = harness(); t.after(() => h.state.close()); await flush();
  let finish!: () => void;
  h.respondWith(new Promise(resolve => { finish = resolve; }));
  const first = h.state.respond('agent-1', card, 'allow');
  const duplicate = h.state.respond('agent-1', card, 'allow');
  await flush();
  assert.equal(h.state.isBusy('agent-1', card.permissionId), true);
  assert.equal(h.refreshes(), 1);
  assert.deepEqual(h.responses, [{ requestId: 'research-1', response: { behavior: 'allow', selectedActionId: 'allow' } }]);
  finish(); await Promise.all([first, duplicate]);
  assert.equal(h.state.canRespond('agent-1', card), false);
  assert.equal(h.state.isBusy('agent-1', card.permissionId), false);
});

test('research cancel denies and interrupts; a failed action remains retryable', async t => {
  const h = harness(); t.after(() => h.state.close()); await flush();
  h.respondWith(Promise.resolve(), new Error('transport unavailable'));
  await assert.rejects(h.state.respond('agent-1', card, 'deny'), /transport/);
  assert.equal(h.state.isBusy('agent-1', card.permissionId), false);
  assert.equal(h.state.canRespond('agent-1', card), true);
  h.respondWith(Promise.resolve());
  await h.state.respond('agent-1', card, 'deny');
  assert.deepEqual(h.responses[1], { requestId: 'research-1', response: {
    behavior: 'deny', selectedActionId: 'deny', interrupt: true, message: '사용자가 조사 계획을 취소했습니다.',
  } });
});

test('plugin cleanup releases its observation and prevents an in-flight refresh from approving', async () => {
  const h = harness(); await flush();
  let finish!: () => void;
  h.refreshWith(agent(), new Promise(resolve => { finish = resolve; }));
  const responding = h.state.respond('agent-1', card, 'allow');
  h.state.close(); h.state.close(); finish(); await responding;
  assert.deepEqual(h.cleanupCounts(), { releases: 1, unsubscriptions: 1, aborted: true });
  assert.equal(h.responses.length, 0);
  assert.equal(h.state.canRespond('agent-1', card), false);
});

test('only original Gemini conversation URLs can be opened from a research card', () => {
  assert.equal(isGeminiResearchUrl('https://gemini.google.com/app/research_1'), true);
  for (const url of [undefined, 'javascript:alert(1)', 'https://gemini.google.com.evil.example/app/test', 'https://user@gemini.google.com/app/test', 'https://gemini.google.com/app/test?redirect=https://evil.example']) {
    assert.equal(isGeminiResearchUrl(url), false);
  }
});
