// Local storage and worker bridge. API settings are intentionally memory-only.
export const SAVE_FORMAT = "oc-world-local-save";
export const SAVE_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 280 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_DATA_BYTES = 200 * 1024 * 1024;
const LOCK_NAME = "oc-world-browser-library-v1";
const encoder = new TextEncoder();

export class BrowserRuntimeError extends Error {
  constructor(message, code = "browser_error", status = 0) {
    super(message);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.status = status;
  }
}

export function validatePath(path) {
  if (typeof path !== "string" || !path || path.length > 512 ||
      /[\\:\u0000-\u001f]/.test(path) || path.startsWith("/") ||
      path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new BrowserRuntimeError("存档含无效文件路径", "invalid_archive");
  }
  return path;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== SAVE_FORMAT || snapshot.version !== SAVE_VERSION ||
      !Array.isArray(snapshot.files) || snapshot.files.length > MAX_FILES) {
    throw new BrowserRuntimeError("存档格式或版本不支持", "invalid_archive");
  }
  const paths = new Set();
  let size = 0;
  for (const file of snapshot.files) {
    validatePath(file.path);
    if (paths.has(file.path)) throw new BrowserRuntimeError("存档含重名文件", "invalid_archive");
    paths.add(file.path);
    if (!(file.bytes instanceof Uint8Array)) {
      throw new BrowserRuntimeError("存档文件数据无效", "invalid_archive");
    }
    size += file.bytes.byteLength;
    if (size > MAX_DATA_BYTES) throw new BrowserRuntimeError("存档超过本版 200 MB 导入上限", "invalid_archive");
  }
  return snapshot;
}

export async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(text);
}

function fromBase64(text) {
  if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new BrowserRuntimeError("存档文件编码无效", "invalid_archive");
  }
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function encodeArchive(snapshot) {
  validateSnapshot(snapshot);
  const files = [];
  for (const file of [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    files.push({path: file.path, size: file.bytes.byteLength, sha256: await sha256(file.bytes), data: toBase64(file.bytes)});
  }
  const content = {format: SAVE_FORMAT, version: SAVE_VERSION, files};
  const archive = {...content, exportedAt: new Date().toISOString(), checksum: await sha256(encoder.encode(JSON.stringify(content)))};
  return JSON.stringify(archive);
}

export async function decodeArchive(input) {
  let text;
  if (typeof input === "string") text = input;
  else if (input instanceof Blob) {
    if (input.size > MAX_ARCHIVE_BYTES) throw new BrowserRuntimeError("存档文件过大", "invalid_archive");
    text = await input.text();
  } else throw new BrowserRuntimeError("请选择完整存档文件", "invalid_archive");
  if (encoder.encode(text).byteLength > MAX_ARCHIVE_BYTES) throw new BrowserRuntimeError("存档文件过大", "invalid_archive");
  let archive;
  try { archive = JSON.parse(text); }
  catch { throw new BrowserRuntimeError("存档不是合法 JSON 文件", "invalid_archive"); }
  if (!archive || archive.format !== SAVE_FORMAT || archive.version !== SAVE_VERSION ||
      !Array.isArray(archive.files) || archive.files.length > MAX_FILES || !/^[a-f0-9]{64}$/.test(archive.checksum || "")) {
    throw new BrowserRuntimeError("存档格式或版本不支持", "invalid_archive");
  }
  const paths = new Set();
  let total = 0;
  const files = [];
  for (const file of archive.files) {
    if (!file || typeof file !== "object") throw new BrowserRuntimeError("存档文件条目无效", "invalid_archive");
    validatePath(file.path);
    if (paths.has(file.path)) throw new BrowserRuntimeError("存档含重名文件", "invalid_archive");
    paths.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_DATA_BYTES ||
        typeof file.data !== "string" || file.data.length > Math.ceil(file.size / 3) * 4 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 || "")) {
      throw new BrowserRuntimeError("存档文件大小或校验字段无效", "invalid_archive");
    }
    total += file.size;
    if (total > MAX_DATA_BYTES) throw new BrowserRuntimeError("存档超过本版 200 MB 导入上限", "invalid_archive");
    const bytes = fromBase64(file.data);
    if (bytes.byteLength !== file.size || await sha256(bytes) !== file.sha256) {
      throw new BrowserRuntimeError("存档文件校验失败，请使用未修改的完整备份", "invalid_archive");
    }
    files.push({path: file.path, bytes});
  }
  const content = {format: archive.format, version: archive.version, files: archive.files};
  if (await sha256(encoder.encode(JSON.stringify(content))) !== archive.checksum) {
    throw new BrowserRuntimeError("存档清单校验失败", "invalid_archive");
  }
  return validateSnapshot({format: SAVE_FORMAT, version: SAVE_VERSION, files});
}

