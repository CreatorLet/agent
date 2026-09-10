import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn, ChildProcess } from "node:child_process";
import { ROOT, cleanWorkspace, runAgent, type Provider, type AgentEvent } from "./agent.js";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PUBLIC = path.resolve(process.cwd(), "public");
const PREVIEW_PORT = 4100;
const PROTOTYPE_KEY = process.env.PROTOTYPE_KEY || "";

app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC));

let buildRunning = false;
let status: "idle" | "building" | "ready" | "error" = "idle";
let lastError = "";
const events: AgentEvent[] = [];
let previewProcess: ChildProcess | null = null;
let previewKind: "static" | "node" | "none" = "none";
let previewRoot = ROOT;

function push(event: AgentEvent) {
  events.push({ ...event, message: event.message.slice(0, 8000) });
  if (events.length > 300) events.splice(0, events.length - 300);
}
function authorized(req: express.Request) {
  return !PROTOTYPE_KEY || req.get("x-prototype-key") === PROTOTYPE_KEY;
}
async function exists(target: string) {
  try { await fs.access(target); return true; } catch { return false; }
}
async function readPackage() {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")); } catch { return null; }
}
async function stopPreview() {
  if (!previewProcess) return;
  try { previewProcess.kill("SIGTERM"); } catch { /* already stopped */ }
  previewProcess = null;
}
async function startPreview() {
  await stopPreview();
  previewKind = "none";
  previewRoot = ROOT;
  const dist = path.join(ROOT, "dist");
  const build = path.join(ROOT, "build");
  const index = path.join(ROOT, "index.html");
  if (await exists(dist) && await exists(path.join(dist, "index.html"))) { previewKind = "static"; previewRoot = dist; return; }
  if (await exists(build) && await exists(path.join(build, "index.html"))) { previewKind = "static"; previewRoot = build; return; }
  if (await exists(index)) { previewKind = "static"; previewRoot = ROOT; return; }
  const pkg = await readPackage();
  if (!pkg?.scripts?.start) throw new Error("The agent finished, but no previewable index.html/dist/build or npm start script was found.");
  previewKind = "node";
  previewProcess = spawn("npm", ["run", "start"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PREVIEW_PORT), HOST: "0.0.0.0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  previewProcess.stdout?.on("data", chunk => push({ type: "tool", message: `preview: ${String(chunk).trim().slice(0, 1000)}` }));
  previewProcess.stderr?.on("data", chunk => push({ type: "tool", message: `preview: ${String(chunk).trim().slice(0, 1000)}` }));
  previewProcess.on("exit", code => { if (code && status === "ready") push({ type: "error", message: `Preview process exited with code ${code}.` }); previewProcess = null; });
  await new Promise(resolve => setTimeout(resolve, 1800));
}
async function proxyPreview(req: express.Request, res: express.Response) {
  const targetPath = req.originalUrl.replace(/^\/preview/, "") || "/";
  if (previewKind === "static") {
    const safe = path.resolve(previewRoot, "." + targetPath);
    if (safe !== previewRoot && !safe.startsWith(previewRoot + path.sep)) return res.status(400).send("Invalid preview path");
    try { const stat = await fs.stat(safe); if (stat.isFile()) return res.sendFile(safe); } catch { /* fall through */ }
    const spaIndex = path.join(previewRoot, "index.html");
    if (await exists(spaIndex)) return res.sendFile(spaIndex);
    return res.status(404).send("Preview file not found");
  }
  if (previewKind !== "node") return res.status(404).send("No preview is available yet.");
  const proxyReq = http.request({ hostname: "127.0.0.1", port: PREVIEW_PORT, path: targetPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${PREVIEW_PORT}` } }, proxyRes => {
    res.status(proxyRes.statusCode || 502);
    Object.entries(proxyRes.headers).forEach(([key, value]) => { if (value !== undefined) res.setHeader(key, value as any); });
    proxyRes.pipe(res);
  });
  proxyReq.on("error", error => res.status(502).send(`Preview unavailable: ${error.message}`));
  if (req.body && Object.keys(req.body).length) proxyReq.write(JSON.stringify(req.body));
  proxyReq.end();
}

app.get("/health", (_req, res) => res.json({ ok: true, status, preview: previewKind !== "none" }));
app.get("/api/status", (_req, res) => res.json({ status, events, error: lastError, preview: previewKind !== "none" ? "/preview/" : null }));
app.get("/preview/*splat", proxyPreview);
app.get("/preview", proxyPreview);

app.post("/api/build", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Invalid prototype key." });
  if (buildRunning) return res.status(409).json({ error: "A build is already running. Please wait for it to finish." });
  const prompt = String(req.body?.prompt || "").trim();
  const provider = String(req.body?.provider || "groq") as Provider;
  if (!prompt) return res.status(400).json({ error: "Prompt is required." });
  if (!["groq", "anthropic"].includes(provider)) return res.status(400).json({ error: "Unsupported provider." });
  buildRunning = true; status = "building"; lastError = ""; events.length = 0;
  res.json({ ok: true });
  void (async () => {
    try {
      await cleanWorkspace();
      push({ type: "text", message: "Starting a fresh prototype workspace..." });
      await runAgent(provider, prompt, push);
      push({ type: "text", message: "Agent work finished. Preparing preview..." });
      await startPreview();
      status = "ready";
      push({ type: "done", message: "Preview is ready." });
    } catch (error) {
      status = "error";
      lastError = error instanceof Error ? error.message : String(error);
      push({ type: "error", message: lastError });
    } finally { buildRunning = false; }
  })();
});

app.get("/api/files", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Invalid prototype key." });
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries = [] as Awaited<ReturnType<typeof fs.readdir>>;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (["node_modules", ".git"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await walk(full)); else out.push(path.relative(ROOT, full));
    }
    return out;
  }
  res.json({ files: await walk(ROOT) });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Agent prototype listening on ${PORT}`));
process.on("SIGTERM", async () => { await stopPreview(); process.exit(0); });
process.on("SIGINT", async () => { await stopPreview(); process.exit(0); });
