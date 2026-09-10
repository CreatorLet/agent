import Groq from "groq-sdk";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";

export const ROOT = path.resolve(process.cwd(), "workspace");
const MAX_STEPS = 50;
const COMMAND_TIMEOUT = 120_000;
const MAX_COMMAND_OUTPUT = 12_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "venv", "__pycache__"]);

export type Provider = "groq" | "anthropic";
export type AgentEvent = { type: "text" | "tool" | "error" | "done"; message: string };

const SYSTEM = `You are an autonomous coding agent running on a Linux server inside an isolated project workspace.

Turn the user's request into working code. Do not merely explain it.

Workflow:
1. Inspect the workspace before changing anything.
2. Choose a practical implementation.
3. Create/edit/delete files as needed.
4. Install dependencies when required.
5. Run builds, tests, or other useful checks.
6. Read failures carefully and fix them.
7. Re-run checks after fixes.
8. Audit the final project against every requirement.
9. Never claim completion while known errors remain.

Hosted prototype rules:
- Only modify files inside the workspace.
- Use Linux-compatible shell commands and Node/npm commands.
- Never start a long-running development server yourself; the host will start it after the build.
- For Node web servers, listen on process.env.PORT with a fallback such as 3001 and bind normally so the host can proxy to it.
- For static sites, keep an index.html or produce a standard dist/build folder.
- Prefer simple, reliable implementations over unnecessary complexity.
- Use relative workspace paths.
- Do not access secrets or files outside the workspace.

Tool-call discipline:
- Always provide valid JSON matching the tool schema.
- write_file must contain complete file content.
- edit_file old_text must occur exactly once.
- Verify meaningful changes with commands before finishing.
`;

const tools = [
  {
    name: "list_files",
    description: "List workspace files/directories.",
    input_schema: { type: "object", properties: { directory: { type: "string" } }, required: [], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file.",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file. Parent directories are created automatically.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false },
  },
  {
    name: "edit_file",
    description: "Replace one exact text fragment in a file. old_text must occur exactly once.",
    input_schema: { type: "object", properties: { file_path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["file_path", "old_text", "new_text"], additionalProperties: false },
  },
  {
    name: "delete_file",
    description: "Delete a file or empty directory inside the workspace.",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false },
  },
  {
    name: "search_files",
    description: "Search text recursively in workspace text files.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "run_command",
    description: "Run a shell command from the workspace for installs, builds, tests, or debugging. Do not use it for long-running servers.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
  },
];

function safePath(inputPath: string) {
  const resolved = path.resolve(ROOT, inputPath || ".");
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw new Error("Path escapes workspace");
  return resolved;
}
function rel(target: string) { return path.relative(ROOT, target) || "."; }
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

async function listFiles(directory = ".") {
  const dir = safePath(directory);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(e => !SKIP_DIRS.has(e.name)).map(e => `${e.isDirectory() ? "[dir] " : "      "}${rel(path.join(dir, e.name))}`).join("\n") || "(empty)";
}
async function readFile(filePath: string) { return fs.readFile(safePath(filePath), "utf8"); }
async function writeFile(filePath: string, content: string) {
  const target = safePath(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return `Wrote ${rel(target)} (${content.length} characters)`;
}
async function editFile(filePath: string, oldText: string, newText: string) {
  const target = safePath(filePath);
  const current = await fs.readFile(target, "utf8");
  const count = oldText ? current.split(oldText).length - 1 : 0;
  if (count !== 1) throw new Error(`Expected old_text exactly once, found ${count} times`);
  await fs.writeFile(target, current.replace(oldText, newText), "utf8");
  return `Edited ${rel(target)}`;
}
async function deleteFile(filePath: string) {
  const target = safePath(filePath);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) await fs.rmdir(target); else await fs.unlink(target);
  return `Deleted ${rel(target)}`;
}
async function searchFiles(query: string) {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (results.length >= 50) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); if (results.length >= 50) return; continue; }
      try {
        const text = await fs.readFile(full, "utf8");
        if (!text.includes(query)) continue;
        const lines = text.split(/\r?\n/).map((line, i) => line.includes(query) ? `${i + 1}: ${line.slice(0, 300)}` : "").filter(Boolean).slice(0, 8);
        results.push(`${rel(full)}\n${lines.join("\n")}`);
      } catch { /* ignore binaries */ }
      if (results.length >= 50) return;
    }
  }
  await walk(ROOT);
  return results.join("\n\n") || "No matches found.";
}
async function runCommand(command: string) {
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve => {
    exec(command, { cwd: ROOT, shell: process.env.SHELL || "/bin/bash", timeout: COMMAND_TIMEOUT, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr || error?.message || ""), exitCode: typeof error?.code === "number" ? error.code : 0 });
    });
  });
  return [`EXIT_CODE: ${result.exitCode}`, result.stdout ? `STDOUT:\n${result.stdout}` : "", result.stderr ? `STDERR:\n${result.stderr}` : ""].filter(Boolean).join("\n\n").slice(0, MAX_COMMAND_OUTPUT) || "Command completed with no output.";
}
async function execute(name: string, input: Record<string, unknown>) {
  switch (name) {
    case "list_files": return listFiles(String(input.directory ?? "."));
    case "read_file": return readFile(String(input.file_path ?? ""));
    case "write_file": return writeFile(String(input.file_path ?? ""), String(input.content ?? ""));
    case "edit_file": return editFile(String(input.file_path ?? ""), String(input.old_text ?? ""), String(input.new_text ?? ""));
    case "delete_file": return deleteFile(String(input.file_path ?? ""));
    case "search_files": return searchFiles(String(input.query ?? ""));
    case "run_command": return runCommand(String(input.command ?? ""));
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (record(value)) return value;
  const parsed = JSON.parse(String(value).replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim());
  if (!record(parsed)) throw new Error("Tool arguments must decode to an object");
  return parsed;
}

const openAiTools = tools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

export async function ensureWorkspace() {
  await fs.mkdir(ROOT, { recursive: true });
}
export async function cleanWorkspace() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
}

