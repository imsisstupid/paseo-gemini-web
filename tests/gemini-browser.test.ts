import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { GeminiBrowser, parseGeminiSnapshot, type BrowserTools } from '../server/gemini-browser';
import { GEMINI_DOM_FUNCTION_SOURCE } from '../shared/gemini-scripts';

const composer = `    - textbox "Gemini 프롬프트 입력" [ref=@inputOuter]
      - textbox [ref=@input]
    - button "업로드 및 도구" [expanded=false ref=@tools]
    - group
      - button "모드 선택 도구 열기, 현재 Argon 모드 사용 중" [expanded=false ref=@model]
        - text: "Argon"`;
const response = (text: string, done = true) => `    - heading "말씀하신 내용 A question" [level=5]
      - text: "A question"
    - text: "A question"
    - heading "Gemini의 응답" [level=6]
      - text: "Gemini의 응답"
    - text: ${JSON.stringify(text)}
${done ? '    - button "대답이 마음에 들어요" [ref=@like]\n    - button "복사" [ref=@copy]' : ''}`;
const page = (body = '', busy = false) => `- document "Google Gemini"
  - main
    - navigation "Sidebar"
      - link "Unrelated private conversation" [ref=@private]
    - heading "Gemini와의 대화" [level=1]
${body}
${composer}
${busy ? '    - button "대답 생성 중지" [ref=@stop]' : '    - button "음성기록" [ref=@mic]'}
    - text: "Gemini disclaimer"
  - region "Notifications"`;

test('snapshot extraction returns assistant bodies without user, account, toolbar, or disclaimer text', () => {
  const result = parseGeminiSnapshot(page(response('First answer') + '\n' + response('Final answer')));
  assert.deepEqual(result.responses.map(item => item.text), ['First answer', 'Final answer']);
  assert.equal(result.responses[1].complete, true);
  assert.equal(result.promptRef, '@input');
  assert.equal(result.generating, false);
});

test('snapshot extraction preserves code, headings and link labels without duplicated accessible names', () => {
  const body = `    - heading "Gemini said" [level=6]
      - text: "Gemini said"
    - heading "Example" [level=2]
      - text: "Example"
    - paragraph
      - text: "Read "
      - link "the guide" [ref=@guide]
        - text: "the guide"
    - code
      - text: "const n = 1;\\nconsole.log(n);"
    - button "Good response" [ref=@like]`;
  assert.equal(parseGeminiSnapshot(page(body)).responses[0].text,
    '## Example\nRead\nthe guide\n```\nconst n = 1;\nconsole.log(n);\n```');
});

test('generation and completion are determined from response boundaries, never a stable partial answer', () => {
  const result = parseGeminiSnapshot(page(response('Still working', false), true));
  assert.equal(result.generating, true);
  assert.equal(result.responses[0].complete, false);
});

type Frame = { snapshot: string; truncated?: boolean; url?: string };
class FixtureBrowser implements BrowserTools {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  submitted = false;
  stopped = false;
  poll = 0;
  constructor(readonly frames: Frame[], readonly before = page()) {}
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    this.calls.push({ name, args });
    if (name === 'gemini_dom') throw Object.assign(new Error('Desktop unavailable'), { code: 'GEMINI_DOM_UNAVAILABLE' });
    if (name === 'browser_evaluate') throw new Error("Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements.");
    if (name === 'browser_snapshot') {
      const frame = this.submitted ? this.frames[Math.min(this.poll++, this.frames.length - 1)] : { snapshot: this.before };
      return { command: 'snapshot', browserId: 'tab', url: 'https://gemini.google.com/app/test', truncated: false, ...frame };
    }
    if (name === 'browser_fill') {
      assert.equal(args.ref, '@input');
      assert.equal(typeof args.value, 'string');
      this.beforeFill = true;
    }
    if (name === 'browser_click' && args.ref === '@send') {
      assert.equal(this.beforeFill, true);
      this.submitted = true;
    }
    if (name === 'browser_click' && args.ref === '@stop') this.stopped = true;
    if (name === 'browser_new_tab') return { command: 'new_tab', browserId: 'tab', url: args.url };
    return { command: name.replace('browser_', ''), browserId: 'tab' };
  }
  beforeFill = false;
}
const readyPage = () => page() + '\n    - button "메시지 보내기" [ref=@send]';
const options = (overrides: Partial<Parameters<GeminiBrowser['send']>[2]> = {}) => ({
  signal: new AbortController().signal, deepResearch: false, onText: () => {}, ...overrides,
});