export class IndexedDBStore {
  constructor(factory = globalThis.indexedDB) {
    this.factory = factory;
    this.database = null;
    this.revision = 0;
  }
  async open() {
    if (this.database) return;
    if (!this.factory) throw new BrowserRuntimeError("当前浏览器无法使用本地数据库，请使用普通窗口打开网站", "storage_unavailable");
    this.database = await new Promise((resolve, reject) => {
      const request = this.factory.open("oc-world-browser-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new BrowserRuntimeError("本地数据库打开失败", "storage_unavailable"));
      request.onblocked = () => reject(new BrowserRuntimeError("另一个旧页面阻止本地数据库更新，请关闭后重开", "storage_blocked"));
    });
    this.database.onversionchange = () => { this.database?.close(); this.database = null; };
  }
  async read() {
    await this.open();
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("snapshots", "readonly");
      const request = transaction.objectStore("snapshots").get("current");
      let value = null;
      request.onsuccess = () => { value = request.result || null; };
      transaction.oncomplete = () => {
        try {
          const snapshot = value ? validateSnapshot(value) : null;
          this.revision = Number.isSafeInteger(value?.storageRevision) ? value.storageRevision : 0;
          resolve(snapshot);
        }
        catch (error) { reject(error); }
      };
      transaction.onabort = transaction.onerror = () => reject(new BrowserRuntimeError("读取本地存档失败", "storage_failed"));
    });
  }
  async write(snapshot) {
    validateSnapshot(snapshot);
    await this.open();
    return new Promise((resolve, reject) => {
      const expectedRevision = this.revision;
      let nextRevision = expectedRevision;
      let conflict = null;
      const transaction = this.database.transaction("snapshots", "readwrite");
      const store = transaction.objectStore("snapshots");
      const current = store.get("current");
      current.onsuccess = () => {
        const actualRevision = Number.isSafeInteger(current.result?.storageRevision) ? current.result.storageRevision : 0;
        if (actualRevision !== expectedRevision) {
          conflict = new BrowserRuntimeError("另一个页面已更新本地存档，本页的过期状态没有覆盖它。请导出需要的备份后重新打开页面。", "storage_conflict");
          transaction.abort();
          return;
        }
        nextRevision = actualRevision + 1;
        store.put({...snapshot, savedAt: new Date().toISOString(), storageRevision: nextRevision}, "current");
      };
      transaction.oncomplete = () => { this.revision = nextRevision; resolve(); };
      transaction.onabort = transaction.onerror = () => reject(conflict || new BrowserRuntimeError(
        "本地存档未能保存，可能空间不足。请先导出备份，再继续操作。", "storage_failed"));
    });
  }
  close() { this.database?.close(); this.database = null; }
}

