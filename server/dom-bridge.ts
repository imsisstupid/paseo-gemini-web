import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  domBridgeAuthorize, domBridgeComplete, domBridgePull, GeminiDomCommandSchema,
  type GeminiDomCommand, type GeminiDomFailureCode,
} from "../shared/dom-bridge";

export interface GeminiDomBridge {
  execute(browserId: string, command: GeminiDomCommand): Promise<any>;
  cancel(browserId: string): void;
  close(): Promise<void>;
}

interface PendingJob {
  id: string;
  token: string;
  browserId: string;
  command: GeminiDomCommand;
  expiresAt: number;
  claimedBy?: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function failure(code: GeminiDomFailureCode, command?: GeminiDomCommand): Error & { code: string } {
  const messages: Record<GeminiDomFailureCode, string> = {
    unavailable: "The Gemini desktop browser bridge is unavailable. Open this host in the Paseo desktop app and refresh the plugin.",
    tab_missing: "The Gemini browser tab was closed or moved. Reopen the agent's browser tab and retry.",
    wrong_origin: "The browser tab is not on Gemini. Complete Google login and return to gemini.google.com before retrying.",
    expired: "The Gemini desktop browser bridge timed out. Keep the Paseo desktop app connected to this host and refresh the plugin.",
    execution_failed: command?.kind === "click"
      ? `Could not activate Gemini's ${command.target} control. Check the Gemini tab and retry.`
      : command?.kind === "fill"
      ? "Could not fill Gemini's prompt. Check the Gemini tab and retry."
      : "Could not inspect the Gemini page. Check the Gemini tab and retry.",
    invalid_result: "The Gemini browser returned an invalid or oversized response.",
  };
  return Object.assign(new Error(messages[code]), {
    code: code === "unavailable" ? "GEMINI_DOM_UNAVAILABLE" : code === "expired" ? "GEMINI_DOM_TIMEOUT" : `GEMINI_DOM_${code.toUpperCase()}`,
  });
}

export function registerDomBridge(
  server: PluginServerContext,
  options: { timeoutMs?: number } = {},
): GeminiDomBridge {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("The Gemini bridge timeout must be positive.");
  const jobs = new Map<string, PendingJob>();
  let closed = false;

  function remove(job: PendingJob) {
    jobs.delete(job.id);
    clearTimeout(job.timer);
  }

  function expire(job: PendingJob) {
    remove(job);
    job.reject(failure("expired", job.command));
  }

  server.handle(domBridgePull, ({ clientId, browserIds }) => {
    if (closed) return { job: null };
    const resident = new Set(browserIds);
    const busyBrowsers = new Set<string>();
    for (const job of jobs.values()) {
      if (Date.now() >= job.expiresAt) {
        expire(job);
        continue;
      }
      if (job.claimedBy) {
        busyBrowsers.add(job.browserId);
        continue;
      }
      if (!resident.has(job.browserId) || busyBrowsers.has(job.browserId)) continue;
      job.claimedBy = clientId;
      return { job: { id: job.id, token: job.token, browserId: job.browserId, command: job.command, expiresAt: job.expiresAt } };
    }
    return { job: null };
  });

  server.handle(domBridgeComplete, ({ clientId, jobId, token, result }) => {
    const job = jobs.get(jobId);
    if (!job || closed || job.claimedBy !== clientId || job.token !== token) return { accepted: false };
    if (Date.now() >= job.expiresAt) {
      expire(job);
      return { accepted: false };
    }
    remove(job);
    if (result.ok) {
      if (JSON.stringify(result.value).length > 2_000_000) job.reject(failure("invalid_result", job.command));
      else job.resolve(result.value);
    } else {
      job.reject(failure(result.code, job.command));
    }
    return { accepted: true };
  });

  server.handle(domBridgeAuthorize, ({ clientId, jobId, token }) => {
    const job = jobs.get(jobId);
    if (!job || closed || job.claimedBy !== clientId || job.token !== token) return { authorized: false };
    if (Date.now() >= job.expiresAt) {
      expire(job);
      return { authorized: false };
    }
    return { authorized: true };
  });

  return {
    async execute(browserId, command) {
      if (closed) throw new Error("The Gemini desktop browser bridge is closed.");
      if (!browserId || browserId.length > 256) throw new Error("A valid Gemini browser tab is required.");
      const parsed = GeminiDomCommandSchema.safeParse(command);
      if (!parsed.success) throw new Error("Unsupported Gemini browser action.");
      if (jobs.size >= 1000) throw new Error("The Gemini desktop browser bridge is busy. Retry shortly.");
      return new Promise((resolve, reject) => {
        const job: PendingJob = {
          id: randomUUID(), token: randomUUID(), browserId, command: parsed.data,
          expiresAt: Date.now() + timeoutMs, resolve, reject,
          timer: setTimeout(() => expire(job), timeoutMs),
        };
        jobs.set(job.id, job);
      });
    },
    cancel(browserId) {
      for (const job of jobs.values()) {
        if (job.browserId !== browserId) continue;
        remove(job);
        job.reject(Object.assign(new Error("The Gemini browser action was canceled."), { code: "GEMINI_DOM_CANCELED" }));
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const job of jobs.values()) {
        remove(job);
        job.reject(new Error("The Gemini desktop browser bridge is closed."));
      }
    },
  };
}