test('send waits through stable partial output and returns only the new assistant answer', async () => {
  const old = response('Old answer');
  const tools = new FixtureBrowser([
    { snapshot: page(old) },
    { snapshot: page(old + '\n' + response('A', false), true) },
    { snapshot: page(old + '\n' + response('A', false), true) },
    { snapshot: page(old + '\n' + response('A complete answer')) },
  ], readyPage().replace(composer, old + '\n' + composer));
  const chunks: string[] = [];
  const status: string[] = [];
  const browser = new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 1000 });
  const result = await browser.send('tab', 'My question', options({ onText: text => chunks.push(text), onStatus: text => status.push(text) }));
  assert.equal(result.text, 'A complete answer');
  assert.deepEqual(chunks, ['A', 'A complete answer']);
  assert.ok(status.some(text => /accessibility|접근성/i.test(text)));
});

test('send cancels browser generation and rejects AbortError', async () => {
  const controller = new AbortController();
  const tools = new FixtureBrowser([{ snapshot: page(response('Partial', false), true) }], readyPage());
  const browser = new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 1000 });
  await assert.rejects(browser.send('tab', 'Question', options({ signal: controller.signal, onText: () => controller.abort() })), { name: 'AbortError' });
  assert.equal(tools.stopped, true);
});

test('send fails visibly when a snapshot truncates the response', async () => {
  const tools = new FixtureBrowser([{ snapshot: page(response('Partial', false), true).split(composer)[0] + '\n- text: "Snapshot truncated."', truncated: true }], readyPage());
  const browser = new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 1000 });
  await assert.rejects(browser.send('tab', 'Question', options()), /truncat|잘렸/i);
});

test('login screens fail before any prompt is submitted', async () => {
  const tools = new FixtureBrowser([], '- document "Gemini"\n  - link "Sign in" [ref=@login]');
  const browser = new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 30 });
  await assert.rejects(browser.send('tab', 'Question', options()), /sign.in|log.in|로그인/i);
  assert.equal(tools.submitted, false);
});

test('send refuses another model instead of silently substituting for Argon', async () => {
  const tools = new FixtureBrowser([], readyPage().replaceAll('Argon', 'Flash'));
  await assert.rejects(new GeminiBrowser(tools).send('tab', 'Question', options()), /Argon/);
  assert.equal(tools.submitted, false);
});

test('a truncated menu with no research control reports uncertainty before submission', async () => {
  const tools = new FixtureBrowser([], readyPage());
  await assert.rejects(new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 30 }).send('tab', 'Research', options({ deepResearch: true })), /Deep Research/);
  assert.equal(tools.submitted, false);
});

test('open only accepts Gemini conversation URLs', async () => {
  const tools = new FixtureBrowser([]);
  await assert.rejects(new GeminiBrowser(tools).open('https://example.com'), /Gemini/);
  assert.equal(tools.calls.length, 0);
});

