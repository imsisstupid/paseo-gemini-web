import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as researchState from '../shared/research-state';

function loadStyles(document?: Document, platform = 'web') {
  const source = readFileSync(resolve(process.cwd(), 'client/research-icon.web.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} as { startResearchIconStyles(): () => void } };
  runInNewContext(compiled, {
    module, exports: module.exports, document,
    require(name: string) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === '../shared/research-state') return researchState;
      throw new Error(`Unexpected test import: ${name}`);
    },
  });
  return module.exports.startResearchIconStyles;
}

function fixture() {
  const button = (id: string, feature: string, label: string) => `<button id="${id}" data-testid="agent-feature-${feature}" aria-label="${label}"><svg><g stroke="#999999"><path d="M0 0h10"/></g></svg></button>`;
  return new JSDOM(`<head><style>svg, svg * { color: #999999; stroke: #999999; }</style></head><body>${button('on', 'deep_research', 'Deep Research · 켜짐')}${button('off', 'deep_research', 'Deep Research · 꺼짐')}${button('other', 'other', 'Deep Research · 켜짐')}</body>`);
}

test('only enabled Deep Research icons become blue, including nested SVG strokes', () => {
  const dom = fixture();
  const { document } = dom.window;
  const stop = loadStyles(document)();
  for (const selector of ['#on svg', '#on g', '#on path']) {
    const style = dom.window.getComputedStyle(document.querySelector(selector)!);
    assert.equal(style.color, 'rgb(59, 130, 246)');
    assert.equal(style.stroke, 'rgb(59, 130, 246)');
  }
  for (const selector of ['#off svg', '#off g', '#other svg', '#other g']) {
    const style = dom.window.getComputedStyle(document.querySelector(selector)!);
    assert.equal(style.color, 'rgb(153, 153, 153)');
    assert.equal(style.stroke, 'rgb(153, 153, 153)');
  }
  stop();
  dom.window.close();
});

test('committed label updates change color without replacing controls or adding click handlers', () => {
  const dom = fixture();
  const { document } = dom.window;
  const button = document.querySelector('#off')!;
  const originalAddListener = button.addEventListener;
  button.addEventListener = () => { throw new Error('The style helper must not intercept button actions.'); };
  const stop = loadStyles(document)();
  button.setAttribute('aria-label', 'Deep Research · 켜짐');
  assert.equal(dom.window.getComputedStyle(button.querySelector('g')!).stroke, 'rgb(59, 130, 246)');
  button.setAttribute('aria-label', 'Deep Research · 꺼짐');
  assert.equal(dom.window.getComputedStyle(button.querySelector('g')!).stroke, 'rgb(153, 153, 153)');
  assert.equal(document.querySelector('#off'), button);
  button.addEventListener = originalAddListener;
  stop();
  dom.window.close();
});

test('each installation removes only its own style and repeated cleanup is safe', () => {
  const dom = fixture();
  const start = loadStyles(dom.window.document);
  const stopFirst = start();
  const stopSecond = start();
  assert.equal(dom.window.document.querySelectorAll('style').length, 3);
  stopFirst();
  stopFirst();
  assert.equal(dom.window.document.querySelectorAll('style').length, 2);
  assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('#on g')!).stroke, 'rgb(59, 130, 246)');
  stopSecond();
  assert.equal(dom.window.document.querySelectorAll('style').length, 1);
  assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('#on g')!).stroke, 'rgb(153, 153, 153)');
  dom.window.close();
});

test('native clients and environments without a document remain a no-op', () => {
  const document = { get head() { throw new Error('Native clients must not inspect DOM.'); } } as unknown as Document;
  loadStyles(document, 'ios')()();
  loadStyles(undefined)()();
});
