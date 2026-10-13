/** The caller is Paseo's browser MCP connection, never a Google API client. */
export interface BrowserTools { call(name: string, args: Record<string, unknown>): Promise<any> }
export type SendOptions = {
  signal: AbortSignal;
  deepResearch: boolean;
  /** Current complete text of this response, including all text received so far. */
  onText: (text: string) => void;
  onStatus?: (text: string) => void;
  onResearchPlan?: (plan: string) => Promise<boolean>;
};
type Control = { role: string; label: string; ref?: string; attributes: string };
type Response = { text: string; complete: boolean };
type DomState = {
  url: string; model: string; thinking?: string; responses: Response[]; generating: boolean;
  loginRequired: boolean; promptAvailable: boolean; error?: string;
  researchSelected: boolean; researchPlanReady: boolean; researchRunning?: boolean; controls: Record<string, boolean>;
  researchStatus?: string;
  researchReport?: Response;
};
type Node = Control & { depth: number; children: Node[] };
export type GeminiSnapshot = {
  responses: Response[]; generating: boolean; promptRef?: string; model?: string; thinking?: 'low' | 'medium' | 'high';
  controls: Control[]; error?: string;
};
const ASSISTANT = /^(?:Gemini(?: said| responded| response|'s response)|Gemini의 응답)$/i;
const USER = /^(?:You said|Your prompt|말씀하신 내용)(?:\s|$)/i;
const STOP = /^(?:Stop(?: response| generating| generation)?|Cancel response|대답 생성 중지|응답 생성 중지|생성 중지)$/i;
const FINISHED = /^(?:Good response|Bad response|Like response|Dislike response|Retry|Try again|Regenerate|대답이 마음에 들어요|대답이 마음에 들지 않아요|다시 실행)$/i;
const MODEL = /(?:mode picker|model selector|choose (?:a )?model|select (?:a )?model|모드 선택|모델 선택)/i;
const RESEARCH = /^(?:Deep Research|심층 리서치)$/i;
const REMOVE_RESEARCH = /(?:Remove|Deselect|삭제|제거|선택 해제).*Deep Research|Deep Research.*(?:Remove|Deselect|삭제|제거|선택 해제)/i;
const START_RESEARCH = /^(?:Start research|Start researching|Begin research|리서치 시작|조사 시작|연구 시작)$/i;
const TOOLS = /^(?:Tools|Add files(?: and tools)?|Uploads? (?:&|and) tools|업로드 및 도구|도구)$/i;
const MORE_TOOLS = /^(?:More tools|도구 더보기)$/i;
const SEND = /^(?:Send(?: message| prompt)?|Submit|메시지 보내기|보내기)$/i;
const LIMIT = /(?:reached.{0,30}(?:limit|quota)|(?:limit|quota).{0,30}(?:reached|exceeded)|too many requests|한도.{0,25}(?:도달|초과)|잠시 후 다시 시도|something went wrong|문제가 발생)/i;
function effortLabel(label: string): 'low' | 'medium' | 'high' | undefined {
  if (/(?:\bMedium\b|보통|중간)/i.test(label)) return 'medium';
  if (/(?:\bHigh\b|최고가|높음|최고)/i.test(label)) return 'high';
  if (/(?:\bLow\b|\bMinimal\b|최저가|낮음|최저)/i.test(label)) return 'low';
  return undefined;
}

function parseNodes(snapshot: string): { roots: Node[]; flat: Node[] } {
  const roots: Node[] = [], flat: Node[] = [], stack: Node[] = [];
  for (const line of snapshot.split('\n')) {
    const match = /^(\s*)- ([\w-]+)(?::)?(?: ("(?:[^"\\]|\\.)*"))?(?: (\[.*\]))?\s*$/.exec(line);
    if (!match) continue;
    let label = '';
    try { if (match[3]) label = JSON.parse(match[3]); } catch { continue; }
    const attributes = match[4] ?? '';
    const node: Node = { depth: match[1].length, role: match[2], label, attributes,
      ref: /\bref=(@?[^\s\]]+)/.exec(attributes)?.[1], children: [] };
    while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node); flat.push(node);
  }
  return { roots, flat };
}

