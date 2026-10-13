import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerDomBridge } from "../server/dom-bridge";
import { domBridgeAuthorize, domBridgeComplete, domBridgePull, GeminiDomCommandSchema } from "../shared/dom-bridge";

function setup(timeoutMs = 1_000) {
  const handlers = new Map<string, (input: any) => any>();
  const server = { handle(contract: { name: string }, handler: (input: any) => any) { handlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const bridge = registerDomBridge(server, { timeoutMs });
  return {
    bridge,
    pull: (clientId: string, browserIds: string[]) => handlers.get(domBridgePull.name)!({ clientId, browserIds }),
    complete: (input: any) => handlers.get(domBridgeComplete.name)!(input),
    authorize: (input: any) => handlers.get(domBridgeAuthorize.name)!(input),
  };
}

test("commands contain only fixed Gemini actions and reject arbitrary script payloads", () => {
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "inspect" }).success, true);
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "click", target: "research" }).success, true);
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "click", target: "open-report" }).success, true);
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "fill", text: "Prompt text" }).success, true);
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "fill", text: "x".repeat(1_000_001) }).success, false);
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "inspect", script: "document.cookie" }).success, false);
  assert.equal(GeminiDomCommandSchema.safeParse({ kind: "click", target: "other" }).success, false);
});

test("only the desktop containing the requested browser can claim its job", async () => {
  const { bridge, pull, complete } = setup();
  const pending = bridge.execute("browser-a", { kind: "inspect" });
  assert.deepEqual(pull("desktop-b", ["browser-b"]), { job: null });
  const { job } = pull("desktop-a", ["browser-a"]);
  assert.equal(job.browserId, "browser-a");
  assert.deepEqual(pull("desktop-a", ["browser-a"]), { job: null });
  assert.deepEqual(complete({ clientId: "desktop-a", jobId: job.id, token: job.token, result: { ok: true, value: { loggedIn: true } } }), { accepted: true });
  assert.deepEqual(await pending, { loggedIn: true });
  await bridge.close();
});

test("results require the claim token and owning desktop, and cannot be replayed", async () => {
  const { bridge, pull, complete } = setup();
  const pending = bridge.execute("browser-a", { kind: "inspect" });
  const { job } = pull("desktop-a", ["browser-a"]);
  const result = { ok: true, value: { state: "ready" } };
  assert.deepEqual(complete({ clientId: "desktop-b", jobId: job.id, token: job.token, result }), { accepted: false });
  assert.deepEqual(complete({ clientId: "desktop-a", jobId: job.id, token: "wrong-token", result }), { accepted: false });
  assert.deepEqual(complete({ clientId: "desktop-a", jobId: job.id, token: job.token, result }), { accepted: true });
  assert.deepEqual(complete({ clientId: "desktop-a", jobId: job.id, token: job.token, result }), { accepted: false });
  assert.deepEqual(await pending, { state: "ready" });
  await bridge.close();
});

test("preserves command order within a browser while another browser can proceed", async () => {
  const { bridge, pull, complete } = setup();
  const first = bridge.execute("browser-a", { kind: "click", target: "tools" });
  const second = bridge.execute("browser-a", { kind: "click", target: "research" });
  const other = bridge.execute("browser-b", { kind: "inspect" });
  const job1 = pull("desktop-a", ["browser-a", "browser-b"]).job;
  assert.deepEqual(job1.command, { kind: "click", target: "tools" });
  const job2 = pull("desktop-a-2", ["browser-a", "browser-b"]).job;
  assert.equal(job2.browserId, "browser-b");
  assert.equal(pull("desktop-a-3", ["browser-a"]).job, null);
  complete({ clientId: "desktop-a", jobId: job1.id, token: job1.token, result: { ok: true, value: {} } });
  const job3 = pull("desktop-a", ["browser-a"]).job;
  assert.deepEqual(job3.command, { kind: "click", target: "research" });
  complete({ clientId: "desktop-a-2", jobId: job2.id, token: job2.token, result: { ok: true, value: {} } });
  complete({ clientId: "desktop-a", jobId: job3.id, token: job3.token, result: { ok: true, value: {} } });
  await Promise.all([first, second, other]);
  await bridge.close();
});

test("expired jobs fail clearly and late desktop results are ignored", async () => {
  const { bridge, pull, complete } = setup(25);
  const pending = bridge.execute("browser-a", { kind: "inspect" });
  const { job } = pull("desktop-a", ["browser-a"]);
  await assert.rejects(pending, /timed out|desktop/i);
  assert.deepEqual(complete({ clientId: "desktop-a", jobId: job.id, token: job.token, result: { ok: true, value: {} } }), { accepted: false });
  assert.deepEqual(pull("desktop-a", ["browser-a"]), { job: null });
  await bridge.close();
});

test("closing rejects pending jobs and does not accept new work", async () => {
  const { bridge, pull } = setup();
  const pending = bridge.execute("browser-a", { kind: "inspect" });
  const rejection = assert.rejects(pending, /closed/i);
  await bridge.close();
  await rejection;
  await bridge.close();
  assert.deepEqual(pull("desktop-a", ["browser-a"]), { job: null });
  await assert.rejects(bridge.execute("browser-a", { kind: "inspect" }), /closed/i);
});

test("desktop failures propagate fixed error codes without raw page details", async () => {
  const { bridge, pull, complete } = setup();
  const pending = bridge.execute("browser-a", { kind: "inspect" });
  const { job } = pull("desktop-a", ["browser-a"]);
  complete({ clientId: "desktop-a", jobId: job.id, token: job.token, result: { ok: false, code: "wrong_origin" } });
  await assert.rejects(pending, /Gemini|origin/i);
  await bridge.close();
});

test("cancel removes queued sends and invalidates claimed work only for that browser", async () => {
  const { bridge, pull, authorize, complete } = setup();
  const filling = bridge.execute("browser-a", { kind: "fill", text: "Canceled prompt" });
  const fillingRejected = assert.rejects(filling, /cancel/i);
  const sending = bridge.execute("browser-a", { kind: "click", target: "send" });
  const sendingRejected = assert.rejects(sending, /cancel/i);
  const other = bridge.execute("browser-b", { kind: "inspect" });
  const claimed = pull("desktop-a", ["browser-a"]).job;
  const claim = { clientId: "desktop-a", jobId: claimed.id, token: claimed.token };
  assert.deepEqual(authorize(claim), { authorized: true });
  bridge.cancel("browser-a");
  await Promise.all([fillingRejected, sendingRejected]);
  assert.deepEqual(authorize(claim), { authorized: false });
  assert.deepEqual(pull("desktop-a", ["browser-a"]), { job: null });
  const remaining = pull("desktop-b", ["browser-b"]).job;
  complete({ clientId: "desktop-b", jobId: remaining.id, token: remaining.token, result: { ok: true, value: { ready: true } } });
  assert.deepEqual(await other, { ready: true });
  await bridge.close();
});