export class BrowserClient extends EventTarget {
  constructor(options = {}) {
    super();
    this.store = options.store || new IndexedDBStore();
    this.locks = options.locks || globalThis.navigator?.locks;
    this.workerFactory = options.workerFactory || (() => new Worker(new URL("./worker.js", import.meta.url)));
    this.engineUrl = options.engineUrl || new URL("./engine.zip", import.meta.url).href;
    this.manifestUrl = options.manifestUrl || new URL("./engine-manifest.json", import.meta.url).href;
    this.runtimeUrl = options.runtimeUrl || "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
    this.ready = false;
    this.busy = false;
    this.disposed = false;
    this.storageError = null;
    this.savedAt = null;
    this._channel = null;
    this._channels = new Set();
    this._saveQueue = Promise.resolve();
    this._settings = {};
    this._sequence = 0;
    this._releaseLock = null;
    this._disposePromise = null;
    this._beforeUnload = event => {
      if (this.busy) { event.preventDefault(); event.returnValue = ""; }
    };
    this._pageHide = () => this.dispose();
    this._pageShow = event => {
      if (event.persisted && this.disposed) globalThis.location?.reload();
    };
    globalThis.addEventListener?.("beforeunload", this._beforeUnload);
    globalThis.addEventListener?.("pagehide", this._pageHide);
    globalThis.addEventListener?.("pageshow", this._pageShow);
    for (const name of ["progress", "checkpoint", "busy", "error"]) {
      const callback = options[`on${name}`] || options[`on${name[0].toUpperCase()}${name.slice(1)}`];
      if (typeof callback === "function") this.addEventListener(name, event => callback(event.detail));
    }
  }
  _emit(name, detail) {
    const event = new Event(name);
    event.detail = detail;
    this.dispatchEvent(event);
  }
  _setBusy(value) { this.busy = value; this._emit("busy", {busy: value}); }
  _ensureOpen() {
    if (this.disposed) throw new BrowserRuntimeError("页面已关闭", "disposed");
  }
  _stopChannel(channel, error = new BrowserRuntimeError("页面已关闭", "disposed")) {
    if (!channel) return;
    channel.failed = true;
    channel.worker.terminate();
    for (const pending of channel.pending.values()) pending.reject(error);
    channel.pending.clear();
    this._channels.delete(channel);
  }
  _releaseAfterSaves(closeStore = false) {
    const releaseLock = this._releaseLock;
    const lockTask = this._lockTask;
    this._releaseLock = null;
    return this._saveQueue.catch(() => {}).then(async () => {
      try { if (closeStore) this.store.close?.(); }
      finally { releaseLock?.(); }
      if (releaseLock) await lockTask;
    });
  }
  async _acquireLock() {
    if (!this.locks?.request) throw new BrowserRuntimeError("此浏览器不支持安全的多页面存档锁，请使用新版 Chrome、Edge、Firefox 或 Safari", "locks_unavailable");
    await new Promise((resolve, reject) => {
      this._lockTask = this.locks.request(LOCK_NAME, {mode: "exclusive", ifAvailable: true}, async lock => {
        if (this.disposed) {
          reject(new BrowserRuntimeError("页面已关闭", "disposed"));
          return;
        }
        if (!lock) {
          reject(new BrowserRuntimeError("这个浏览器已有一个故事页面在使用存档，请关闭那个页面后重试", "library_busy"));
          return;
        }
        await new Promise(release => { this._releaseLock = release; resolve(); });
      });
      this._lockTask.catch(reject);
    });
  }
  _spawn(persist = false) {
    this._ensureOpen();
    const channel = {worker: this.workerFactory(), pending: new Map(), snapshot: null, persist, failed: false};
    this._channels.add(channel);
    channel.worker.onmessage = event => this._receive(channel, event.data);
    channel.worker.onerror = () => {
      const error = new BrowserRuntimeError("故事引擎运行中断；已落盘存档仍保留，请重新打开页面", "worker_failed");
      this._stopChannel(channel, error);
      if (channel === this._channel) {
        this.ready = false;
        // Keep the lock through already queued writes so a newly opened page cannot
        // load an older revision and then be overwritten by this failed worker.
        this._releaseAfterSaves(true);
      }
      this._emit("error", error);
    };
    return channel;
  }
  _queueSnapshot(snapshot) {
    this._ensureOpen();
    validateSnapshot(snapshot);
    this._saveQueue = this._saveQueue.then(async () => {
      if (this.storageError) throw this.storageError;
      await this.store.write(snapshot);
      this.savedAt = new Date().toISOString();
      this._emit("checkpoint", {saved: true, savedAt: this.savedAt, files: snapshot.files.length});
    }).catch(error => {
      this.storageError = error instanceof BrowserRuntimeError ? error : new BrowserRuntimeError("本地存档保存失败，请导出备份后重开页面", "storage_failed");
      this._emit("checkpoint", {saved: false, error: this.storageError.message});
      this._emit("error", this.storageError);
    });
    return this._saveQueue;
  }
  async _receive(channel, message) {
    if (this.disposed || channel.failed) return;
    if (message.type === "progress") { this._emit("progress", message); return; }
    if (message.type === "checkpoint") {
      try {
        channel.snapshot = validateSnapshot(message.snapshot);
        if (channel.persist) this._queueSnapshot(channel.snapshot);
      } catch (error) { this.storageError = error; this._emit("error", error); }
      return;
    }
    const pending = channel.pending.get(message.id);
    if (!pending) return;
    if (channel.persist) await this._saveQueue;
    // Keep the waiter registered through the save barrier so dispose can reject it.
    if (this.disposed || channel.failed || !channel.pending.has(message.id)) return;
    channel.pending.delete(message.id);
    if (this.storageError && channel.persist) { pending.reject(this.storageError); return; }
    if (!message.ok) {
      pending.reject(new BrowserRuntimeError(message.error || "故事引擎操作失败", message.code || "worker_error"));
    } else pending.resolve(message.value);
  }
  _send(channel, type, fields = {}) {
    if (this.disposed) return Promise.reject(new BrowserRuntimeError("页面已关闭", "disposed"));
    if (channel.failed) return Promise.reject(new BrowserRuntimeError("故事引擎已中断，请重新打开页面", "worker_failed"));
    const id = ++this._sequence;
    return new Promise((resolve, reject) => {
      channel.pending.set(id, {resolve, reject});
      try { channel.worker.postMessage({id, type, ...fields}); }
      catch (error) { channel.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    if (this.ready) return this;
    if (this.busy || this.disposed) throw new BrowserRuntimeError("故事引擎正在启动或页面已关闭", "library_busy");
    this._setBusy(true);
    try {
      await this._acquireLock();
      this._ensureOpen();
      this._emit("progress", {phase: "storage", message: "读取这台设备上的存档…"});
      const snapshot = await this.store.read();
      this._ensureOpen();
      this._channel = this._spawn(false);
      await this._send(this._channel, "initialize", {snapshot, engineUrl: this.engineUrl, manifestUrl: this.manifestUrl, runtimeUrl: this.runtimeUrl});
      this._ensureOpen();
      if (!this._channel.snapshot) throw new BrowserRuntimeError("引擎未返回可保存状态", "worker_error");
      await this._queueSnapshot(this._channel.snapshot);
      this._ensureOpen();
      if (this.storageError) throw this.storageError;
      this._channel.persist = true;
      this.ready = true;
      // Persistence is a best-effort request; browsers may decline it.
      globalThis.navigator?.storage?.persist?.().catch(() => {});
      return this;
    } catch (error) {
      this._stopChannel(this._channel, error);
      this._channel = null;
      if (!this.disposed) await this._releaseAfterSaves(true);
      else { await this._disposePromise; this.store.close?.(); }
      throw error;
    } finally { this._setBusy(false); }
  }
  async request(method, path, body = undefined) {
    if (!this.ready || this.disposed) throw new BrowserRuntimeError("故事引擎尚未就绪", "not_ready");
    if (this.busy) throw new BrowserRuntimeError("当前操作正在进行，请等完成后再操作", "library_busy");
    if (this.storageError) throw this.storageError;
    this._setBusy(true);
    try {
      const result = await this._send(this._channel, "dispatch", {method, path, body});
      if (result?.http_status >= 400 || result?.error) {
        throw new BrowserRuntimeError(result.error || "操作失败", result.code || "api_error", result.http_status || 400);
      }
      return result;
    } finally { this._setBusy(false); }
  }
  call(method, path, body) { return this.request(method, path, body); }
  async setSettings(settings) {
    const result = await this.request("POST", "/api/settings", settings);
    this._settings = {...this._settings, ...settings};
    return result;
  }
  getSettings() { return this.request("GET", "/api/settings"); }
  async exportArchive() {
    if ((!this.ready && !this._channel?.snapshot) || this.busy) throw new BrowserRuntimeError("请等当前操作完成后再导出存档", "library_busy");
    await this._saveQueue;
    // Export the in-memory snapshot even if the disk is full, so recovery remains possible.
    const snapshot = this._channel.snapshot || await this.store.read();
    if (!snapshot) throw new BrowserRuntimeError("当前没有可导出的存档", "missing_save");
    return new Blob([await encodeArchive(snapshot)], {type: "application/json"});
  }
  async importArchive(file) {
    if (!this.ready || this.busy) throw new BrowserRuntimeError("请等当前操作完成后再导入存档", "library_busy");
    if (this.storageError) throw this.storageError;
    this._setBusy(true);
    let candidate;
    try {
      const snapshot = await decodeArchive(file);
      this._ensureOpen();
      candidate = this._spawn(false);
      await this._send(candidate, "initialize", {snapshot, engineUrl: this.engineUrl, manifestUrl: this.manifestUrl, runtimeUrl: this.runtimeUrl});
      this._ensureOpen();
      if (Object.keys(this._settings).length) {
        const result = await this._send(candidate, "dispatch", {method: "POST", path: "/api/settings", body: this._settings});
        if (result?.error) throw new BrowserRuntimeError(result.error, result.code || "api_error");
      }
      if (!candidate.snapshot) throw new BrowserRuntimeError("导入后的存档无法读取", "invalid_archive");
      this._ensureOpen();
      const importingWrite = this._saveQueue.then(() => this.store.write(candidate.snapshot));
      // Include the atomic import transaction in the lifetime lock's drain barrier.
      this._saveQueue = importingWrite.catch(() => {});
      await importingWrite;
      this._ensureOpen();
      this._stopChannel(this._channel);
      this._channel = candidate;
      candidate.persist = true;
      this.savedAt = new Date().toISOString();
      this._emit("checkpoint", {saved: true, savedAt: this.savedAt, imported: true});
      return {ok: true, files: candidate.snapshot.files.length};
    } catch (error) { this._stopChannel(candidate, error); throw error; }
    finally { this._setBusy(false); }
  }
  dispose() {
    if (this.disposed) return this._disposePromise || Promise.resolve();
    this.disposed = true;
    this.ready = false;
    for (const channel of this._channels) this._stopChannel(channel);
    this._disposePromise = this._releaseAfterSaves(true);
    this._settings = {};
    globalThis.removeEventListener?.("beforeunload", this._beforeUnload);
    globalThis.removeEventListener?.("pagehide", this._pageHide);
    // Keep pageshow until document disposal so a back/forward-cache restore reloads
    // the terminated worker rather than silently using an obsolete in-memory archive.
    return this._disposePromise;
  }
}