function domFixture(body: string) {
  const dom = new JSDOM(`<body>${body}</body>`, { url: 'https://gemini.google.com/app/fixture', runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return [{ width: 1, height: 1 }]; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  const run = dom.window.eval(`(${GEMINI_DOM_FUNCTION_SOURCE})`) as (command: Record<string, unknown>) => any;
  return { dom, run };
}
const domComposer = '<div contenteditable="true" role="textbox" aria-label="Gemini prompt"></div><button aria-label="Open mode picker, current mode Argon">Argon</button><button aria-label="Send message">Send</button>';

test('fixed DOM inspection reconstructs executable tool fences only from actual language markers', () => {
  const { dom, run } = domFixture(`<nav>Private sidebar text</nav><user-query>Question</user-query>
    <model-response><message-content><div class="markdown"><h2>Answer</h2><p>See <a href="https://example.com/guide">guide</a>.</p>
      <code-block><div class="code-block-decoration"><span>paseo_tool</span><button>Copy code</button></div><pre><code>{"tool":"read_file","arguments":{"path":"README.md"}}</code></pre></code-block>
    </div></message-content><button aria-label="Good response">Like</button></model-response>${domComposer}`);
  const result = run({ kind: 'inspect' });
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].complete, true);
  assert.equal(result.responses[0].text, '## Answer\n\nSee [guide](https://example.com/guide).\n\n```paseo_tool\n{"tool":"read_file","arguments":{"path":"README.md"}}\n```');
  assert.equal(result.model, 'Argon');
  dom.window.close();
});

test('fixed DOM actions select unreferenced research menu items and fill only the prompt editor', () => {
  const { dom, run } = domFixture(`${domComposer}<div role="menuitemcheckbox"><span>Deep Research</span></div>`);
  let selected = false;
  dom.window.document.querySelector('[role=menuitemcheckbox]')!.addEventListener('click', () => { selected = true; });
  run({ kind: 'click', target: 'research' });
  run({ kind: 'fill', text: '<script>not markup</script>\nSecond line' });
  assert.equal(selected, true);
  assert.equal(dom.window.document.querySelector('[contenteditable]')!.textContent, '<script>not markup</script>\nSecond line');
  assert.equal(dom.window.document.querySelector('script'), null);
  dom.window.close();
});

test('fixed DOM actions reject disabled targets and never fall back to another model', () => {
  const { dom, run } = domFixture(`${domComposer}<button role="menuitem" disabled>4 Argon Complex tasks</button><button role="menuitem">Flash</button>`);
  assert.throws(() => run({ kind: 'click', target: 'argon' }), /disabled|unavailable/i);
  dom.window.close();
});

test('DOM serialization preserves code blank lines and spaces and uses a fence longer than embedded backticks', () => {
  const code = 'line with two spaces  \n\n\n````\nnext line\n';
  const { dom, run } = domFixture(`<model-response><message-content><div class="markdown"><pre><code class="language-text"></code></pre></div></message-content></model-response>${domComposer}`);
  dom.window.document.querySelector('code')!.textContent = code;
  assert.equal(run({ kind: 'inspect' }).responses[0].text, '`````text\n' + code + '`````');
  dom.window.close();
});

test('assistant completion remains detectable when its sibling toolbar has not painted', () => {
  const { dom, run } = domFixture(`<model-response><message-content><div class="markdown">Finished</div></message-content></model-response><div class="response-footer"><button aria-label="Good response">Like</button></div>${domComposer}`);
  const rating = dom.window.document.querySelector('.response-footer button')!;
  Object.defineProperty(rating, 'getClientRects', { value: () => [] });
  assert.equal(run({ kind: 'inspect' }).responses[0].complete, true);
  dom.window.close();
});

test('DOM inspection reads thinking from the current model label and selected submenu checkmark', () => {
  const { dom, run } = domFixture(domComposer.replace('current mode Argon', 'current mode Argon Medium'));
  assert.equal(run({ kind: 'inspect' }).thinking, 'medium');
  dom.window.document.querySelector('[aria-label*="mode picker"]')!.setAttribute('aria-label', 'Open mode picker, current mode Argon');
  const item = dom.window.document.createElement('button');
  item.setAttribute('role', 'menuitem');
  item.innerHTML = '<span>Low Quick and efficient</span><mat-icon>check</mat-icon>';
  dom.window.document.body.append(item);
  assert.equal(run({ kind: 'inspect' }).thinking, 'low');
  dom.window.close();
});

