import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { connectBrowserTools } from "../server/browser-tools";

const names = [
  "browser_new_tab", "browser_list_tabs", "browser_evaluate", "browser_navigate",
  "browser_close_tab", "browser_snapshot", "browser_fill", "browser_click", "browser_keypress",
];

async function fixture(t: TestContext, response: Record<string, unknown>, tools = names, transport: "http" | "sse" = "http") {
  let stream: ServerResponse | undefined;
  const server = createServer(async (request, reply) => {
    if (request.headers.authorization !== "Bearer test-secret") {
      reply.writeHead(401).end();
      return;
    }
    if (transport === "sse" && request.method === "GET") {
      stream = reply;
      reply.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      reply.write("event: endpoint\ndata: /message\n\n");
      return;
    }
    if (request.method !== "POST") {
      reply.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (input.id === undefined) {
      reply.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (input.method === "initialize") {
      result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-browser", version: "1" } };
    } else if (input.method === "tools/list") {
      result = { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) };
    } else if (input.method === "tools/call") {
      result = response;
    } else {
      reply.writeHead(400).end();
      return;
    }
    const message = JSON.stringify({ jsonrpc: "2.0", id: input.id, result });
    if (transport === "sse") {
      stream?.write(`event: message\ndata: ${message}\n\n`);
      reply.writeHead(202).end();
    } else {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(message);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  return { paseo: { type: transport, url: `http://127.0.0.1:${port}/mcp?callerAgentId=test`, headers: { Authorization: "Bearer test-secret" } } };
}

test("passes configured authorization and decodes Paseo evaluate resultJson", async (t) => {
  const tools = await connectBrowserTools(await fixture(t, {
    content: [{ type: "text", text: "Browser evaluate complete." }],
    structuredContent: { ok: true, result: { command: "evaluate", browserId: "tab-1", resultJson: '{"reply":"Hello"}', truncated: false } },
  }));
  t.after(() => tools.close());
  const result = await tools.call("browser_evaluate", { browserId: "tab-1", function: "() => ({ reply: 'Hello' })" });
  assert.deepEqual(result.value, { reply: "Hello" });
  assert.equal(result.command, "evaluate");
  assert.equal(result.browserId, "tab-1");
});

test("recognizes disconnected browser errors even without MCP isError", async (t) => {
  const tools = await connectBrowserTools(await fixture(t, {
    content: [],
    structuredContent: { ok: false, error: { code: "browser_no_host", message: "Internal test-secret", retryable: true } },
  }));
  t.after(() => tools.close());
  await assert.rejects(tools.call("browser_list_tabs", {}), (error: Error) => {
    assert.match(error.message, /desktop|connect/i);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});

test("reports disabled browser tools with actionable setup guidance", async (t) => {
  await assert.rejects(connectBrowserTools(await fixture(t, { content: [] }, ["list_agents"])), /browser tools|Browser tools/i);
});

test("rejects missing Paseo MCP without inspecting other server credentials", async () => {
  await assert.rejects(connectBrowserTools({}), /Paseo tools/i);
});

test("does not leak server error text or authorization values", async (t) => {
  const tools = await connectBrowserTools(await fixture(t, {
    isError: true, content: [{ type: "text", text: "Bearer test-secret at https://secret.invalid/?token=hidden" }],
  }));
  t.after(() => tools.close());
  await assert.rejects(tools.call("browser_evaluate", {}), (error: Error) => {
    assert.doesNotMatch(error.message, /test-secret|secret.invalid|hidden/);
    assert.match(error.message, /failed/i);
    return true;
  });
});

test("rejects truncated evaluation output rather than treating partial text as complete", async (t) => {
  const tools = await connectBrowserTools(await fixture(t, {
    content: [], structuredContent: { ok: true, result: { command: "evaluate", browserId: "tab", resultJson: '"partial"', truncated: true } },
  }));
  t.after(() => tools.close());
  await assert.rejects(tools.call("browser_evaluate", {}), /truncat/i);
});

test("closing is idempotent and prevents further browser operations", async (t) => {
  const tools = await connectBrowserTools(await fixture(t, {
    content: [], structuredContent: { ok: true, result: { command: "list_tabs", tabs: [] } },
  }));
  await tools.close();
  await tools.close();
  await assert.rejects(tools.call("browser_list_tabs", {}), /closed/i);
});

test("preserves authorization for explicit SSE endpoints and unwraps tab results", async (t) => {
  const tools = await connectBrowserTools(await fixture(t, {
    content: [], structuredContent: { ok: true, result: { command: "list_tabs", tabs: [{ browserId: "tab-2", url: "https://gemini.google.com/app" }] } },
  }, names, "sse"));
  t.after(() => tools.close());
  assert.deepEqual(await tools.call("browser_list_tabs", {}), {
    command: "list_tabs", tabs: [{ browserId: "tab-2", url: "https://gemini.google.com/app" }],
  });
});
