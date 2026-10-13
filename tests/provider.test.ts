import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderEventSchema, type ProviderEvent, type ProviderSessionConfig } from '@getpaseo/plugin/server/provider';
import { createProvider } from '../server/provider';
import type { SendOptions } from '../server/gemini-browser';
import { researchCardSchema } from '../shared/research';

const config: ProviderSessionConfig = { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true, mode: 'ask' };
const requestText = '```json\n{"protocol":"paseo_tool","id":"write-1","tool":"write_file","arguments":{"path":"demo.txt","content":"hello"}}\n```';

async function setup(replies = ['hello'], mode = 'ask', controls: {
  stop?: () => Promise<void>;
  configure?: (browserId: string, thinking: 'low' | 'medium' | 'high') => Promise<void>;
  readResearchReport?: () => Promise<{ text: string; url: string }>;
  snapshots?: string[];
  research?: (options: SendOptions) => Promise<void>;
} = {}) {
  const events: ProviderEvent[] = [];
  const sent: string[] = [];
  let writes = 0;
  const connection = await createProvider({
    connectTools: async () => ({ call: async () => ({}), close: async () => {} }),
    createBrowser: () => ({
      open: async () => ({ browserId: 'tab-1', url: 'https://gemini.google.com/app/testchat' }),
      configure: controls.configure ?? (async () => {}), stop: controls.stop ?? (async () => {}), close: async () => {},
      readResearchReport: controls.readResearchReport ?? (async () => ({ text: 'existing report', url: 'https://gemini.google.com/app/testchat' })),
      send: async (_id: string, _text: string, options: SendOptions) => {
        sent.push(_text);
        await controls.research?.(options);
        for (const snapshot of controls.snapshots ?? []) options.onText(snapshot);
        const text = replies.shift() ?? 'done'; options.onText(text);
        return { text, url: 'https://gemini.google.com/app/testchat' };
      },
    }),
    createExecutor: () => ({ validate: async () => {}, execute: async () => { writes++; return 'written'; } }),
  }).connect({ versions: [1], capabilities: ['prompt.message', 'session.configure', 'session.persistence', 'permission', 'timeline.plugin'] });
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  await connection.send({ type: 'session.open', requestId: 'open-1', sessionId: 's1', config: { ...config, mode }, history: 'skip' });
  const prompt = (clientMessageId = 'm1', text = 'hello') => connection.send({ type: 'session.prompt', sessionId: 's1', prompt: { clientMessageId, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } } });
  return { connection, events, prompt, sent, writes: () => writes };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Event not received'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('a message produces one disposition, a response and one terminal turn', async () => {
  const h = await setup(['hello'], 'chat');
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(h.events.filter(e => e.type === 'session.prompt_result').length, 1);
  assert.equal(h.events.filter(e => e.type === 'session.turn' && e.state !== 'started').length, 1);
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'hello'));
  await h.connection.close();
});

test('research icon state follows confirmed settings and preserves its native toggle identity', async (t) => {
  const h = await setup([], 'chat');
  t.after(() => h.connection.close());
  const feature = () => {
    const event = h.events.filter(e => e.type === 'session.config').at(-1)!;
    assert.equal(event.type, 'session.config');
    return event.config.settings.find(setting => setting.id === 'deep_research')!;
  };
  assert.equal(feature().type, 'toggle');
  assert.equal(feature().label, 'Deep Research · 꺼짐');
  await h.connection.send({ type: 'session.configure', requestId: 'on', sessionId: 's1', changes: { settings: { deep_research: true } } });
  assert.equal(feature().value, true);
  assert.equal(feature().label, 'Deep Research · 켜짐');
  await h.connection.send({ type: 'session.configure', requestId: 'bad', sessionId: 's1', changes: { settings: { deep_research: 'true' } } });
  assert.equal(feature().value, true);
  assert.equal(feature().label, 'Deep Research · 켜짐');
  await h.connection.send({ type: 'session.configure', requestId: 'off', sessionId: 's1', changes: { settings: { deep_research: false } } });
  assert.equal(feature().value, false);
  assert.equal(feature().label, 'Deep Research · 꺼짐');
  assert.equal(h.sent.length, 0);
});

