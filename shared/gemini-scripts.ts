/** Fixed, plugin-owned function source; never accepts JavaScript from RPC callers. */
export const GEMINI_DOM_FUNCTION_SOURCE = String.raw`(command) => {
  if (location.origin !== 'https://gemini.google.com') throw new Error('Gemini page required.');
  const visible = element => !!element && element.getClientRects().length > 0 && !element.closest('[hidden],[aria-hidden="true"]');
  const label = element => (element.getAttribute('aria-label') || element.innerText || element.textContent || '').trim();
  const all = selector => Array.from(document.querySelectorAll(selector)).filter(visible);
  const controls = () => all('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]');
  const modelPattern = /mode picker|model selector|choose (?:a )?model|select (?:a )?model|모드 선택|모델 선택/i;
  const stopPattern = /^(?:Stop(?: response| generating| generation)?|Cancel response|대답 생성 중지|응답 생성 중지|생성 중지)$/i;
  const startPattern = /^(?:Start research|Start researching|Begin research|리서치 시작|조사 시작|연구 시작)$/i;
  const finishPattern = /^(?:Good response|Bad response|Like response|Dislike response|Copy response|대답이 마음에 들어요|대답이 마음에 들지 않아요|응답 복사)$/i;
  const researchPattern = /^(?:Deep Research|심층 리서치)$/i;
  const removeResearchPattern = /(?:Remove|Deselect|삭제|제거|선택 해제).*Deep Research|Deep Research.*(?:Remove|Deselect|삭제|제거|선택 해제)/i;
  const disabled = element => !!element.disabled || !!element.closest('[aria-disabled="true"],[disabled]');
  const textOf = element => element ? (element.innerText || element.textContent || '').trim() : '';
  const assistantContainers = Array.from(document.querySelectorAll('model-response,[data-message-author-role="assistant"]'));
  const latestAssistant = assistantContainers[assistantContainers.length - 1];
  const researchCards = Array.from(document.querySelectorAll('model-response immersive-entry-chip gem-processing-card[role="status"],[data-message-author-role="assistant"] immersive-entry-chip gem-processing-card[role="status"]'));
  const researchCard = researchCards[researchCards.length - 1];
  const newerResearchPlan = !!researchCard && Array.from(document.querySelectorAll('model-response deep-research-confirmation-widget,[data-message-author-role="assistant"] deep-research-confirmation-widget')).some(element => !!(researchCard.compareDocumentPosition(element) & 4));
  const completedCard = !!researchCard && researchCard.classList.contains('completed') && !researchCard.classList.contains('processing') && !newerResearchPlan;
  const activeStart = () => controls().find(element => startPattern.test(label(element)) && !disabled(element) && !!latestAssistant && latestAssistant.contains(element));
  const prompt = () => all('rich-textarea [contenteditable="true"],.ql-editor[contenteditable="true"],[contenteditable="true"][role="textbox"],textarea[aria-label]')[0];
  const isResearchSelected = () => controls().some(element => {
    const name = label(element);
    return removeResearchPattern.test(name) ||
      researchPattern.test(name) && (element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-checked') === 'true' || !element.closest('[role="menu"]') && element.tagName === 'BUTTON');
  });
  const patterns = {
    model: modelPattern, argon: /^(?:Gemini\s*)?(?:4\s*)?Argon(?:\s|$)/i,
    thinking: /^(?:Thinking level|Thinking effort|사고 수준)$/i,
    low: /^(?:Low|Minimal|최저가|낮음|최저)(?:\s|$)/i,
    medium: /^(?:Medium|보통|중간)(?:\s|$)/i,
    high: /^(?:High|최고가|높음|최고)(?:\s|$)/i,
    tools: /^(?:Tools|Add files(?: and tools)?|Uploads? (?:&|and) tools|업로드 및 도구|도구)$/i,
    'more-tools': /^(?:More tools|도구 더보기)$/i,
    research: /^(?:Deep Research|심층 리서치)$|(?:Remove|Deselect|삭제|제거|선택 해제).*Deep Research|Deep Research.*(?:Remove|Deselect|삭제|제거|선택 해제)/i,
    'start-research': startPattern, stop: stopPattern,
    send: /^(?:Send(?: message| prompt)?|Submit|메시지 보내기|보내기)$/i
  };
  if (command.kind === 'fill') {
    if (typeof command.text !== 'string' || command.text.length > 1000000) throw new Error('Invalid Gemini prompt text.');
    const editor = prompt();
    if (!editor || disabled(editor)) throw new Error('Gemini prompt editor is unavailable.');
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, command.text);
    } else {
      editor.textContent = command.text;
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.text }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true };
  }
  if (command.kind === 'click') {
    if (command.target === 'open-report') {
      if (!completedCard || disabled(researchCard)) throw new Error('Gemini completed research report is unavailable or disabled.');
      researchCard.click();
      return { clicked: true, target: command.target };
    }
    const pattern = patterns[command.target];
    if (!pattern) throw new Error('Unknown Gemini control.');
    const matches = controls().filter(element => pattern.test(label(element)));
    // Model/effort targets must come from a model menu, never an answer or composer chip.
    const isModelOption = ['argon','thinking','low','medium','high'].includes(command.target);
    const element = command.target === 'start-research' ? activeStart() : matches.find(item => !isModelOption || /^menuitem|option/.test(item.getAttribute('role') || '') || !!item.closest('[role="menu"],[role="listbox"]'));
    if (!element || disabled(element)) throw new Error('Gemini control unavailable or disabled: ' + command.target);
    element.click();
    return { clicked: true, target: command.target };
  }
  if (command.kind !== 'inspect') throw new Error('Unknown Gemini DOM command.');
  const protectedBlocks = [];
  const ignored = element => /^(BUTTON|SCRIPT|STYLE|SVG|MAT-ICON)$/.test(element.tagName) || element.matches('[aria-hidden="true"],[hidden],model-thoughts,.thoughts-container,[data-test-id="thoughts-container"]');
  const languageOf = pre => {
    const code = pre.querySelector('code');
    let language = (code && (code.getAttribute('data-language') || (/(?:^|\s)language-([\w+-]+)/.exec(code.className || '') || [])[1])) || pre.getAttribute('data-language') || '';
    if (!language) {
      const block = pre.closest('code-block,.code-block');
      const header = block && block.querySelector('.code-block-decoration,.code-block-header,[data-test-id="code-block-language"]');
      if (header) {
        const first = Array.from(header.childNodes).find(node => node.nodeType === 3 && node.textContent.trim() || node.nodeType === 1 && !ignored(node));
        language = first ? first.textContent.trim() : '';
      }
    }
    return /^[\w+-]+$/.test(language) ? language : '';
  };
  const markdown = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || ignored(node)) return '';
    const tag = node.tagName;
    if (tag === 'PRE') {
      const code = node.querySelector('code') || node;
      const value = code.textContent;
      const runs = value.match(new RegExp(String.fromCharCode(96) + '+', 'g')) || [];
      const marker = String.fromCharCode(96).repeat(Math.max(3, ...runs.map(run => run.length + 1)));
      const block = marker + languageOf(node) + '\n' + value + (value.endsWith('\n') ? '' : '\n') + marker;
      const token = '\u0000gemini_pre_' + protectedBlocks.length + '\u0000';
      protectedBlocks.push({ token, block });
      return '\n\n' + token + '\n\n';
    }
    if (tag === 'CODE-BLOCK' || node.classList.contains('code-block')) {
      const pre = node.querySelector('pre');
      if (pre) return markdown(pre);
    }
    const children = Array.from(node.childNodes).map(markdown).join('');
    if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children.trim() + '\n\n';
    if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') return '\n\n' + children.trim() + '\n\n';
    if (tag === 'BR') return '\n';
    if (tag === 'LI') return '\n- ' + children.trim();
    if (tag === 'UL' || tag === 'OL') return '\n' + children + '\n\n';
    if (tag === 'STRONG' || tag === 'B') return '**' + children + '**';
    if (tag === 'EM' || tag === 'I') return '*' + children + '*';
    if (tag === 'CODE') return String.fromCharCode(96) + children + String.fromCharCode(96);
    if (tag === 'A' && children.trim()) {
      const href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) return '[' + children.trim() + '](' + href.replace(/\)/g, '%29') + ')';
    }
    if (tag === 'TR') return '\n' + children + '|';
    if (tag === 'TD' || tag === 'TH') return '| ' + children.trim() + ' ';
    return children;
  };
  const cleanMarkdown = element => {
    let result = markdown(element).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    for (const item of protectedBlocks) result = result.split(item.token).join(item.block);
    return result;
  };
  const uiControls = controls();
  const picker = uiControls.find(element => modelPattern.test(label(element)));
  const pickerText = picker ? textOf(picker) : '';
  const model = /\bArgon\b/i.test(pickerText) ? 'Argon' : pickerText || (picker ? label(picker) : '');
  const generating = uiControls.some(element => stopPattern.test(label(element)));
  let containers = Array.from(document.querySelectorAll('model-response,[data-message-author-role="assistant"]'));
  containers = containers.filter(element => !containers.some(parent => parent !== element && parent.contains(element)));
  const responseActions = Array.from(document.querySelectorAll('button,[role="button"]')).filter(element => finishPattern.test(label(element)));
  const responses = containers.map((container, index) => {
    const parts = Array.from(container.querySelectorAll('message-content .markdown,.model-response-text .markdown,[data-message-content]'));
    const unique = parts.filter(element => !parts.some(parent => parent !== element && parent.contains(element)));
    if (!unique.length) {
      const message = container.querySelector('message-content');
      if (message) unique.push(message);
    }
    const text = unique.map(cleanMarkdown).filter(Boolean).join('\n\n');
    // Background resident webviews may not paint their footer. The completed
    // toolbar is still in the DOM; scope sibling footers to this response turn.
    const next = containers[index + 1];
    const complete = responseActions.some(element => container.contains(element) ||
      !!(container.compareDocumentPosition(element) & 4) && (!next || !!(element.compareDocumentPosition(next) & 4)));
    return { text, complete };
  });
  const alerts = all('[role="alert"],.error-message,[data-test-id="error-message"]')
    .filter(element => !element.closest('model-response,user-query,[data-message-author-role]'));
  const errorElement = alerts.find(element => /limit|quota|too many requests|한도|오류|문제가 발생|something went wrong/i.test(textOf(element)));
  const levels = ['low','medium','high'];
  const selectedEffort = uiControls.find(element => levels.some(level => patterns[level].test(label(element))) &&
    (element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true' ||
      /(?:^|\s)(?:selected|is-selected|checked)(?:\s|$)/.test(element.className || '') ||
      Array.from(element.querySelectorAll('mat-icon,[data-mat-icon-name],[fonticon]')).some(icon =>
        /^(?:check|check_small|done)$/i.test((icon.getAttribute('data-mat-icon-name') || icon.getAttribute('fonticon') || icon.textContent || '').trim()))));
  const pickerLabel = picker ? label(picker) : '';
  const labelEffort = /(?:\bMedium\b|보통|중간)/i.test(pickerLabel) ? 'medium' : /(?:\bHigh\b|최고가|높음|최고)/i.test(pickerLabel) ? 'high' : /(?:\bLow\b|\bMinimal\b|최저가|낮음|최저)/i.test(pickerLabel) ? 'low' : undefined;
  const researchSelected = isResearchSelected();
  const researchRunning = !!researchCard && researchCard.classList.contains('processing') || Array.from((latestAssistant || document).querySelectorAll('[role="status"]')).some(element =>
    /researching|starting research|research in progress|조사(?: 시작)? 중|리서치 중|연구(?: 시작)? 중|보고서 (?:생성|작성) 중/i.test(textOf(element)));
  const researchPlanReady = !!activeStart();
  const panel = document.querySelector('deep-research-immersive-panel');
  const reportBody = panel && panel.querySelector('structured-content-container[data-test-id="message-content"] message-content .markdown');
  const cardTitle = researchCard && textOf(researchCard.querySelector('.card-title'));
  const panelTitle = panel && textOf(panel.querySelector('toolbar .title-text'));
  let researchReport;
  if (completedCard && researchCard.classList.contains('selected') && cardTitle && panelTitle === cardTitle && reportBody && reportBody.getAttribute('aria-busy') === 'false' && !generating && !researchRunning && !researchPlanReady) {
    let reportText = cleanMarkdown(reportBody);
    if (reportText) {
      const seenSources = new Set();
      const sources = Array.from(panel.querySelectorAll('deep-research-source-lists .source-list.used-sources browse-web-item a[href]')).map(anchor => {
        const href = anchor.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(href) || seenSources.has(href)) return '';
        seenSources.add(href);
        const lines = textOf(anchor).split('\n').map(line => line.trim()).filter(line => line && !/^(?:새 창에서 열기|Open in new tab|Open in new window)$/i.test(line));
        const title = (lines.length > 1 ? lines.slice(1).join(' ') : lines[0]) || href;
        return '- [' + title.replace(/\[/g, '\\[').replace(/\]/g, '\\]') + '](' + href.replace(/\)/g, '%29') + ')';
      }).filter(Boolean);
      if (sources.length) reportText += '\n\n## Sources\n\n' + sources.join('\n');
      researchReport = { text: reportText, complete: true };
    }
  }
  const targetControls = Object.fromEntries(Object.entries(patterns).map(([target, pattern]) => [target, uiControls.some(element => pattern.test(label(element)) && !disabled(element))]));
  targetControls['start-research'] = researchPlanReady;
  targetControls['open-report'] = completedCard && !generating && !researchRunning && !researchPlanReady && !disabled(researchCard);
  return {
    url: location.href, model,
    thinking: selectedEffort ? levels.find(level => patterns[level].test(label(selectedEffort))) : labelEffort,
    responses, generating, promptAvailable: !!prompt(),
    loginRequired: !prompt() && all('a,button').some(element => /^(?:Sign in|Log in|로그인)$/i.test(label(element))),
    error: errorElement ? textOf(errorElement) : undefined,
    researchSelected, researchRunning, researchPlanReady, researchReport,
    researchStatus: researchRunning && researchCard ? textOf(researchCard.querySelector('.current-step')) || undefined : undefined,
    controls: targetControls
  };
}`;
