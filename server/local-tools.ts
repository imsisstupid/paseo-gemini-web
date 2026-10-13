import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { LocalToolRequest } from "./tool-protocol";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_TIMEOUT_MS = 60_000;

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Tool execution cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("File path resolves outside the workspace.");
  }
}

function ensureWritable(root: string, target: string): void {
  if (path.relative(root, target).split(path.sep).some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error("Writing .git metadata is not allowed by write_file.");
  }
}

function checkPathName(input: string): void {
  if (!input.trim() || /[\x00-\x1f]/.test(input) || /^\\\\[?.]\\/.test(input)) {
    throw new Error("Invalid file path.");
  }
  const withoutRoot = input.slice(path.parse(input).root.length);
  for (const segment of withoutRoot.split(/[\\/]/)) {
    if (segment === "" || segment === "." || segment === "..") continue;
    if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment)) {
      throw new Error("Invalid or reserved file path segment.");
    }
  }
}

function argumentsFor(request: LocalToolRequest): Record<string, unknown> {
  if (!request || !["list_directory", "read_file", "write_file", "run_command"].includes(request.tool)) {
    throw new Error("Unsupported local tool.");
  }
  const args = request.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments.");
  if (request.tool === "run_command") {
    if (typeof args.command !== "string" || !args.command.trim() || args.command.includes("\0")) {
      throw new Error("command must be a nonempty string without null bytes.");
    }
    if (Buffer.byteLength(args.command) > MAX_FILE_BYTES) throw new Error("command exceeds the 256 KiB size limit.");
    if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || Number(args.timeout_ms) < 1 || Number(args.timeout_ms) > MAX_TIMEOUT_MS)) {
      throw new Error("timeout_ms must be an integer between 1 and 60000.");
    }
  } else {
    if (typeof args.path !== "string") throw new Error("path must be a string.");
    checkPathName(args.path);
    if (request.tool === "write_file") {
      if (typeof args.content !== "string") throw new Error("content must be a string.");
      if (Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) throw new Error("File content exceeds the 256 KiB size limit.");
    }
  }
  return args;
}

export function isMutation(request: LocalToolRequest): boolean {
  return request.tool === "write_file" || request.tool === "run_command";
}

export function describeTool(request: LocalToolRequest): string {
  switch (request.tool) {
    case "list_directory": return `List directory: ${String(request.arguments.path)}`;
    case "read_file": return `Read file: ${String(request.arguments.path)}`;
    case "write_file": return `Write file: ${String(request.arguments.path)} (${Buffer.byteLength(String(request.arguments.content), "utf8")} bytes)`;
    case "run_command": return `Run command: ${String(request.arguments.command)}`;
  }
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", reject);
    killer.once("exit", (code) => {
      if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
      else reject(new Error("Could not terminate the command process tree."));
    });
  });
}

async function runCommand(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const isWindows = process.platform === "win32";
  const executable = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh";
  const script = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding;\n" + command;
  const args = isWindows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : ["-c", command];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, detached: !isWindows, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stopReason: Error | undefined;
    let stopping: Promise<void> | undefined;
    const collect = (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - size;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        size += kept.length;
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const stop = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      stopping = killProcessTree(child);
      // Attach immediately so a failed kill never creates an unhandled rejection.
      void stopping.catch(() => {});
    };
    const onAbort = () => { const error = new Error("Command cancelled."); error.name = "AbortError"; stop(error); };
    const timer = setTimeout(() => stop(new Error(`Command timed out after ${timeoutMs} ms.`)), timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, killedSignal) => {
      cleanup();
      void (async () => {
        if (stopping) await stopping;
        if (stopReason) throw stopReason;
        const output = Buffer.concat(chunks).toString("utf8");
        resolve(`Exit code: ${code ?? "none"}${killedSignal ? ` (${killedSignal})` : ""}\n${output}${truncated ? "\n[Output truncated at 32 KiB]" : ""}`);
      })().catch(reject);
    });
  });
}

export class LocalToolExecutor {
  private readonly workspacePath: string;

  constructor(cwd: string) {
    this.workspacePath = path.resolve(cwd);
  }

  private async root(): Promise<string> {
    const root = await realpath(this.workspacePath);
    if (!(await stat(root)).isDirectory()) throw new Error("Workspace must be a directory.");
    return root;
  }