test('Korean Deep Research deselection chip is detected and actionable', () => {
  const { dom, run } = domFixture(`${domComposer}<button aria-label="Deep Research 선택 해제">Deep Research</button>`);
  assert.equal(run({ kind: 'inspect' }).researchSelected, true);
  const chip = dom.window.document.querySelector('[aria-label="Deep Research 선택 해제"]')!;
  chip.addEventListener('click', () => chip.remove());
  run({ kind: 'click', target: 'research' });
  assert.equal(run({ kind: 'inspect' }).researchSelected, false);
  dom.window.close();
});

test('a disabled start button on an approved old research plan does not keep approval pending', () => {
  const { dom, run } = domFixture(`${domComposer}<model-response><button aria-label="연구 시작" disabled>연구 시작</button></model-response>`);
  assert.equal(run({ kind: 'inspect' }).researchPlanReady, false);
  dom.window.close();
});

test('research progress status prevents an acknowledgement from becoming a final report', async () => {
  const { dom, run } = domFixture(`${domComposer}<model-response><message-content><div class="markdown">I will let you know when research is done.</div></message-content><div role="status">조사 시작 중...</div><button aria-label="Good response">Like</button></model-response>`);
  assert.equal(run({ kind: 'inspect' }).researchRunning, true);
  dom.window.close();
  const tools = new DomBrowser([
    { responses: [{ text: 'Plan', complete: true }], researchPlanReady: true },
    { responses: [{ text: 'Plan', complete: true }], researchPlanReady: true },
    { responses: [{ text: 'I will let you know when research is done.', complete: true }], researchRunning: true },
    { responses: [{ text: 'Actual report', complete: true }], researchRunning: false, researchReport: { text: 'Actual report', complete: true } },
  ]);
  const result = await new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 1000 }).send('tab', 'Research', options({ deepResearch: true, onResearchPlan: async () => true }));
  assert.equal(result.text, 'Actual report');
});

test('Deep Research without the desktop DOM bridge fails before submitting or approving a query', async () => {
  const before = readyPage() + '\n    - button "Deep Research 선택 해제" [ref=@research]';
  const plan = page(response('Research plan')) + '\n    - button "리서치 시작" [ref=@start]';
  const tools = new FixtureBrowser([{ snapshot: plan }], before);
  let approvals = 0;
  await assert.rejects(new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).send('tab', 'Research', options({ deepResearch: true, onResearchPlan: async () => { approvals++; return true; } })), /desktop.*bridge/i);
  assert.equal(tools.submitted, false);
  assert.equal(tools.beforeFill, false);
  assert.equal(approvals, 0);
});

test('open waits for the newly created tab to commit its Gemini URL', async () => {
  const tools = new FixtureBrowser([]);
  const result = await new GeminiBrowser(tools).open();
  assert.equal(result.browserId, 'tab');
  assert.ok(tools.calls.some(call => call.name === 'browser_wait' && call.args.url === 'gemini.google.com'));
});

