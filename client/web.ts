import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { domBridgeAuthorize, domBridgeComplete, domBridgePull, type GeminiDomFailureCode } from "../shared/dom-bridge";
import { GEMINI_DOM_FUNCTION_SOURCE } from "../shared/gemini-scripts";

// Desktop-only globals stay in this module. No DOM library is added to the
// plugin's shared/mobile TypeScript environment.
interface GeminiWebview {
  isConnected: boolean;
  getAttribute(name: string): string | null;
  getURL?(): string;
  executeJavaScript?(code: string): Promise<unknown>;
}
declare const document: { querySelectorAll(selector: string): ArrayLike<GeminiWebview> };
declare const window: { paseoDesktop?: { browser?: unknown } };

function residentWebviews(): Map<string, GeminiWebview> {
  const result = new Map<string, GeminiWebview>();
  if (typeof document === "undefined") return result;
  // This attribute is an internal Paseo desktop convention. Feature detection
  // makes unsupported hosts fail by timeout instead of inspecting other tabs.
  for (const view of Array.from(document.querySelectorAll("webview[data-paseo-browser-id]"))) {
    const id = view.getAttribute("data-paseo-browser-id");
    if (id && view.isConnected && typeof view.getURL === "function" && typeof view.executeJavaScript === "function") result.set(id, view);
  }
  return result;
}

function isGemini(view: GeminiWebview): boolean {
  try { return new URL(view.getURL?.() ?? "").origin === "https://gemini.google.com"; }
  catch { return false; }
}

export function startDomBridge(client: PluginClientContext): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined" || !window.paseoDesktop?.browser) return () => {};
  const clientId = globalThis.crypto.randomUUID();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelExecution: (() => void) | undefined;
  const expiredExecution = Symbol("expired Gemini browser execution");

  async function poll(): Promise<void> {
    try {
      const views = residentWebviews();
      if (views.size === 0) return;
      const { job } = await client.rpc(domBridgePull, { clientId, browserIds: [...views.keys()].slice(0, 1000) });
      if (!job || stopped) return;
      // Recheck after receiving a claim: an interrupt may have canceled it
      // while the RPC response was in transit to this desktop.
      const lease = await client.rpc(domBridgeAuthorize, { clientId, jobId: job.id, token: job.token });
      if (!lease.authorized || stopped) return;
      let result: { ok: true; value: any } | { ok: false; code: GeminiDomFailureCode };
      const view = residentWebviews().get(job.browserId);
      if (Date.now() >= job.expiresAt) result = { ok: false, code: "expired" };
      else if (!view) result = { ok: false, code: "tab_missing" };
      else if (!isGemini(view)) result = { ok: false, code: "wrong_origin" };
      else {
        let executionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // The function source ships with this plugin. The RPC accepts only
          // fixed commands and cannot supply JavaScript or selector strings.
          // Electron may defer execution during navigation. Check the lease in
          // the page as well, before a delayed fill/send can touch its controls.
          const source = `(() => { if (Date.now() >= ${JSON.stringify(job.expiresAt)}) throw new Error("GEMINI_DOM_EXPIRED"); return (${GEMINI_DOM_FUNCTION_SOURCE})(${JSON.stringify(job.command)}); })()`;
          const deadline = new Promise<never>((_, reject) => {
            cancelExecution = () => reject(expiredExecution);
            executionTimer = setTimeout(cancelExecution, Math.max(1, job.expiresAt - Date.now()));
          });
          // A stalled renderer must not strand the single client polling loop.
          // The race observes late rejections but never forwards late results.
          const raw = await Promise.race([view.executeJavaScript!(source), deadline]);
          const encoded = JSON.stringify(raw ?? null);
          result = encoded.length > 2_000_000
            ? { ok: false, code: "invalid_result" }
            : { ok: true, value: JSON.parse(encoded) };
        } catch (error) {
          result = { ok: false, code: error === expiredExecution ? "expired" : "execution_failed" };
        } finally {
          if (executionTimer) clearTimeout(executionTimer);
          cancelExecution = undefined;
        }
      }
      if (!stopped) await client.rpc(domBridgeComplete, { clientId, jobId: job.id, token: job.token, result });
    } catch {
      // A disconnected host or plugin reload is retried on the next cycle.
      // Transport exceptions may contain URLs or headers and are never logged.
    } finally {
      if (!stopped) timer = setTimeout(() => { void poll(); }, 300);
    }
  }

  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    cancelExecution?.();
  };
}
