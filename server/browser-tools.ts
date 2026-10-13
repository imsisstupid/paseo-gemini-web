import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface BrowserTools {
  call(name: string, args: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

const REQUIRED_TOOLS = ["browser_new_tab", "browser_list_tabs", "browser_evaluate"];
const SETUP_MESSAGE = "Enable Paseo tools and Browser tools in this host's Settings > Agents, then refresh the Gemini Web agent.";
const CONNECT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class BrowserToolsError extends Error {}

function browserError(code: unknown): BrowserToolsError {
  switch (code) {
    case "browser_disabled":
      return new BrowserToolsError(`Browser tools are disabled. ${SETUP_MESSAGE}`);
    case "browser_no_host":
      return new BrowserToolsError("No Paseo desktop browser is connected. Open the Paseo desktop app and connect it to this host.");
    case "browser_stale_ref":
      return new BrowserToolsError("The browser page changed. Refresh the page snapshot and retry.");
    case "browser_timeout":
      return new BrowserToolsError("The browser operation timed out. Check that the Gemini tab is responsive and retry.");
    case "browser_denied":
      return new BrowserToolsError("Paseo denied this browser operation. Open the Gemini Web agent in a workspace and check its browser tab.");
    default:
      return new BrowserToolsError("The Paseo browser operation failed. Check the desktop connection and Gemini tab, then retry.");
  }
}

function unwrapResult(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.isError === true) throw browserError(undefined);
  const envelope = response.structuredContent;
  if (!isRecord(envelope)) {
    throw new BrowserToolsError("Paseo returned an unsupported browser response. Update Paseo and refresh this agent.");
  }
  if (envelope.ok !== true) {
    throw browserError(isRecord(envelope.error) ? envelope.error.code : undefined);
  }
  if (!isRecord(envelope.result) || typeof envelope.result.command !== "string") {
    throw new BrowserToolsError("Paseo returned an invalid browser response.");
  }
  const result = envelope.result;
  if (result.command !== "evaluate") return result;
  if (result.truncated === true) {
    throw new BrowserToolsError("Browser evaluation output was truncated. Read a smaller portion of the page and retry.");
  }
  if (typeof result.resultJson !== "string") {
    throw new BrowserToolsError("Paseo returned an invalid browser evaluation response.");
  }
  try {
    // Paseo 0.11.2 transports evaluated values as JSON text, not as `value`.
    return { ...result, value: JSON.parse(result.resultJson) as unknown };
  } catch {
    throw new BrowserToolsError("Paseo returned invalid JSON from the browser evaluation.");
  }
}

export async function connectBrowserTools(
  mcpServers: ProviderSessionConfig["mcpServers"],
): Promise<BrowserTools> {
  // Use only the host-injected, agent-scoped Paseo endpoint. Do not discover
  // credentials on disk or connect to unrelated configured MCP servers.
  const config = mcpServers.paseo;
  if (!config) throw new BrowserToolsError(`The agent has no Paseo tools connection. ${SETUP_MESSAGE}`);
  if (config.type === "stdio") {
    throw new BrowserToolsError("Gemini Web requires Paseo's injected HTTP browser tools endpoint. Refresh this agent with Paseo tools enabled.");
  }
  let url: URL;
  try {
    url = new URL(config.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new BrowserToolsError("The Paseo browser tools endpoint is invalid. Refresh this agent.");
  }

  const options = { requestInit: { headers: config.headers } };
  const transport = config.type === "sse"
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: "paseo-gemini-web-browser", version: "1.0.0" }, { capabilities: {} });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await client.close(); } catch { /* Never surface transport headers or URLs. */ }
    try { await transport.close(); } catch { /* Also releases a transport that never connected. */ }
  };
  const available = new Set<string>();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new BrowserToolsError("Connecting to Paseo browser tools timed out. Check the host connection and refresh this agent.")), CONNECT_TIMEOUT_MS);
      }),
    ]);
    if (deadline) clearTimeout(deadline);
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      for (const tool of page.tools) available.add(tool.name);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new BrowserToolsError("Paseo returned an invalid browser tools catalog.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (REQUIRED_TOOLS.some((name) => !available.has(name))) {
      throw new BrowserToolsError(`Required Browser tools are unavailable. ${SETUP_MESSAGE}`);
    }
  } catch (error) {
    if (deadline) clearTimeout(deadline);
    await close();
    if (error instanceof BrowserToolsError) throw error;
    throw new BrowserToolsError("Could not connect to Paseo browser tools. Check the host connection, enable Paseo tools and Browser tools, and refresh this agent.");
  }

  return {
    async call(name, args) {
      if (closed) throw new BrowserToolsError("The Paseo browser tools connection is closed.");
      if (!name.startsWith("browser_") || !available.has(name)) {
        throw new BrowserToolsError("The requested browser tool is unavailable on this host.");
      }
      try {
        const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
        return unwrapResult(response);
      } catch (error) {
        if (error instanceof BrowserToolsError) throw error;
        throw new BrowserToolsError("The Paseo browser operation failed or the connection was lost. Check the desktop connection and refresh this agent.");
      }
    },
    close,
  };
}