class DomBrowser extends FixtureBrowser {
  planApproved = false;
  selection = false;
  selectedEffort = '';
  openedModel = false;
  openedThinking = false;
  constructor(readonly inspections: any[] = []) { super([]); }
  override async call(name: string, args: Record<string, unknown>): Promise<any> {
    if (name !== 'gemini_dom') throw new Error('DOM mode must not rely on truncated accessibility snapshots');
    const command = args.command as { kind: string; target?: string; text?: string };
    this.calls.push({ name, args });
    if (command.kind === 'fill') { this.beforeFill = true; return { filled: true }; }
    if (command.kind === 'click') {
      if (command.target === 'send') { assert.ok(this.beforeFill); this.submitted = true; }
      if (command.target === 'stop') this.stopped = true;
      if (command.target === 'start-research') this.planApproved = true;
      if (command.target === 'research') this.selection = !this.selection;
      if (command.target === 'model') this.openedModel = true;
      if (command.target === 'argon') this.openedModel = false;
      if (command.target === 'thinking') this.openedThinking = true;
      if (['low', 'medium', 'high'].includes(command.target ?? '')) this.selectedEffort = command.target!;
      return { clicked: true, target: command.target };
    }
    const frame = this.submitted ? this.inspections[Math.min(this.poll++, this.inspections.length - 1)] : {};
    return { url: 'https://gemini.google.com/app/dom-test', model: 'Argon', thinking: this.selectedEffort || 'low', responses: [], generating: false, loginRequired: false,
      promptAvailable: true, researchSelected: this.selection, researchPlanReady: false,
      controls: { model: true, argon: this.openedModel, thinking: this.openedModel, low: this.openedThinking, medium: this.openedThinking, high: this.openedThinking,
        tools: true, 'more-tools': true, research: true, send: true, stop: true, 'start-research': true }, ...frame };
  }
}

test('DOM adapter handles long responses without snapshot truncation', async () => {
  const answer = 'Long response '.repeat(3000);
  const tools = new DomBrowser([{ responses: [{ text: answer, complete: true }] }]);
  const result = await new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).send('tab', 'Question', options());
  assert.equal(result.text, answer);
});

test('DOM configuration actually selects Argon and every offered effort level', async () => {
  for (const level of ['low', 'medium', 'high'] as const) {
    const tools = new DomBrowser();
    await new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).configure('tab', level);
    assert.equal(tools.selectedEffort, level);
  }
});

test('configuration fails when the selected thinking level does not match the requested level', async () => {
  const tools = new DomBrowser();
  const call = tools.call.bind(tools);
  tools.call = async (name, args) => {
    const result = await call(name, args);
    if ((args.command as any)?.kind === 'inspect') result.thinking = 'low';
    return result;
  };
  await assert.rejects(new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 20 }).configure('tab', 'high'), /thinking|effort/i);
});

test('accessibility configuration verifies the selected effort instead of trusting a click', async () => {
  const menu = `\n    - menu\n      - menuitem "4 Argon 복잡한 작업" [ref=@argon]\n      - menuitem "사고 수준" [ref=@thinking]\n      - menuitem "최고가 매우 철저함" [ref=@high]`;
  const wrong = new FixtureBrowser([], (readyPage() + menu).replace('현재 Argon 모드', '현재 Argon 보통 모드'));
  await assert.rejects(new GeminiBrowser(wrong, { pollMs: 1, timeoutMs: 20 }).configure('tab', 'high'), /verify|thinking|effort/i);
  const right = new FixtureBrowser([], (readyPage() + menu).replace('현재 Argon 모드', '현재 Argon 최고가 모드'));
  await new GeminiBrowser(right, { pollMs: 1, timeoutMs: 20 }).configure('tab', 'high');
  const unclear = new FixtureBrowser([], readyPage() + menu);
  await assert.rejects(new GeminiBrowser(unclear, { pollMs: 1, timeoutMs: 20 }).configure('tab', 'high'), /verify|thinking|effort/i);
});

test('research starts only after plan approval and emits only the completed report as answer text', async () => {
  const plan = { text: 'Research plan', complete: true };
  const tools = new DomBrowser([
    { responses: [plan], researchPlanReady: true },
    { responses: [plan], researchPlanReady: true },
    { responses: [{ text: 'Researching 22 sites...', complete: true }], researchRunning: true, researchStatus: 'Researching 22 sites...' },
    { responses: [{ text: 'Finished report', complete: true }], researchReport: { text: 'Finished report', complete: true } },
  ]);
  let approvals = 0;
  const chunks: string[] = [];
  const statuses: string[] = [];
  const result = await new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 1000 }).send('tab', 'Research', options({ deepResearch: true,
    onText: text => chunks.push(text),
    onStatus: text => statuses.push(text),
    onResearchPlan: async (text: string, url?: string) => {
      assert.equal(text, 'Research plan');
      assert.equal(url, 'https://gemini.google.com/app/dom-test');
      assert.equal(tools.planApproved, false);
      approvals++;
      return true;
    } }));
  assert.equal(approvals, 1);
  assert.equal(tools.planApproved, true);
  assert.equal(result.text, 'Finished report');
  assert.deepEqual(chunks, ['Finished report']);
  assert.ok(statuses.includes('Researching 22 sites...'));
});