function content(nodes: Node[]): string {
  return nodes.map(node => {
    if (/^(?:button|menu|menuitem|menuitemcheckbox|textbox|navigation|status|alert|img)$/.test(node.role)) return '';
    const childText = content(node.children);
    const value = childText || node.label;
    if (node.role === 'heading' && value) {
      const level = Math.min(6, Number(/level=(\d+)/.exec(node.attributes)?.[1] ?? 2));
      return `${'#'.repeat(level)} ${value}`;
    }
    if (node.role === 'code' && value) return `\`\`\`\n${value}\n\`\`\``;
    if (node.role === 'listitem' && value) return `- ${value}`;
    return value;
  }).map(text => text.trim()).filter(Boolean).join('\n');
}

/** Parses only text following an identified assistant heading, never the whole page. */
export function parseGeminiSnapshot(snapshot: string): GeminiSnapshot {
  const { roots, flat } = parseNodes(snapshot);
  const responses: Response[] = [];
  const excluded = new Set<Node>();
  function scan(nodes: Node[]): void {
    for (let i = 0; i < nodes.length; i++) {
      const heading = nodes[i];
      if (heading.role !== 'heading' || !ASSISTANT.test(heading.label)) { scan(heading.children); continue; }
      const body: Node[] = [];
      let complete = false;
      for (let j = i + 1; j < nodes.length; j++) {
        const node = nodes[j];
        if (node.role === 'heading' && (USER.test(node.label) || ASSISTANT.test(node.label))) break;
        if (node.role === 'textbox' || node.role === 'navigation' || node.role === 'region') break;
        if (node.role === 'button' && FINISHED.test(node.label)) { complete = true; break; }
        if (node.role === 'button' && (TOOLS.test(node.label) || STOP.test(node.label))) break;
        body.push(node);
      }
      const mark = (node: Node) => { excluded.add(node); node.children.forEach(mark); };
      body.forEach(mark);
      responses.push({ text: content(body), complete });
    }
  }
  scan(roots);
  const controls = flat.filter(node => /^(?:button|link|textbox|menuitem|menuitemradio|menuitemcheckbox|option|switch)$/.test(node.role))
    .map(node => ({ role: node.role, label: node.label || content(node.children), ref: node.ref, attributes: node.attributes }));
  const inputs = controls.filter(node => node.role === 'textbox' && node.ref);
  const prompt = inputs.find(node => !node.label) ?? inputs.find(node => /Gemini.*(?:prompt|프롬프트)|Enter a prompt/i.test(node.label));
  const model = controls.find(node => node.role === 'button' && MODEL.test(node.label))?.label;
  const selectedEffort = controls.find(node => /^menuitem/.test(node.role) && /(?:checked|selected)=true/.test(node.attributes) && effortLabel(node.label));
  const uiError = flat.find(node => !excluded.has(node) && /^(?:alert|status)$/.test(node.role) && LIMIT.test(node.label || content(node.children)));
  let error = uiError ? (uiError.label || content(uiError.children)) : undefined;
  if (!prompt && controls.some(node => /^(?:Sign in|Log in|로그인)$/i.test(node.label))) error = 'Sign in to Gemini in the Paseo browser before sending a prompt.';
  return { responses, controls, promptRef: prompt?.ref, model, thinking: effortLabel(selectedEffort?.label ?? model ?? ''),
    generating: controls.some(node => node.role === 'button' && STOP.test(node.label)), error };
}