test('research publishes one persistent plan card, waits for approval, and updates progress through completion', async (t) => {
  const finish = deferred();
  let began = false;
  const h = await setup(['Final report'], 'chat', { research: async options => {
    if (!await options.onResearchPlan!('Research example.com using IANA official sources.')) throw new Error('denied');
    began = true;
    options.onStatus?.('웹사이트 3개 조사 중…');
    await finish.promise;
  } });
  t.after(async () => { finish.resolve(); await h.connection.close(); });
  await h.connection.send({ type: 'session.configure', requestId: 'research-on', sessionId: 's1', changes: { settings: { deep_research: true } } });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const permission = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(permission.type, 'session.permission');
  const cards = () => h.events.flatMap(e => e.type === 'timeline.item' && e.item.type === 'plugin' ? [{ id: e.item.id, data: researchCardSchema.parse(e.item.data) }] : []);
  assert.equal(began, false);
  assert.equal(cards().at(-1)?.data.phase, 'plan');
  assert.equal(cards().at(-1)?.data.permissionId, permission.request.id);
  assert.match(cards().at(-1)!.data.plan!, /IANA/);
  assert.equal(permission.request.actions?.[0].label, '연구 시작');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: permission.request.id, response: { behavior: 'allow' } });
  await until(() => began);
  assert.equal(cards().at(-1)?.data.phase, 'researching');
  assert.equal(cards().at(-1)?.data.status, '웹사이트 3개 조사 중…');
  assert.equal(cards().at(-1)?.data.permissionId, undefined);
  finish.resolve();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(cards().at(-1)?.data.phase, 'completed');
  assert.equal(new Set(cards().map(card => card.id)).size, 1);
  assert.equal(h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message').length, 1);
});

test('declining a research plan cancels the card and never starts research or reports failure', async (t) => {
  let began = false;
  const h = await setup([], 'chat', { research: async options => {
    if (!await options.onResearchPlan!('A plan awaiting approval')) throw new Error('plan not approved');
    began = true;
  } });
  t.after(() => h.connection.close());
  await h.connection.send({ type: 'session.configure', requestId: 'research-on', sessionId: 's1', changes: { settings: { deep_research: true } } });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const p = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(p.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: p.request.id, response: { behavior: 'deny' } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state !== 'started'));
  assert.equal(began, false);
  assert.ok(h.events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
  const cards = h.events.flatMap(e => e.type === 'timeline.item' && e.item.type === 'plugin' ? [researchCardSchema.parse(e.item.data)] : []);
  assert.equal(cards.at(-1)?.phase, 'canceled');
  assert.equal(cards.at(-1)?.permissionId, undefined);
  assert.ok(!h.events.some(e => e.type === 'timeline.item' && e.item.type === 'error'));
});

test('research cards stay below the host byte limit even with JSON-escaped plan and progress text', async (t) => {
  const h = await setup([], 'chat', { research: async options => {
    if (await options.onResearchPlan!('\u0000'.repeat(16000))) options.onStatus?.('\u0000'.repeat(4000));
  } });
  t.after(() => h.connection.close());
  await h.connection.send({ type: 'session.configure', requestId: 'research-on', sessionId: 's1', changes: { settings: { deep_research: true } } });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const permission = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(permission.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: permission.request.id, response: { behavior: 'allow' } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  for (const event of h.events) if (event.type === 'timeline.item' && event.item.type === 'plugin') {
    assert.ok(Buffer.byteLength(JSON.stringify(event.item.data), 'utf8') < 65536);
  }
});

test('revised web Markdown is emitted only once as the final assistant text', async (t) => {
  const h = await setup(['**world**'], 'chat', { snapshots: ['**wor**', '**worl**'] });
  t.after(() => h.connection.close());
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  const messages = h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message');
  assert.equal(messages.length, 1, 'Paseo appends non-prefix revisions, so provisional web Markdown cannot be sent');
  assert.equal(messages[0].type, 'timeline.item');
  assert.equal(messages[0].item.type, 'assistant_message');
  assert.equal(messages[0].item.text, '**world**');
});

test('research recovery reads the existing report without configuring or submitting another Google prompt', async (t) => {
  let configured = 0, reads = 0;
  const h = await setup([], 'chat', {
    configure: async () => { configured++; },
    readResearchReport: async () => { reads++; return { text: 'Verified existing report', url: 'https://gemini.google.com/app/research' }; },
  });
  t.after(() => h.connection.close());
  await h.prompt('recover', '/research-result https://gemini.google.com/app/research');
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(configured, 0);
  assert.equal(reads, 1);
  assert.equal(h.sent.length, 0);
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'Verified existing report'));
});

test('research recovery rejects unrelated URLs before touching the report reader', async (t) => {
  let reads = 0;
  const h = await setup([], 'chat', { readResearchReport: async () => { reads++; throw new Error('must not read'); } });
  t.after(() => h.connection.close());
  await h.prompt('bad-recover', '/research-result https://example.com/app/research');
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'failed'));
  assert.equal(reads, 0);
  assert.equal(h.sent.length, 0);
});

