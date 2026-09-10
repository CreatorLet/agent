const prompt = document.getElementById("prompt");
const key = document.getElementById("key");
const provider = document.getElementById("provider");
const build = document.getElementById("build");
const statusEl = document.getElementById("status");
const logs = document.getElementById("logs");
const frame = document.getElementById("frame");
const empty = document.getElementById("empty");
const open = document.getElementById("open");
let timer;
let lastCount = 0;

key.value = sessionStorage.getItem("prototypeKey") || "";
function headers() { return { "Content-Type": "application/json", "x-prototype-key": key.value.trim() }; }
function addLog(event) {
  if (logs.querySelector(".muted")) logs.innerHTML = "";
  const row = document.createElement("div");
  row.className = `log ${event.type}`;
  row.textContent = event.message;
  logs.appendChild(row);
  logs.scrollTop = logs.scrollHeight;
}
async function poll() {
  const r = await fetch("/api/status");
  const data = await r.json();
  statusEl.textContent = data.status;
  if (data.events.length > lastCount) {
    data.events.slice(lastCount).forEach(addLog);
    lastCount = data.events.length;
  }
  if (data.status === "ready" && data.preview) {
    clearInterval(timer);
    frame.src = `${data.preview}?t=${Date.now()}`;
    open.href = data.preview;
    open.classList.remove("disabled");
    empty.style.display = "none";
    build.disabled = false;
  } else if (data.status === "error") {
    clearInterval(timer);
    build.disabled = false;
  }
}
build.addEventListener("click", async () => {
  const value = prompt.value.trim();
  const prototypeKey = key.value.trim();
  if (!prototypeKey) return alert("Enter the prototype key first.");
  if (!value) return alert("Describe what you want to build first.");
  sessionStorage.setItem("prototypeKey", prototypeKey);
  build.disabled = true;
  statusEl.textContent = "starting";
  logs.innerHTML = "";
  lastCount = 0;
  frame.src = "about:blank";
  empty.style.display = "grid";
  open.classList.add("disabled");
  let r;
  try {
    r = await fetch("/api/build", { method: "POST", headers: headers(), body: JSON.stringify({ prompt: value, provider: provider.value }) });
  } catch (error) {
    build.disabled = false;
    addLog({ type: "error", message: String(error) });
    return;
  }
  const data = await r.json();
  if (!r.ok) {
    build.disabled = false;
    addLog({ type: "error", message: data.error || "Unable to start build." });
    statusEl.textContent = "error";
    return;
  }
  clearInterval(timer);
  timer = setInterval(poll, 800);
  poll();
});