for (const phase of ['running', 'completed'] as const) {
  test(`research already ${phase} in Gemini while Paseo approval is pending continues without clicking Start again`, async () => {
    const tools = new DomBrowser([{ responses: [{ text: 'Research plan', complete: true }], researchPlanReady: true }]);
    let approve!: (accepted: boolean) => void;
    let notifyRequested!: () => void;
    const permission = new Promise<boolean>(resolve => { approve = resolve; });
    const requested = new Promise<void>(resolve => { notifyRequested = resolve; });
    const chunks: string[] = [];
    const send = new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).send('tab', 'Research', options({
      deepResearch: true,
      onText: text => chunks.push(text),
      onResearchPlan: async () => { notifyRequested(); return permission; },
    }));
    await requested;
    assert.equal(tools.planApproved, false);
    assert.deepEqual(chunks, []);
    const report = { responses: [{ text: 'Finished report', complete: true }], researchReport: { text: 'Finished report', complete: true }, controls: {} };
    tools.inspections.splice(0, tools.inspections.length,
      ...(phase === 'running' ? [{ researchRunning: true, controls: {} }] : []), report);
    tools.poll = 0;
    approve(true);
    const result = await send;
    assert.equal(result.text, 'Finished report');
    assert.equal(tools.planApproved, false);
    assert.deepEqual(chunks, ['Finished report']);
    assert.equal(tools.calls.some(call => (call.args.command as any)?.target === 'start-research'), false);
  });
}

test('declining a research plan never activates the start button', async () => {
  const tools = new DomBrowser([{ responses: [{ text: 'Research plan', complete: true }], researchPlanReady: true }]);
  await assert.rejects(new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).send('tab', 'Research', options({ deepResearch: true, onResearchPlan: async () => false })), /not approved/i);
  assert.equal(tools.planApproved, false);
});

test('existing research recovery waits for hydration and returns only the completed report without sending a prompt', async () => {
  const tools = new DomBrowser([
    { promptAvailable: false },
    { researchReport: { text: 'Recovered report with [source](https://iana.org/)', complete: true } },
  ]);
  tools.submitted = true;
  const result = await new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).readResearchReport('tab');
  assert.equal(result.text, 'Recovered report with [source](https://iana.org/)');
  assert.ok(tools.calls.every(call => (call.args.command as any).kind === 'inspect'));
});

test('research recovery refuses a running or unrecognized report instead of returning the acknowledgement', async () => {
  const tools = new DomBrowser([{ generating: true, researchRunning: true, responses: [{ text: 'Research started', complete: true }] }]);
  tools.submitted = true;
  await assert.rejects(new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 20 }).readResearchReport('tab'), /progress|running|ready/i);
  const missing = new DomBrowser([{ responses: [{ text: 'Research started', complete: true }] }]);
  missing.submitted = true;
  await assert.rejects(new GeminiBrowser(missing, { pollMs: 1, timeoutMs: 20 }).readResearchReport('tab'), /completed.*report|report.*available/i);
});

const researchFixture = readFileSync(new URL('./fixtures/gemini-research.html', import.meta.url), 'utf8');