test('write cannot execute until explicit permission and denial never writes', async () => {
  const h = await setup([requestText, 'cancelled']); await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  assert.equal(h.writes(), 0);
  assert.ok(!h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message'), 'tool JSON stays out of the assistant transcript');
  const permission = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(permission.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: permission.request.id, response: { behavior: 'deny' } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(h.writes(), 0); await h.connection.close();
});

test('approved write executes once and the model receives its result', async () => {
  const h = await setup([requestText, 'file saved']); await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const p = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(p.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: p.request.id, response: { behavior: 'allow' } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(h.writes(), 1); await h.connection.close();
});

test('read-only refuses a write without an approval escape hatch', async () => {
  const h = await setup([requestText, 'cannot write'], 'read-only'); await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(h.writes(), 0);
  assert.equal(h.events.filter(e => e.type === 'session.permission').length, 0);
  await h.connection.close();
});

test('interrupt while approval is pending cancels once and resolves the approval', async () => {
  const h = await setup([requestText]); await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  await h.connection.send({ type: 'session.interrupt', requestId: 'stop', sessionId: 's1' });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
  assert.equal(h.writes(), 0);
  assert.equal(h.events.filter(e => e.type === 'session.turn' && e.state !== 'started').length, 1);
  assert.ok(h.events.some(e => e.type === 'session.permission_resolved'));
  await h.connection.close();
});

test('restoring a non-Gemini URL fails before opening a browser', async () => {
  const h = await setup();
  await h.connection.send({ type: 'session.open', requestId: 'bad-open', sessionId: 'bad', config, history: 'skip', persistence: {version:1,data:{url:'https://example.com'}} });
  assert.ok(h.events.some(e => e.type === 'request.failed' && e.requestId === 'bad-open'));
  await h.connection.close();
});

test('an unchanged approval input echo permits the requested write regardless of key order', async (t) => {
  const h = await setup([requestText, 'file saved']);
  t.after(() => h.connection.close());
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const p = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(p.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: p.request.id,
    response: { behavior: 'allow', updatedInput: { content: 'hello', path: 'demo.txt' } } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state !== 'started'));
  assert.equal(h.writes(), 1);
  assert.match(h.sent[1], /written/);
});

test('an approval that changes tool input never executes the original or edited write', async (t) => {
  const h = await setup([requestText, 'request was changed']);
  t.after(() => h.connection.close());
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const p = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(p.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: p.request.id,
    response: { behavior: 'allow', updatedInput: { path: 'different.txt', content: 'hello' } } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state !== 'started'));
  assert.equal(h.writes(), 0);
});

test('denying permission with interrupt cancels the turn without a follow-up browser message', async (t) => {
  const h = await setup([requestText, 'must not be requested']);
  t.after(() => h.connection.close());
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  const p = h.events.find(e => e.type === 'session.permission')!;
  assert.equal(p.type, 'session.permission');
  await h.connection.send({ type: 'session.permission', sessionId: 's1', permissionId: p.request.id,
    response: { behavior: 'deny', interrupt: true } });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state !== 'started'));
  assert.equal(h.writes(), 0);
  assert.equal(h.sent.length, 1);
  const terminal = h.events.filter(e => e.type === 'session.turn' && e.state !== 'started');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type === 'session.turn' && terminal[0].state, 'canceled');
});

test('a completion handler can synchronously submit the next prompt', async (t) => {
  const h = await setup(['first answer', 'second answer'], 'chat');
  let submitted = false;
  const unsubscribe = h.connection.onEvent(event => {
    if (event.type === 'session.turn' && event.state === 'completed' && !submitted) {
      submitted = true;
      void h.prompt('m2');
    }
  });
  t.after(async () => { unsubscribe(); await h.connection.close(); });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm2'));
  const disposition = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm2')!;
  assert.equal(disposition.type, 'session.prompt_result');
  assert.equal(disposition.result.type, 'turn');
  await until(() => h.events.filter(e => e.type === 'session.turn' && e.state === 'completed').length === 2);
  assert.equal(h.sent.length, 2);
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'second answer'));
});

test('an interrupt prevents new prompts until browser stopping has finished', async (t) => {
  const stopping = deferred();
  const h = await setup([requestText, 'next answer'], 'ask', { stop: () => stopping.promise });
  let interrupting: Promise<void> | undefined;
  t.after(async () => { stopping.resolve(); await interrupting; await h.connection.close(); });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  interrupting = h.connection.send({ type: 'session.interrupt', requestId: 'stop-deferred', sessionId: 's1' });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
  await h.prompt('during-stop');
  const rejected = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'during-stop')!;
  assert.equal(rejected.type, 'session.prompt_result');
  assert.equal(rejected.result.type, 'failed');
  assert.equal(h.sent.length, 1);
  stopping.resolve();
  await interrupting;
  await h.prompt('after-stop');
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  const accepted = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'after-stop')!;
  assert.equal(accepted.type, 'session.prompt_result');
  assert.equal(accepted.result.type, 'turn');
  assert.equal(h.sent.length, 2);
});

