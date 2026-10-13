import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalToolExecutor } from "../server/local-tools";
import type { LocalToolRequest } from "../server/tool-protocol";

async function workspace(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), "paseo-tools-test-"));
  const cwd = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { cwd, outside, executor: new LocalToolExecutor(cwd) };
}

function request(tool: LocalToolRequest["tool"], args: Record<string, unknown>): LocalToolRequest {
  return { id: "tool-1", tool, arguments: args };
}

test("writes UTF-8 files, creates parents, and lists and reads inside the workspace", async (t) => {
  const { cwd, executor } = await workspace(t);
  await executor.execute(request("write_file", { path: "nested/hello.txt", content: "안녕하세요\nhello" }));
  assert.equal(await readFile(path.join(cwd, "nested/hello.txt"), "utf8"), "안녕하세요\nhello");
  assert.equal(await executor.execute(request("read_file", { path: "nested/hello.txt" })), "안녕하세요\nhello");
  assert.match(await executor.execute(request("list_directory", { path: "." })), /nested/);
  await executor.execute(request("write_file", { path: "nested/hello.txt", content: "updated" }));
  assert.equal(await readFile(path.join(cwd, "nested/hello.txt"), "utf8"), "updated");
  assert.deepEqual(await readdir(path.join(cwd, "nested")), ["hello.txt"]);
});

test("rejects relative and absolute traversal before any write", async (t) => {
  const { cwd, outside, executor } = await workspace(t);
  for (const name of ["../outside/new/file.txt", path.join(outside, "absolute.txt")]) {
    await assert.rejects(executor.execute(request("write_file", { path: name, content: "escape" })), /outside|workspace/i);
    await assert.rejects(executor.execute(request("read_file", { path: name })), /outside|workspace/i);
  }
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(cwd), []);
});

test("rejects junction escapes for reads, listings, writes, and missing parents", async (t) => {
  const { cwd, outside, executor } = await workspace(t);
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await symlink(outside, path.join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(executor.execute(request("read_file", { path: "escape/secret.txt" })), /outside|workspace/i);
  await assert.rejects(executor.execute(request("list_directory", { path: "escape" })), /outside|workspace/i);
  await assert.rejects(executor.execute(request("write_file", { path: "escape/created/file.txt", content: "bad" })), /outside|workspace/i);
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
});

test("allows internal links while preventing writes through aliases into .git", async (t) => {
  const { cwd, executor } = await workspace(t);
  await mkdir(path.join(cwd, "actual"));
  await mkdir(path.join(cwd, ".git"));
  await writeFile(path.join(cwd, "actual", "file.txt"), "inside");
  await symlink(path.join(cwd, "actual"), path.join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  await symlink(path.join(cwd, ".git"), path.join(cwd, "metadata"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await executor.execute(request("read_file", { path: "alias/file.txt" })), "inside");
  await assert.rejects(executor.execute(request("write_file", { path: ".git/config", content: "bad" })), /\.git/i);
  await assert.rejects(executor.execute(request("write_file", { path: "metadata/config", content: "bad" })), /\.git/i);
});

test("limits read and write sizes in bytes without creating files", async (t) => {
  const { cwd, executor } = await workspace(t);
  await writeFile(path.join(cwd, "large.txt"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(executor.execute(request("read_file", { path: "large.txt" })), /256|size|large|limit/i);
  await assert.rejects(executor.execute(request("write_file", { path: "new/file.txt", content: "한".repeat(100_000) })), /256|size|large|limit/i);
  assert.deepEqual(await readdir(cwd), ["large.txt"]);
});

test("validates arguments and rejects Windows device names and alternate streams", async (t) => {
  const { executor } = await workspace(t);
  for (const name of ["file.txt:stream", "NUL", "folder/COM1.txt", "trailing. "]) {
    await assert.rejects(executor.execute(request("write_file", { path: name, content: "bad" })), /path|reserved|device/i);
  }
  await assert.rejects(executor.execute(request("write_file", { path: "file.txt", content: 1 })), /content/i);
  await assert.rejects(executor.execute(request("run_command", { command: "", timeout_ms: 1000 })), /command/i);
  await assert.rejects(executor.execute(request("run_command", { command: "echo hi", timeout_ms: 60_001 })), /timeout/i);
});

test("reports mutation status and descriptions for approval before execution", async (t) => {
  const { cwd, executor } = await workspace(t);
  const write = request("write_file", { path: "new/file.txt", content: "test" });
  assert.equal(executor.isMutation(write), true);
  assert.equal(executor.isMutation(request("run_command", { command: "echo hello" })), true);
  assert.equal(executor.isMutation(request("read_file", { path: "hello.txt" })), false);
  assert.match(executor.describeTool(write), /new[/\\]file\.txt/);
  await executor.validate(write);
  assert.deepEqual(await readdir(cwd), []);
});

test("runs an explicit command in the workspace and returns exit status", async (t) => {
  const { cwd, executor } = await workspace(t);
  const command = process.platform === "win32" ? "[Console]::WriteLine((Get-Location).Path); [Console]::Error.WriteLine('stderr-marker'); exit 7" : "pwd; printf stderr-marker >&2; exit 7";
  const result = await executor.execute(request("run_command", { command }));
  assert.match(result, /stderr-marker/);
  assert.match(result, /exit[^\n]*7/i);
  assert.ok(result.toLowerCase().includes(cwd.toLowerCase()));
});

test("bounds command output and marks truncation", async (t) => {
  const { executor } = await workspace(t);
  const command = process.platform === "win32" ? "[Console]::Write('x' * 100000)" : "head -c 100000 /dev/zero | tr '\\0' x";
  const output = await executor.execute(request("run_command", { command }));
  assert.ok(Buffer.byteLength(output) < 34 * 1024);
  assert.match(output, /truncat/i);
});

test("does not execute an already cancelled request", async (t) => {
  const { cwd, executor } = await workspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executor.execute(request("write_file", { path: "file.txt", content: "bad" }), controller.signal), /abort|cancel/i);
  assert.deepEqual(await readdir(cwd), []);
});

test("times out an executing command", { timeout: 15_000 }, async (t) => {
  const { executor } = await workspace(t);
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  await assert.rejects(executor.execute(request("run_command", { command, timeout_ms: 250 })), /time.*out/i);
});

test("cancels the whole running process tree before descendants can write", { timeout: 20_000 }, async (t) => {
  const { cwd, executor } = await workspace(t);
  const scriptPath = path.join(cwd, "child.cjs");
  await writeFile(scriptPath, "require('node:fs').writeFileSync('started.txt', 'started'); setTimeout(() => require('node:fs').writeFileSync('escaped.txt', 'bad'), 3000); setInterval(() => {}, 1000);");
  const quotedNode = process.execPath.replace(/'/g, "''");
  const command = process.platform === "win32" ? "& '" + quotedNode + "' './child.cjs'" : "'" + process.execPath.replace(/'/g, "'\\''") + "' ./child.cjs";
  const controller = new AbortController();
  const running = executor.execute(request("run_command", { command }), controller.signal);
  const rejection = assert.rejects(running, /abort|cancel/i);
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(cwd)).includes("started.txt")) { started = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
  await rejection;
  assert.equal(started, true, "the descendant ran before cancellation");
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.ok(!(await readdir(cwd)).includes("escaped.txt"));
});