test('actual research panel structure yields the report and its used sources, excluding progress, thoughts, and unused sources', () => {
  const { dom, run } = domFixture(researchFixture + domComposer);
  const state = run({ kind: 'inspect' });
  assert.equal(state.researchReport?.complete, true);
  assert.match(state.researchReport.text, /# IANA 공식 자료 기반/);
  assert.match(state.researchReport.text, /\[IANA-managed Reserved Domains\]\(https:\/\/www\.iana\.org\/domains\/reserved\)/);
  assert.doesNotMatch(state.researchReport.text, /completed your research|Private research thoughts|Unused research source|example\.org\/unused/);
  assert.equal((state.researchReport.text.match(/^- \[/gm) || []).length, 7);
  dom.window.close();
});

test('completed research requires the latest card to be completed, selected, and matched to its panel title', () => {
  const { dom, run } = domFixture(researchFixture + domComposer);
  const card = dom.window.document.querySelector('gem-processing-card')!;
  card.classList.remove('selected');
  assert.equal(run({ kind: 'inspect' }).researchReport, undefined);
  card.classList.add('selected');
  const title = dom.window.document.querySelector('deep-research-immersive-panel toolbar .title-text')!;
  title.textContent = 'A different older report';
  assert.equal(run({ kind: 'inspect' }).researchReport, undefined);
  title.textContent = card.querySelector('.card-title')!.textContent;
  dom.window.document.body.insertAdjacentHTML('beforeend', '<model-response><immersive-entry-chip><gem-processing-card class="processing selected" role="status"><span class="card-title">New report</span></gem-processing-card></immersive-entry-chip></model-response>');
  const state = run({ kind: 'inspect' });
  assert.equal(state.researchRunning, true);
  assert.equal(state.researchReport, undefined);
  assert.equal(state.controls['open-report'], false);
  assert.throws(() => run({ kind: 'click', target: 'open-report' }), /unavailable|disabled/i);
  dom.window.close();
});

test('a new research plan blocks an older report and an old plan cannot request approval during the current report', () => {
  const oldPlan = '<model-response><deep-research-confirmation-widget><button aria-label="연구 시작">연구 시작</button></deep-research-confirmation-widget></model-response>';
  const { dom, run } = domFixture(oldPlan + researchFixture + domComposer);
  assert.equal(run({ kind: 'inspect' }).researchPlanReady, false);
  assert.ok(run({ kind: 'inspect' }).researchReport);
  dom.window.document.body.insertAdjacentHTML('beforeend', oldPlan);
  assert.equal(run({ kind: 'inspect' }).researchPlanReady, true);
  assert.equal(run({ kind: 'inspect' }).researchReport, undefined);
  assert.equal(run({ kind: 'inspect' }).controls['open-report'], false);
  dom.window.close();
});

test('open-report activates only the latest completed research card', () => {
  const { dom, run } = domFixture(researchFixture + domComposer);
  const old = dom.window.document.querySelector('gem-processing-card')!;
  old.classList.remove('selected');
  dom.window.document.body.insertAdjacentHTML('beforeend', '<model-response><immersive-entry-chip><gem-processing-card class="completed" role="status"><span class="card-title">Latest report</span></gem-processing-card></immersive-entry-chip></model-response>');
  let oldClicked = false, latestClicked = false;
  old.addEventListener('click', () => { oldClicked = true; });
  const latest = dom.window.document.querySelectorAll('gem-processing-card')[1];
  latest.addEventListener('click', () => { latestClicked = true; });
  run({ kind: 'click', target: 'open-report' });
  assert.equal(oldClicked, false);
  assert.equal(latestClicked, true);
  dom.window.close();
});

test('research recovery opens the completed card once and never sends or starts research', async () => {
  const tools = new DomBrowser([
    { controls: { 'open-report': true } },
    { controls: { 'open-report': true } },
    { researchReport: { text: 'Existing report', complete: true } },
  ]);
  tools.submitted = true;
  const result = await new GeminiBrowser(tools, { pollMs: 1, timeoutMs: 100 }).readResearchReport('tab');
  assert.equal(result.text, 'Existing report');
  const commands = tools.calls.map(call => call.args.command as any).filter(command => command.kind !== 'inspect');
  assert.deepEqual(commands, [{ kind: 'click', target: 'open-report' }]);
});