export async function runAgent(provider: Provider, userPrompt: string, emit: (event: AgentEvent) => void) {
  await ensureWorkspace();
  if (provider === "groq") {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not configured on the server.");
    const client = new Groq({ apiKey: key });
    let messages: any[] = [{ role: "user", content: userPrompt }];
    for (let step = 1; step <= MAX_STEPS; step++) {
      const response = await client.chat.completions.create({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        tools: openAiTools,
        tool_choice: "auto",
        temperature: 0,
      });
      const message: any = response.choices[0]?.message;
      if (message?.content) emit({ type: "text", message: String(message.content) });
      messages.push(message);
      const calls = message?.tool_calls ?? [];
      if (!calls.length) { emit({ type: "done", message: "Agent finished." }); return; }
      for (const call of calls) {
        const name = String(call.function?.name || "");
        emit({ type: "tool", message: `Running ${name}` });
        let result: string;
        try {
          result = await execute(name, normalizeArgs(call.function?.arguments));
        } catch (error) {
          result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
        emit({ type: result.startsWith("ERROR:") ? "error" : "tool", message: result.startsWith("ERROR:") ? result : `${name} completed` });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    throw new Error(`Agent stopped after ${MAX_STEPS} steps.`);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  const client = new Anthropic({ apiKey: key });
  const messages: any[] = [{ role: "user", content: userPrompt }];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const response: any = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 12_000,
      system: SYSTEM,
      messages,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    });
    const toolResults: any[] = [];
    for (const block of response.content ?? []) {
      if (block.type === "text") emit({ type: "text", message: block.text });
      if (block.type === "tool_use") {
        emit({ type: "tool", message: `Running ${block.name}` });
        let result: string;
        try { result = await execute(block.name, record(block.input) ? block.input : {}); }
        catch (error) { result = `ERROR: ${error instanceof Error ? error.message : String(error)}`; }
        emit({ type: result.startsWith("ERROR:") ? "error" : "tool", message: result.startsWith("ERROR:") ? result : `${block.name} completed` });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }
    messages.push({ role: "assistant", content: response.content });
    if (!toolResults.length) { emit({ type: "done", message: "Agent finished." }); return; }
    messages.push({ role: "user", content: toolResults });
  }
  throw new Error(`Agent stopped after ${MAX_STEPS} steps.`);
}
