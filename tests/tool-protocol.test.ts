import assert from "node:assert/strict";
import test from "node:test";
import { parseToolRequest } from "../server/tool-protocol";

const request = { id: "read-1", tool: "read_file", arguments: { path: "README.md" } };
const block = "```paseo_tool\n" + JSON.stringify(request) + "\n```";

test("parses one complete tool response", () => {
  assert.deepEqual(parseToolRequest(" \n" + block + "\n "), request);
});

test("does not execute embedded tool examples or other code fences", () => {
  for (const text of ["Hello", "Example:\n" + block, "```json\n" + JSON.stringify(request) + "\n```", "`paseo_tool` is a protocol."]) {
    assert.equal(parseToolRequest(text), null);
  }
});

test("rejects malformed explicit requests and multiple blocks", () => {
  for (const text of ["```paseo_tool\nnot JSON\n```", "```paseo_tool\n{}", block + "\n" + block, block + "\nDone", "```paseo_tool\n[]\n```", "```paseo_tool\nnull\n```", "```paseo_tool\n" + JSON.stringify({ ...request, id: "" }) + "\n```", "```paseo_tool\n" + JSON.stringify({ ...request, tool: "delete_everything" }) + "\n```", "```paseo_tool\n" + JSON.stringify({ ...request, arguments: [] }) + "\n```"] ) {
    assert.throws(() => parseToolRequest(text), /tool|request|JSON/i);
  }
});

test("rejects non-string tool names even when their string representation matches", () => {
  const text = "```paseo_tool\n" + JSON.stringify({ ...request, tool: ["read_file"] }) + "\n```";
  assert.throws(() => parseToolRequest(text), /tool/i);
});

test("accepts matching longer fences around tool JSON containing shorter code fences", () => {
  const writing = { id: "write-1", tool: "write_file", arguments: { path: "README.md", content: "```js\nexample();\n```" } };
  for (const fence of ["```", "````", "``````"]) {
    assert.deepEqual(parseToolRequest(fence + "paseo_tool\n" + JSON.stringify(writing) + "\n" + fence), writing);
    assert.deepEqual(parseToolRequest(fence + "paseo_tool" + JSON.stringify(writing) + fence), writing);
  }
});

test("rejects mismatched long fences and multiple executable blocks", () => {
  const json = JSON.stringify(request);
  for (const text of [
    "````paseo_tool\n" + json + "\n```",
    "```paseo_tool\n" + json + "\n````",
    "````paseo_tool\n" + json + "\n`````",
    "````paseo_tool\n" + json + "\n````\n" + block,
    "````paseo_tool\n" + json + "\n````\nexplanation",
  ]) assert.throws(() => parseToolRequest(text), /tool|request|JSON/i);
  assert.equal(parseToolRequest("Example:\n````paseo_tool\n" + json + "\n````"), null);
});

test("parses exact protocol-marked JSON in case-insensitive standard or unlabeled fences", () => {
  const envelope = { protocol: "paseo_tool", ...request };
  for (const language of ["json", "JSON", "Json", ""]) {
    for (const fence of ["```", "````"]) {
      assert.deepEqual(parseToolRequest(fence + language + "\n" + JSON.stringify(envelope) + "\n" + fence), request);
    }
  }
  const writing = { id: "write-1", tool: "write_file", arguments: { path: "README.md", content: "```js\nhello\n```" } };
  assert.deepEqual(parseToolRequest("````json\n" + JSON.stringify({ protocol: "paseo_tool", ...writing }) + "\n````"), writing);
});

test("never infers executable tools from unmarked or incorrectly marked JSON", () => {
  for (const language of ["json", "JSON", "Json", ""]) {
    for (const value of [request, { protocol: "PASEO_TOOL", ...request }, { protocol: "paseo_tool ", ...request },
      { protocol: ["paseo_tool"], ...request }, { protocol: null, ...request }, { type: "paseo_tool", ...request },
      { result: { protocol: "paseo_tool", ...request } }]) {
      assert.equal(parseToolRequest("```" + language + "\n" + JSON.stringify(value) + "\n```"), null);
    }
  }
  assert.equal(parseToolRequest("```json\nnot JSON\n```"), null);
  assert.equal(parseToolRequest("```javascript\n" + JSON.stringify({ protocol: "paseo_tool", ...request }) + "\n```"), null);
});

test("marked JSON still requires the whole response and matching single fences", () => {
  const payload = JSON.stringify({ protocol: "paseo_tool", ...request });
  const marked = "```json\n" + payload + "\n```";
  assert.equal(parseToolRequest("Example only:\n" + marked), null);
  assert.equal(parseToolRequest("The protocol marker is paseo_tool."), null);
  for (const invalid of [marked + "\n" + marked, marked + "\nDone", "````json\n" + payload + "\n```",
    "```\n" + payload + "\n````", "```json\n{\"protocol\":\"paseo_tool\",\n```",
    "```json\n" + JSON.stringify({ protocol: "paseo_tool", ...request, tool: "unknown" }) + "\n```",
    "```json\n" + JSON.stringify({ protocol: "paseo_tool", ...request, id: "" }) + "\n```",
    "```json\n" + JSON.stringify({ protocol: "paseo_tool", ...request, unexpected: true }) + "\n```",
  ]) assert.throws(() => parseToolRequest(invalid), /tool|request|JSON/i);
});
