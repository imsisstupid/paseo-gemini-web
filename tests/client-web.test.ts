import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerDomBridge } from "../server/dom-bridge";
import * as contracts from "../shared/dom-bridge";
import * as scripts from "../shared/gemini-scripts";

/** Supply only the desktop/React Native boundary; execute the actual client module. */
function loadClient(executeJavaScript: (code: string) => Promise<unknown>) {
  const source = readFileSync(resolve(process.cwd(), "client/web.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} as { startDomBridge(client: PluginClientContext): () => void } };
  const view = {
    isConnected: true,
    getAttribute: () => "browser-a",
    getURL: () => "https://gemini.google.com/app/test",
    executeJavaScript,
  };
  runInNewContext(compiled, {
    module, exports: module.exports,
    require(name: string) {
      if (name === "react-native") return { Platform: { OS: "web" } };
      if (name === "../shared/dom-bridge") return contracts;
      if (name === "../shared/gemini-scripts") return scripts;
      throw new Error(`Unexpected test import: ${name}`);
    },
    document: { querySelectorAll: () => [view] },
    window: { paseoDesktop: { browser: {} } },
    crypto: { randomUUID }, URL, Date, setTimeout, clearTimeout,
  });
  return module.exports.startDomBridge;
}

function createRuntime(timeoutMs: number) {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const server = { handle(contract: { name: string }, handler: (input: unknown) => unknown) { handlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const bridge = registerDomBridge(server, { timeoutMs });
  const client = {
    async rpc(contract: { name: string; input: { parse(input: unknown): unknown }; output: { parse(output: unknown): unknown } }, input: unknown) {
      return contract.output.parse(await handlers.get(contract.name)!(contract.input.parse(input)));
    },
  } as unknown as PluginClientContext;
  return { bridge, client };
}

test("a hanging webview job expires without permanently blocking later browser commands", { timeout: 10_000 }, async (t) => {
  const { bridge, client } = createRuntime(1_000);
  let executions = 0;
  const start = loadClient(async () => {
    executions++;
    if (executions === 1) return new Promise(() => {});
    return { model: "Argon", responses: [], generating: false };
  });
  const first = bridge.execute("browser-a", { kind: "inspect" });
  const stop = start(client);
  t.after(async () => { stop(); await bridge.close(); });
  await assert.rejects(first, /timed out/i);
  const second = await bridge.execute("browser-a", { kind: "inspect" });
  assert.deepEqual(second, { model: "Argon", responses: [], generating: false });
});

test("an execution delayed beyond its lease cannot later activate Send", { timeout: 10_000 }, async (t) => {
  const { bridge, client } = createRuntime(50);
  let delayedScript = "";
  const start = loadClient(async (code) => {
    delayedScript = code;
    return new Promise(() => {});
  });
  const pending = bridge.execute("browser-a", { kind: "click", target: "send" });
  const stop = start(client);
  t.after(async () => { stop(); await bridge.close(); });
  await assert.rejects(pending, /timed out/i);
  let pageRead = false;
  const page = {
    Date: { now: () => Date.now() + 60_000 },
    get location() { pageRead = true; return { origin: "https://gemini.google.com" }; },
  };
  assert.throws(() => runInNewContext(delayedScript, page), /GEMINI_DOM_EXPIRED/);
  assert.equal(pageRead, false);
});
