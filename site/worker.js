/* Dedicated worker: all story processing is local, requests go directly to the user's API. */
const SAVE_FORMAT = "oc-world-local-save";
const SAVE_VERSION = 1;
let python = null;
let initialized = false;
let requestNumber = 0;
let requestId = null;
let checkpointNumber = 0;
let handling = false;
let checkpointAcksEnabled = false;
const pendingCheckpoints = new Map();
let checkpointFailure = null;

function progress(phase, message) { self.postMessage({type: "progress", phase, message, requests: requestNumber}); }

function checkedPath(path) {
  if (typeof path !== "string" || !path || path.length > 512 || /[\\:\u0000-\u001f]/.test(path) ||
      path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("存档含无效文件路径");
  }
  return path;
}

function snapshotFiles() {
  const files = [];
  function walk(directory, relative) {
    for (const name of python.FS.readdir(directory).filter(name => name !== "." && name !== "..").sort()) {
      const path = `${directory}/${name}`;
      const archivePath = relative ? `${relative}/${name}` : name;
      const info = python.FS.lstat(path);
      if (python.FS.isLink(info.mode)) throw new Error("存档不支持符号链接");
      // Recovery uses chapter_work in world.db. Temporary simulation copies are
      // discarded on restart and do not belong in device saves or backups.
      if (python.FS.isDir(info.mode)) {
        if (name !== ".chapter-work") walk(path, archivePath);
      }
      else if (python.FS.isFile(info.mode)) files.push({path: checkedPath(archivePath), bytes: python.FS.readFile(path)});
    }
  }
  walk("/data", "");
  return {format: SAVE_FORMAT, version: SAVE_VERSION, files};
}