test('closing rejects prompt reentry while the browser is still stopping', async (t) => {
  const stopping = deferred();
  const h = await setup([requestText, 'must not be requested'], 'ask', { stop: () => stopping.promise });
  let closing: Promise<void> | undefined;
  t.after(async () => { stopping.resolve(); await closing; await h.connection.close(); });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.permission'));
  closing = h.connection.send({ type: 'session.close', requestId: 'close-deferred', sessionId: 's1' });
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
  await h.prompt('during-close');
  const rejected = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'during-close')!;
  assert.equal(rejected.type, 'session.prompt_result');
  assert.equal(rejected.result.type, 'failed');
  assert.equal(h.sent.length, 1);
  stopping.resolve();
  await closing;
  assert.equal(h.events.filter(e => e.type === 'session.closed').length, 1);
});

test('changing configuration blocks prompts until the browser has applied the setting', async (t) => {
  const applying = deferred();
  const h = await setup(['first answer', 'next answer'], 'chat', {
    configure: async (_browserId, thinking) => { if (thinking === 'high') await applying.promise; },
  });
  let configuring: Promise<void> | undefined;
  t.after(async () => { applying.resolve(); await configuring; await h.connection.close(); });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  configuring = h.connection.send({ type: 'session.configure', requestId: 'configure-high', sessionId: 's1', changes: { thinkingOption: 'high' } });
  await h.prompt('during-configure');
  const rejected = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'during-configure')!;
  assert.equal(rejected.type, 'session.prompt_result');
  assert.equal(rejected.result.type, 'failed');
  assert.equal(h.sent.length, 1);
  applying.resolve();
  await configuring;
  await h.prompt('after-configure');
  await until(() => h.events.filter(e => e.type === 'session.turn' && e.state === 'completed').length === 2);
  const accepted = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'after-configure')!;
  assert.equal(accepted.type, 'session.prompt_result');
  assert.equal(accepted.result.type, 'turn');
  assert.equal(h.sent.length, 2);
});

test('changing configuration rejects a parallel settings request', async (t) => {
  const applying = deferred();
  const h = await setup(['first answer'], 'chat', {
    configure: async (_browserId, thinking) => { if (thinking === 'high') await applying.promise; },
  });
  let configuring: Promise<void> | undefined;
  t.after(async () => { applying.resolve(); await configuring; await h.connection.close(); });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  configuring = h.connection.send({ type: 'session.configure', requestId: 'configure-high', sessionId: 's1', changes: { thinkingOption: 'high' } });
  await h.connection.send({ type: 'session.configure', requestId: 'parallel-configure', sessionId: 's1', changes: { thinkingOption: 'low' } });
  assert.ok(h.events.some(e => e.type === 'request.failed' && e.requestId === 'parallel-configure'));
  assert.ok(!h.events.some(e => e.type === 'request.completed' && e.requestId === 'parallel-configure'));
  applying.resolve();
  await configuring;
  assert.ok(h.events.some(e => e.type === 'request.completed' && e.requestId === 'configure-high'));
});

test('closing waits for configuration and rejects new work throughout shutdown', async (t) => {
  const applying = deferred();
  const h = await setup(['first answer'], 'chat', {
    configure: async (_browserId, thinking) => { if (thinking === 'high') await applying.promise; },
  });
  let configuring: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  t.after(async () => { applying.resolve(); await configuring; await closing; await h.connection.close(); });
  await h.prompt();
  await until(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  configuring = h.connection.send({ type: 'session.configure', requestId: 'configure-before-close', sessionId: 's1', changes: { thinkingOption: 'high' } });
  closing = h.connection.send({ type: 'session.close', requestId: 'close-during-configure', sessionId: 's1' });
  await new Promise<void>(resolve => setImmediate(resolve));
  await h.prompt('during-configure-close');
  const rejected = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'during-configure-close')!;
  assert.equal(rejected.type, 'session.prompt_result');
  assert.equal(rejected.result.type, 'failed');
  assert.equal(h.events.filter(e => e.type === 'session.closed').length, 0, 'the tab must stay owned until in-flight configuration settles');
  assert.ok(!h.events.some(e => e.type === 'request.completed' && e.requestId === 'close-during-configure'));
  applying.resolve();
  await configuring;
  await closing;
  assert.equal(h.events.filter(e => e.type === 'session.closed').length, 1);
  const closedIndex = h.events.findIndex(e => e.type === 'session.closed');
  assert.ok(!h.events.slice(closedIndex + 1).some(e => e.type === 'session.config'));
});