  private async resolvePath(root: string, input: string, writing: boolean): Promise<string> {
    checkPathName(input);
    // Accept absolute paths using the originally selected workspace alias as well.
    const target = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    let lexical = target;
    if (path.isAbsolute(input) && root !== this.workspacePath) {
      const relative = path.relative(this.workspacePath, target);
      if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) lexical = path.resolve(root, relative);
    }
    ensureInside(root, lexical);
    if (writing) ensureWritable(root, lexical);
    let current = root;
    const segments = path.relative(root, lexical).split(path.sep).filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
      const next = path.join(current, segments[index]);
      try {
        await lstat(next);
      } catch (error) {
        if (!isMissing(error)) throw error;
        current = path.join(current, ...segments.slice(index));
        ensureInside(root, current);
        if (writing) ensureWritable(root, current);
        return current;
      }
      // A dangling link is rejected by realpath rather than treated as a missing file.
      current = await realpath(next);
      ensureInside(root, current);
      if (writing) ensureWritable(root, current);
    }
    return current;
  }

  async validate(request: LocalToolRequest): Promise<void> {
    const args = argumentsFor(request);
    const root = await this.root();
    if (request.tool === "run_command") return;
    const target = await this.resolvePath(root, args.path as string, request.tool === "write_file");
    try {
      const info = await stat(target);
      if (request.tool === "list_directory" ? !info.isDirectory() : !info.isFile()) throw new Error("Tool path has the wrong file type.");
      if (request.tool === "read_file" && info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 256 KiB read limit.");
    } catch (error) {
      if (!(request.tool === "write_file" && isMissing(error))) throw error;
    }
  }

  async execute(request: LocalToolRequest, signal?: AbortSignal): Promise<string> {
    cancelled(signal);
    await this.validate(request);
    cancelled(signal);
    const root = await this.root();
    const args = request.arguments;
    if (request.tool === "run_command") return runCommand(root, args.command as string, Number(args.timeout_ms ?? MAX_TIMEOUT_MS), signal);
    const target = await this.resolvePath(root, args.path as string, request.tool === "write_file");
    if (request.tool === "list_directory") {
      const entries = await readdir(target, { withFileTypes: true });
      const lines: string[] = [];
      let bytes = 0;
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        cancelled(signal);
        const line = `${entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "file"}\t${JSON.stringify(entry.name)}`;
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > MAX_OUTPUT_BYTES) { lines.push("[Directory listing truncated at 32 KiB]"); break; }
        lines.push(line);
      }
      return lines.join("\n") || "(empty directory)";
    }
    if (request.tool === "read_file") {
      const handle = await open(target, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("read_file requires a regular file.");
        if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 256 KiB read limit.");
        const data = Buffer.alloc(MAX_FILE_BYTES + 1);
        let size = 0;
        while (size < data.length) {
          cancelled(signal);
          const read = await handle.read(data, size, data.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > MAX_FILE_BYTES) throw new Error("File exceeds the 256 KiB read limit.");
        cancelled(signal);
        return data.subarray(0, size).toString("utf8");
      } finally { await handle.close(); }
    }
    const relativeParent = path.relative(root, path.dirname(target));
    let parent = root;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      cancelled(signal);
      parent = path.join(parent, segment);
      try { await mkdir(parent); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      parent = await this.resolvePath(root, parent, true);
      if (!(await stat(parent)).isDirectory()) throw new Error("File parent must be a directory.");
    }
    cancelled(signal);
    const destination = await this.resolvePath(root, args.path as string, true);
    if (destination !== target) throw new Error("File path changed while preparing the write.");
    const temporary = path.join(parent, `.paseo-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(args.content as string, { encoding: "utf8", signal });
      await handle.sync();
      await handle.close();
      cancelled(signal);
      if (await this.resolvePath(root, args.path as string, true) !== destination) throw new Error("File path changed while preparing the write.");
      await rename(temporary, destination);
      return `Wrote ${Buffer.byteLength(args.content as string, "utf8")} bytes to ${path.relative(root, destination)}.`;
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  describeTool(request: LocalToolRequest): string {
    return describeTool(request);
  }

  isMutation(request: LocalToolRequest): boolean {
    return isMutation(request);
  }
}