function restoreFiles(snapshot) {
  if (!snapshot) return;
  if (snapshot.format !== SAVE_FORMAT || snapshot.version !== SAVE_VERSION ||
      !Array.isArray(snapshot.files) || snapshot.files.length > 4096) throw new Error("存档版本不支持");
  const paths = new Set();
  let bytes = 0;
  for (const file of snapshot.files) {
    const path = checkedPath(file.path);
    if (paths.has(path) || !(file.bytes instanceof Uint8Array)) throw new Error("存档文件条目无效");
    paths.add(path);
    bytes += file.bytes.byteLength;
    if (bytes > 200 * 1024 * 1024) throw new Error("存档超过导入上限");
    const target = `/data/${path}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    python.FS.mkdirTree(parent);
    python.FS.writeFile(target, file.bytes);
  }
}

// This callback copies committed files synchronously. IndexedDB confirmation is asynchronous
// in the main thread; dispatch completion waits for that confirmation before reporting success.
self.ocBrowserCheckpoint = () => {
  if (!python) return;
  if (checkpointFailure) throw checkpointFailure;
  const checkpoint = {type: "checkpoint", requestId, snapshot: snapshotFiles()};
  // Cached older main scripts do not send ACKs. Only opt in when initialization
  // explicitly advertises support, so a mixed cached version cannot hang.
  if (checkpointAcksEnabled) {
    checkpoint.sequence = ++checkpointNumber;
    let acknowledge;
    const confirmed = new Promise(resolve => { acknowledge = resolve; });
    pendingCheckpoints.set(checkpoint.sequence, {requestId, confirmed, acknowledge});
  }
  self.postMessage(checkpoint);
};

async function waitForCheckpoints(id) {
  if (!checkpointAcksEnabled) return;
  if (checkpointFailure) throw checkpointFailure;
  const confirmations = [...pendingCheckpoints.values()]
    .filter(checkpoint => checkpoint.requestId === id).map(checkpoint => checkpoint.confirmed);
  await Promise.all(confirmations);
  if (checkpointFailure) throw checkpointFailure;
}

function acknowledgeCheckpoint(message) {
  if (!checkpointAcksEnabled) return;
  const checkpoint = pendingCheckpoints.get(message.sequence);
  if (!checkpoint || checkpoint.requestId !== message.requestId) return;
  if (message.ok !== true) {
    checkpointFailure = new Error("本地存档保存失败，生成已停止。请导出备份后重新打开页面。");
    checkpointFailure.code = "storage_failed";
    for (const pending of pendingCheckpoints.values()) pending.acknowledge();
    pendingCheckpoints.clear();
    return;
  }
  pendingCheckpoints.delete(message.sequence);
  checkpoint.acknowledge();
}

// Python's provider is synchronous. Synchronous XHR is allowed in this dedicated worker,
// keeping the existing engine independent of browser UI while avoiding a hosted proxy.
self.ocBrowserRequest = (url, bodyText, headersJson, timeoutMs) => {
  if (checkpointFailure) throw checkpointFailure;
  const target = new URL(String(url));
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("浏览器 API 地址需要使用 HTTPS");
  }
  const headers = JSON.parse(String(headersJson));
  const request = new XMLHttpRequest();
  progress("model", "正在调用模型，故事数据直接发送到你设置的 API…");
  requestNumber++;
  try {
    request.open("POST", target.href, false);
    request.timeout = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, String(value));
    request.send(String(bodyText));
  } catch (error) {
    // Do not serialize headers, API keys, or echoed request bodies into local error logs.
    return JSON.stringify({status: 0, timeout: error?.name === "TimeoutError",
      error: "API 请求未完成：请检查网络、地址及服务的浏览器跨域支持；本次未自动重试"});
  }
  if (!request.status) return JSON.stringify({status: 0, error: "API 未返回可读取的响应，请检查跨域支持或网络"});
  return JSON.stringify({status: request.status, body: request.responseText});
};

async function digest(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

async function initialize(message) {
  if (initialized) throw new Error("故事引擎已初始化");
  checkpointAcksEnabled = message.checkpointAcks === true;
  progress("runtime", "首次打开需要下载浏览器运行环境，请稍候…");
  const runtimeUrl = String(message.runtimeUrl);
  // Versioned runtime, not an arbitrary script supplied by archive data.
  if (runtimeUrl !== "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/") throw new Error("运行环境版本不支持");
  importScripts(`${runtimeUrl}pyodide.js`);
  python = await loadPyodide({indexURL: runtimeUrl});
  await python.loadPackage(["sqlite3", "ssl"]);
  progress("engine", "载入故事引擎…");
  const [manifestResponse, engineResponse] = await Promise.all([
    fetch(message.manifestUrl, {cache: "no-store"}), fetch(message.engineUrl, {cache: "no-store"}),
  ]);
  if (!manifestResponse.ok || !engineResponse.ok) throw new Error("故事引擎文件下载失败，请刷新页面");
  const manifest = await manifestResponse.json();
  const archive = new Uint8Array(await engineResponse.arrayBuffer());
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 || "") || await digest(archive) !== manifest.sha256) {
    throw new Error("故事引擎文件校验失败，请重新打开页面");
  }
  python.FS.mkdirTree("/app");
  python.FS.mkdirTree("/data");
  python.unpackArchive(archive, "zip", {extractDir: "/app"});
  restoreFiles(message.snapshot);
  await python.runPythonAsync(`
import sys, json
sys.path.insert(0, '/app')
from src.browser_runtime import BrowserRuntime
oc_runtime = BrowserRuntime(root='/app', data_root='/data')
`);
  initialized = true;
  self.ocBrowserCheckpoint();
  progress("ready", "故事引擎已就绪，存档保存在当前设备");
  return {ready: true, version: manifest.version || null};
}

async function dispatch(message) {
  if (!initialized) throw new Error("故事引擎尚未就绪");
  if (!["GET", "POST"].includes(message.method) || typeof message.path !== "string" || !message.path.startsWith("/api/")) {
    throw new Error("无效的引擎请求");
  }
  python.globals.set("oc_request_json", JSON.stringify({method: message.method, path: message.path, body: message.body ?? null}));
  let changed = true;
  try {
    const response = await python.runPythonAsync(`
oc_request = json.loads(oc_request_json)
oc_result = oc_runtime.dispatch(oc_request['method'], oc_request['path'], oc_request['body'])
json.dumps({'result': oc_result, 'changed': getattr(oc_runtime, 'storage_changed', True)}, ensure_ascii=False)
`);
    const envelope = JSON.parse(response);
    // The Python wrapper also marks older engines without this flag as changed.
    changed = envelope.changed;
    return envelope.result;
  } finally {
    python.globals.delete("oc_request_json");
    python.runPython("oc_request = None; oc_result = None");
    if (changed) self.ocBrowserCheckpoint();
  }
}

self.onmessage = async event => {
  const message = event.data || {};
  // ACKs must be handled while the original operation is waiting for storage.
  if (message.type === "checkpoint_ack") { acknowledgeCheckpoint(message); return; }
  if (handling) { self.postMessage({id: message.id, ok: false, code: "library_busy", error: "故事引擎正在处理另一个操作"}); return; }
  handling = true;
  requestId = message.id;
  try {
    if (checkpointFailure) throw checkpointFailure;
    let value;
    if (message.type === "initialize") value = await initialize(message);
    else if (message.type === "dispatch") value = await dispatch(message);
    else throw new Error("未知的引擎操作");
    await waitForCheckpoints(message.id);
    self.postMessage({id: message.id, ok: true, value});
  } catch (error) {
    try { await waitForCheckpoints(message.id); }
    catch (storageError) { error = storageError; }
    // Detailed Python/provider errors are sanitized inside BrowserRuntime. Unexpected errors
    // use a fixed public message instead of a traceback that could contain request details.
    const known = error instanceof Error && !error.name?.includes("Python");
    self.postMessage({id: message.id, ok: false, code: error?.code === "storage_failed" ? "storage_failed" : "worker_error",
      error: known ? error.message : "故事引擎操作未完成，已保存节点保持不变"});
  } finally { handling = false; requestId = null; }
};
