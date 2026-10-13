import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const GeminiDomCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspect") }).strict(),
  z.object({ kind: z.literal("fill"), text: z.string().max(1_000_000) }).strict(),
  z.object({
    kind: z.literal("click"),
    target: z.enum(["model", "argon", "thinking", "low", "medium", "high", "tools", "more-tools", "research", "start-research", "open-report", "stop", "send"]),
  }).strict(),
]);
export type GeminiDomCommand = z.infer<typeof GeminiDomCommandSchema>;

const identifier = z.string().min(1).max(256);
export const GeminiDomFailureCodeSchema = z.enum([
  "unavailable", "tab_missing", "wrong_origin", "expired", "execution_failed", "invalid_result",
]);
export type GeminiDomFailureCode = z.infer<typeof GeminiDomFailureCodeSchema>;

export const domBridgePull = defineRpc({
  name: "gemini.dom.pull",
  input: z.object({ clientId: identifier, browserIds: z.array(identifier).max(1000) }).strict(),
  output: z.object({
    job: z.object({
      id: identifier,
      token: identifier,
      browserId: identifier,
      expiresAt: z.number().int(),
      command: GeminiDomCommandSchema,
    }).nullable(),
  }),
});

export const domBridgeComplete = defineRpc({
  name: "gemini.dom.complete",
  input: z.object({
    clientId: identifier,
    jobId: identifier,
    token: identifier,
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: z.json() }).strict(),
      z.object({ ok: z.literal(false), code: GeminiDomFailureCodeSchema }).strict(),
    ]),
  }).strict(),
  output: z.object({ accepted: z.boolean() }),
});

export const domBridgeAuthorize = defineRpc({
  name: "gemini.dom.authorize",
  input: z.object({ clientId: identifier, jobId: identifier, token: identifier }).strict(),
  output: z.object({ authorized: z.boolean() }),
});