function unpack(raw: any): any {
  const result = raw?.structuredContent ?? raw;
  if (raw?.isError || result?.ok === false) throw new Error(result?.error?.message ?? raw?.content?.find((item: any) => item.type === 'text')?.text ?? 'Paseo browser command failed.');
  return result?.ok === true ? result.result : result;
}
function abortError(): Error { const error = new Error('Gemini generation cancelled.'); error.name = 'AbortError'; return error; }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class GeminiBrowser {
  private readonly tools: BrowserTools;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly accessibilityOnly = new Set<string>();
  constructor(tools: BrowserTools, options: { pollMs?: number; timeoutMs?: number } = {}) {
    this.tools = tools; this.pollMs = Math.max(1, options.pollMs ?? 1000);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 20 * 60 * 1000);
  }
  private async call(name: string, args: Record<string, unknown>): Promise<any> { return unpack(await this.tools.call(name, args)); }
  private async inspectDom(browserId: string): Promise<DomState> {
    const state = await this.call('gemini_dom', { browserId, command: { kind: 'inspect' } });
    if (!state || !Array.isArray(state.responses) || typeof state.generating !== 'boolean' || typeof state.model !== 'string' || !state.controls ||
      !state.responses.every((item: any) => typeof item.text === 'string' && typeof item.complete === 'boolean')) throw new Error('Gemini DOM inspection returned an invalid response.');
    if (state.loginRequired) throw new Error('Sign in to Gemini in the Paseo browser before sending a prompt.');
    if (state.error) throw new Error(`Gemini: ${state.error}`);
    return state;
  }
  private async tryDom(browserId: string): Promise<DomState | undefined> {
    try { return await this.inspectDom(browserId); }
    catch (error) { if ((error as { code?: string }).code === 'GEMINI_DOM_UNAVAILABLE') return undefined; throw error; }
  }
  private async waitDom(browserId: string, predicate: (state: DomState) => boolean, description: string, signal?: AbortSignal): Promise<DomState> {
    const deadline = Date.now() + Math.min(this.timeoutMs, 15000);
    do {
      checkAbort(signal);
      const state = await this.inspectDom(browserId);
      if (predicate(state)) return state;
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, 250), signal);
    } while (true);
    throw new Error(`${description} is unavailable in the current Gemini UI or model combination.`);
  }
  private async clickDom(browserId: string, target: string, signal?: AbortSignal): Promise<void> {
    await this.waitDom(browserId, state => state.controls[target] === true, `Gemini ${target} control`, signal);
    checkAbort(signal);
    await this.call('gemini_dom', { browserId, command: { kind: 'click', target } });
  }
  private async snapshot(browserId: string) {
    const raw = await this.call('browser_snapshot', { browserId });
    if (typeof raw?.snapshot !== 'string') throw new Error('Paseo returned an invalid browser snapshot.');
    const state = parseGeminiSnapshot(raw.snapshot);
    if (state.error) throw new Error(state.error);
    return { ...state, raw, url: String(raw.url ?? '') };
  }
  private async control(browserId: string, match: (node: Control) => boolean, description: string, signal?: AbortSignal): Promise<Control> {
    const deadline = Date.now() + Math.min(this.timeoutMs, 7000);
    do {
      checkAbort(signal);
      const state = await this.snapshot(browserId);
      const control = state.controls.find(match);
      if (control) {
        if (!control.ref || /disabled=true/.test(control.attributes)) throw new Error(`${description} is visible but Paseo exposes no enabled actionable reference. This browser UI cannot be automated safely.`);
        return control;
      }
      if (state.raw.truncated) throw new Error(`Paseo truncated the browser snapshot before ${description}. Open a new Gemini conversation or update Paseo's browser automation.`);
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, 250), signal);
    } while (true);
    throw new Error(`${description} is unavailable in this Gemini page. The UI, account, or model combination may not support it.`);
  }
  private async click(browserId: string, match: (node: Control) => boolean, description: string, signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const control = await this.control(browserId, match, description, signal);
      checkAbort(signal);
      try { await this.call('browser_click', { browserId, ref: control.ref }); return; }
      catch (error) { if (attempt === 2 || !/stale/i.test(String(error))) throw error; }
    }
  }
  private assertArgon(model?: string): void {
    if (!model || !/\bArgon\b/i.test(model)) throw new Error('Argon is not selected in Gemini. This provider will not substitute another model.');
  }
  private completedResearchReport(state: DomState): Response | undefined {
    const report = state.researchReport;
    return !state.generating && !state.researchRunning && report?.complete && typeof report.text === 'string' && report.text.trim() ? report : undefined;
  }
  /** Reads an existing research result without submitting or approving a new query. */
  async readResearchReport(browserId: string): Promise<{ text: string; url: string }> {
    const deadline = Date.now() + Math.min(this.timeoutMs, 15000);
    let openedReport = false;
    do {
      const state = await this.inspectDom(browserId);
      if (state.generating || state.researchRunning) throw new Error('Gemini research is still in progress. Its completed report is not ready yet.');
      const report = this.completedResearchReport(state);
      if (report) return { text: report.text, url: state.url };
      if (!openedReport && state.controls['open-report']) {
        await this.clickDom(browserId, 'open-report');
        openedReport = true;
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, 250));
    } while (true);
    throw new Error('No completed Deep Research report is available in this Gemini conversation. Open its completed report panel and retry.');
  }
  async open(url = 'https://gemini.google.com/app'): Promise<{ browserId: string; url: string }> {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://gemini.google.com' || !/^\/app(?:\/[^/]+)?\/?$/.test(parsed.pathname) || parsed.username || parsed.password) throw new Error('Only a Gemini app or conversation URL can be opened.');
    const result = await this.call('browser_new_tab', { url: parsed.toString() });
    if (typeof result.browserId !== 'string') throw new Error('Paseo did not return a browser tab ID.');
    await this.call('browser_wait', { browserId: result.browserId, url: 'gemini.google.com', timeoutMs: 7000 });
    return { browserId: result.browserId, url: String(result.url ?? parsed.toString()) };
  }
  async configure(browserId: string, thinking: 'low' | 'medium' | 'high'): Promise<void> {
    const dom = await this.tryDom(browserId);
    if (dom) {
      if (dom.generating) throw new Error('Gemini is already generating a response. Stop it before changing model settings.');
      if (!dom.controls.argon) await this.clickDom(browserId, 'model');
      await this.clickDom(browserId, 'argon');
      await this.waitDom(browserId, state => /\bArgon\b/i.test(state.model), 'Selected Argon model');
      if (!(await this.inspectDom(browserId)).controls.thinking) await this.clickDom(browserId, 'model');
      await this.clickDom(browserId, 'thinking');
      await this.clickDom(browserId, thinking);
      let confirmed = await this.inspectDom(browserId);
      let verificationMenuOpened = false;
      // Some Gemini versions show the default effort only as a checked menu item.
      if (confirmed.thinking === undefined) {
        if (!confirmed.controls.thinking) await this.clickDom(browserId, 'model');
        await this.clickDom(browserId, 'thinking');
        verificationMenuOpened = true;
      }
      confirmed = await this.waitDom(browserId, state => state.thinking === thinking, `Verification of Argon ${thinking} thinking level`);
      this.assertArgon(confirmed.model);
      if (verificationMenuOpened) await this.clickDom(browserId, 'model');
      return;
    }
    const initial = await this.snapshot(browserId);
    if (initial.generating) throw new Error('Gemini is already generating a response. Stop it before changing model settings.');
    const initialPicker = initial.controls.find(c => c.role === 'button' && MODEL.test(c.label));
    if (!initialPicker || !/expanded=true/.test(initialPicker.attributes)) await this.click(browserId, c => c.role === 'button' && MODEL.test(c.label), 'Gemini model picker');
    await this.click(browserId, c => /^menuitem/.test(c.role) && /\bArgon\b/i.test(c.label), 'Argon model');
    await this.control(browserId, c => c.role === 'button' && MODEL.test(c.label) && /\bArgon\b/i.test(c.label), 'Selected Argon model');
    const selected = await this.snapshot(browserId);
    const picker = selected.controls.find(c => c.role === 'button' && MODEL.test(c.label));
    if (!picker || !/expanded=true/.test(picker.attributes)) await this.click(browserId, c => c.role === 'button' && MODEL.test(c.label), 'Gemini model picker');
    await this.click(browserId, c => /^menuitem/.test(c.role) && /^(?:Thinking level|Thinking effort|사고 수준)$/i.test(c.label), 'Argon thinking level');
    const levels = { low: /^(?:Low|Minimal|최저가|낮음|최저)(?:\s|$)/i, medium: /^(?:Medium|보통|중간)(?:\s|$)/i, high: /^(?:High|최고가|높음|최고)(?:\s|$)/i };
    if (!levels[thinking]) throw new Error('Unknown Argon thinking level.');
    await this.click(browserId, c => /^menuitem/.test(c.role) && levels[thinking].test(c.label), `Argon ${thinking} thinking level`);
    await this.call('browser_keypress', { browserId, key: 'Escape' });
    const deadline = Date.now() + Math.min(this.timeoutMs, 7000);
    do {
      const confirmed = await this.snapshot(browserId);
      this.assertArgon(confirmed.model);
      if (confirmed.thinking === thinking) return;
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, 250));
    } while (true);
    throw new Error(`Cannot verify Argon ${thinking} thinking level from the accessibility snapshot. Reconnect the desktop DOM bridge to verify this setting.`);
  }
  private async selectResearch(browserId: string, enabled: boolean, signal: AbortSignal): Promise<void> {
    let state = await this.snapshot(browserId);
    const selected = state.controls.find(c => c.role === 'button' && REMOVE_RESEARCH.test(c.label));
    if (selected) {
      if (!enabled) await this.click(browserId, c => c.ref === selected.ref, 'Remove Deep Research', signal);
      return;
    }
    if (!enabled) return;
    await this.click(browserId, c => c.role === 'button' && TOOLS.test(c.label), 'Deep Research tools menu', signal);
    await delay(Math.min(this.pollMs, 300), signal);
    state = await this.snapshot(browserId);
    if (!state.controls.some(c => RESEARCH.test(c.label))) await this.click(browserId, c => c.role === 'button' && MORE_TOOLS.test(c.label), 'Deep Research / More tools', signal);
    await this.click(browserId, c => /^(?:menuitem|menuitemcheckbox|button)$/.test(c.role) && RESEARCH.test(c.label), 'Deep Research', signal);
    await this.call('browser_keypress', { browserId, key: 'Escape' });
    state = await this.snapshot(browserId);
    this.assertArgon(state.model);
    if (!state.controls.some(c => /Deep Research/i.test(c.label) && (c.role === 'button' || /checked=true/.test(c.attributes)))) throw new Error('Gemini did not confirm Deep Research selection. The prompt was not sent.');
  }
  private async readResponses(browserId: string, state: Awaited<ReturnType<GeminiBrowser['snapshot']>>, status?: (text: string) => void): Promise<{ responses: Response[]; generating: boolean }> {
    if (!this.accessibilityOnly.has(browserId)) {
      this.accessibilityOnly.add(browserId);
      status?.('Desktop DOM bridge unavailable; using Gemini accessibility text. Long conversations, Markdown formatting, and link URLs may be unavailable.');
    }
    if (state.raw.truncated) throw new Error('Paseo truncated the Gemini accessibility snapshot. The full response cannot be read safely; open the Gemini conversation to view it.');
    return state;
  }
  async send(browserId: string, text: string, options: SendOptions): Promise<{ text: string; url: string }> {
    const { signal, onText, onStatus } = options;
    checkAbort(signal);
    if (!text.trim()) throw new Error('A Gemini prompt cannot be empty.');
    const dom = await this.tryDom(browserId);
    if (dom) return this.sendDom(browserId, text, options, dom);
    if (options.deepResearch) throw new Error('Deep Research requires the Paseo desktop DOM bridge to read its complete report. Reconnect the desktop app before starting research.');
    let submitted = false;
    try {
      let state = await this.snapshot(browserId);
      this.assertArgon(state.model);
      if (state.generating) throw new Error('Gemini is already generating a response in this tab.');
      await this.selectResearch(browserId, options.deepResearch, signal);
      state = await this.snapshot(browserId);
      const baseline = await this.readResponses(browserId, state, onStatus);
      const count = baseline.responses.length;
      const input = await this.control(browserId, c => c.role === 'textbox' && c.ref === state.promptRef, 'Gemini prompt editor', signal);
      await this.call('browser_fill', { browserId, ref: input.ref, value: text });
      checkAbort(signal);
      await this.click(browserId, c => c.role === 'button' && SEND.test(c.label), 'Gemini Send message button', signal);
      submitted = true;
      let deadline = Date.now() + this.timeoutMs;
      let last = '', approved = false;
      while (Date.now() < deadline) {
        checkAbort(signal);
        state = await this.snapshot(browserId);
        const current = await this.readResponses(browserId, state, onStatus);
        const response = current.responses.length > count ? current.responses[current.responses.length - 1] : undefined;
        const start = state.controls.find(c => c.role === 'button' && START_RESEARCH.test(c.label) && c.ref && !/disabled=true/.test(c.attributes));
        if (start && options.deepResearch && !approved) {
          if (!response?.text) throw new Error('Gemini shows a research approval button, but the research plan could not be read.');
          if (!options.onResearchPlan) throw new Error('Deep Research requires explicit approval of its research plan before starting.');
          onStatus?.('Waiting for your approval of the Gemini research plan.');
          const accepted = await abortable(options.onResearchPlan(response.text), signal);
          checkAbort(signal);
          if (!accepted) throw new Error('Deep Research plan was not approved. Research was not started.');
          await this.click(browserId, c => c.role === 'button' && START_RESEARCH.test(c.label), 'Start research after approval', signal);
          approved = true; deadline = Date.now() + this.timeoutMs;
          onStatus?.('Gemini Deep Research started.');
          await delay(this.pollMs, signal); continue;
        }
        if (response?.text && response.text !== last) { last = response.text; onText(last); }
        checkAbort(signal);
        if (response?.text && response.complete && !current.generating && !start) {
          if (options.deepResearch && !approved) throw new Error('Gemini returned a response without the expected Deep Research approval flow.');
          return { text: response.text, url: state.url };
        }
        await delay(this.pollMs, signal);
      }
      throw new Error('Timed out waiting for Gemini to finish. The browser response may still be visible in the Gemini conversation.');
    } catch (error) {
      if (submitted) {
        try { await this.stop(browserId); }
        catch (stopError) { onStatus?.(`Could not confirm Gemini stopped: ${String(stopError)}`); }
      }
      throw error;
    }
  }
  private async sendDom(browserId: string, text: string, options: SendOptions, initial: DomState): Promise<{ text: string; url: string }> {
    const { signal, onText, onStatus, deepResearch } = options;
    let submitted = false;
    try {
      this.assertArgon(initial.model);
      if (initial.generating) throw new Error('Gemini is already generating a response in this tab.');
      if (initial.researchSelected !== deepResearch) {
        if (!initial.controls.research || !initial.researchSelected) {
          await this.clickDom(browserId, 'tools', signal);
          const menu = await this.inspectDom(browserId);
          if (!menu.controls.research) await this.clickDom(browserId, 'more-tools', signal);
        }
        await this.clickDom(browserId, 'research', signal);
        await this.waitDom(browserId, state => state.researchSelected === deepResearch, 'Deep Research selection', signal);
      }
      let state = await this.waitDom(browserId, state => state.promptAvailable, 'Gemini prompt editor', signal);
      this.assertArgon(state.model);
      const count = state.responses.length;
      await this.call('gemini_dom', { browserId, command: { kind: 'fill', text } });
      checkAbort(signal);
      await this.clickDom(browserId, 'send', signal);
      submitted = true;
      let deadline = Date.now() + this.timeoutMs;
      let last = '', planText = '', lastStatus = '', approved = false, openedReport = false;
      while (Date.now() < deadline) {
        checkAbort(signal);
        state = await this.inspectDom(browserId);
        const response = state.responses.length > count ? state.responses[state.responses.length - 1] : undefined;
        if (deepResearch && approved && state.researchStatus && state.researchStatus !== lastStatus) {
          lastStatus = state.researchStatus;
          onStatus?.(lastStatus);
        }
        if (state.researchPlanReady && deepResearch && !approved) {
          if (!response?.text) throw new Error('The Gemini research plan could not be read; research was not started.');
          if (!options.onResearchPlan) throw new Error('Deep Research requires explicit approval of its research plan.');
          planText = response.text;
          onStatus?.('Waiting for your approval of the Gemini research plan.');
          const accepted = await abortable(options.onResearchPlan(planText), signal);
          checkAbort(signal);
          if (!accepted) throw new Error('Deep Research plan was not approved. Research was not started.');
          await this.clickDom(browserId, 'start-research', signal);
          approved = true; deadline = Date.now() + this.timeoutMs;
          onStatus?.('Gemini Deep Research started.');
          await delay(this.pollMs, signal); continue;
        }
        const report = deepResearch && approved ? this.completedResearchReport(state) : undefined;
        if (report && !state.researchPlanReady) {
          if (report.text !== last) onText(report.text);
          return { text: report.text, url: state.url };
        }
        if (deepResearch && approved && !openedReport && state.controls['open-report']) {
          await this.clickDom(browserId, 'open-report', signal);
          openedReport = true;
        }
        if (!deepResearch && response?.text && response.text !== planText && response.text !== last) { last = response.text; onText(last); }
        checkAbort(signal);
        if (!deepResearch && response?.text && response.text !== planText && response.complete && !state.generating && !state.researchRunning && !state.researchPlanReady) {
          return { text: response.text, url: state.url };
        }
        await delay(this.pollMs, signal);
      }
      throw new Error('Timed out waiting for Gemini to finish. Open the Gemini conversation to inspect its current state.');
    } catch (error) {
      if (submitted) {
        try { await this.stop(browserId); }
        catch (stopError) { onStatus?.(`Could not confirm Gemini stopped: ${String(stopError)}`); }
      }
      throw error;
    }
  }
  async stop(browserId: string): Promise<void> {
    const dom = await this.tryDom(browserId);
    if (dom) { if (dom.generating) await this.clickDom(browserId, 'stop'); return; }
    const state = await this.snapshot(browserId);
    if (state.controls.some(c => c.role === 'button' && STOP.test(c.label))) await this.click(browserId, c => c.role === 'button' && STOP.test(c.label), 'Gemini stop generation');
    else if (state.raw.truncated) throw new Error('Cannot confirm generation stopped because Paseo truncated the snapshot.');
  }
  async close(browserId: string): Promise<void> { await this.call('browser_close_tab', { browserId }); this.accessibilityOnly.delete(browserId); }
}
