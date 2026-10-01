import { BrowserClient } from './runtime.js';

const SESSION_KEY = 'oc-world-api-session-v1';
const DEFAULT_SETTINGS = {mode:'deepseek', model:'deepseek-flash', base_url:'https://api.deepseek.com', api_key:''};
let publicSettings = {...DEFAULT_SETTINGS};
let client;
let savedBadge;
let isBusy = false;
const element = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function sessionSettings() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
    return {...publicSettings, ...value};
  } catch (_) { return {...publicSettings}; }
}

function createTools() {
  const button = element('button', 'local-tools-button', 'API 与存档');
  button.type = 'button';
  button.id = 'local-tools';
  savedBadge = element('span', 'local-saved-badge', '存档在此设备');
  const actions = document.querySelector('.head-actions') || document.querySelector('.top-actions');
  actions.append(savedBadge, button);
  const dialog = element('dialog', 'local-dialog');
  dialog.id = 'local-settings';
  dialog.innerHTML = `
    <div class="local-dialog-head"><h2>API 与本地存档</h2><button id="local-close" type="button" aria-label="关闭设置">关闭</button></div>
    <p>网页提供工具，故事保存在这台设备。生成内容使用你填写的 API，费用由对应账户承担；相关世界资料和人物上下文会直接发送给这个 API 服务。</p>
    <form id="local-settings-form">
      <label>生成方式<select id="local-mode"><option value="deepseek">DeepSeek · 使用自己的 API</option><option value="fake">模拟流程 · 不调用 API</option></select></label>
      <label>API Key<input id="local-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="填入自己的 API Key"></label>
      <label>模型<input id="local-model" autocomplete="off" value="deepseek-flash"></label>
      <details><summary>API 地址</summary><label>地址<input id="local-base-url" type="url" autocomplete="off" value="https://api.deepseek.com"></label><p>其他兼容服务需要允许浏览器直接访问，也可能不支持当前协议。</p></details>
      <p>密钥仅保留在当前标签页会话，方便在列表和阅读页之间切换；不会写入故事或导出的存档。保存设置不会调用模型。</p>
      <div class="local-dialog-actions"><button class="primary" id="local-save-settings" type="submit">保存设置</button><button id="local-forget-key" type="button">清除密钥</button></div>
    </form>
    <section class="local-backup-section"><h3>存档备份</h3><p>完整备份包含所有世界、人物记忆、故事正文和未读后续。换设备或清除网站数据后，可以从文件恢复。</p>
      <div class="local-dialog-actions"><button id="local-export" type="button">导出完整存档</button><button id="local-import" type="button">导入存档</button></div>
      <input id="local-import-file" type="file" accept=".json,.ocworld,application/json" hidden>
      <p>导入会替换此设备当前的故事库，请先导出备份。存档文件含幕后信息，阅读时按正文揭示。</p>
    </section>
    <p class="local-status" id="local-storage-status">存档自动保存在当前浏览器。</p>
    <div class="local-note" id="local-tools-note" role="status" hidden></div>`;
  document.body.append(dialog);
  const $ = (id) => document.getElementById(id);
  function note(text, error=false) {
    const target = $('local-tools-note');
    target.hidden = !text;
    target.className = 'local-note' + (error ? ' error' : '');
    target.textContent = text;
  }
  function populate() {
    const settings = sessionSettings();
    $('local-mode').value = settings.mode;
    $('local-api-key').value = settings.api_key;
    $('local-model').value = settings.model;
    $('local-base-url').value = settings.base_url;
    $('local-storage-status').textContent = client?.storageError
      ? '本地保存遇到问题，请保持页面打开并导出备份。'
      : '存档自动保存在当前浏览器。生成时请保持页面运行。';
  }
  button.addEventListener('click', () => { populate(); note(''); dialog.showModal(); });
  $('local-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  const controls = ['local-save-settings','local-forget-key','local-export','local-import'];
  function setControls(disabled) { controls.forEach(id => $(id).disabled = disabled); }
  window.addEventListener('oc-world-busy', () => setControls(isBusy));
  $('local-settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (isBusy) return;
    setControls(true);
    try {
      const settings = {mode:$('local-mode').value, model:$('local-model').value.trim(),
        base_url:$('local-base-url').value.trim(), api_key:$('local-api-key').value.trim()};
      await client.setSettings(settings);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(settings));
      note('设置已保存，正在重新打开本地故事库。');
      location.reload();
    } catch (error) { note(error.message, true); setControls(false); }
  });
  $('local-forget-key').addEventListener('click', async () => {
    if (isBusy) return;
    const settings = {...sessionSettings(), api_key:''};
    try {
      await client.setSettings(settings);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(settings));
      $('local-api-key').value = '';
      note('当前标签页的密钥已清除。已保存的故事仍然可以阅读。');
    } catch (error) { note(error.message, true); }
  });
  $('local-export').addEventListener('click', async () => {
    if (isBusy) return;
    setControls(true);
    try {
      const blob = await client.exportArchive();
      const url = URL.createObjectURL(blob);
      const link = element('a');
      link.href = url;
      link.download = 'oc-world-' + new Date().toISOString().slice(0,10) + '.ocworld.json';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      note('完整存档文件已准备下载。文件不包含 API 密钥。');
    } catch (error) { note(error.message, true); }
    finally { setControls(false); }
  });
  $('local-import').addEventListener('click', () => { if (!isBusy) $('local-import-file').click(); });
  $('local-import-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || isBusy) return;
    if (!confirm('导入《' + file.name + '》并替换此设备当前故事库？\n请先确认已经导出需要保留的故事。')) return;
    setControls(true);
    try {
      await client.importArchive(file);
      location.href = './index.html';
    } catch (error) { note('导入失败：' + error.message + '。原故事库仍保留。', true); setControls(false); }
  });
}

function localFetchBridge() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, options);
    const method = options.method || (input instanceof Request ? input.method : 'GET');
    let body;
    try {
      body = options.body ? JSON.parse(options.body) : undefined;
      const streamed = url.pathname === '/api/continue-stream';
      const route = (streamed ? '/api/continue' : url.pathname) + url.search;
      const value = await client.request(method, route, body);
      if (value?.api_key_required) document.getElementById('local-tools').click();
      return new Response(streamed ? JSON.stringify({type:'result', result:value}) + '\n' : JSON.stringify(value),
        {status:200, headers:{'Content-Type':streamed ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8'}});
    } catch (error) {
      if ((error.code || '').includes('config') || /API.*密钥|API Key|未配置.*密钥/.test(error.message)) {
        document.getElementById('local-tools').click();
      }
      return new Response(JSON.stringify({error:error.message, code:error.code || 'browser'}),
        {status:error.status >= 400 && error.status <= 599 ? error.status : 400,
          headers:{'Content-Type':'application/json; charset=utf-8'}});
    }
  };
}

export async function boot() {
  createTools();
  const overlay = element('div', 'local-loading');
  const card = element('div', 'local-loading-card');
  card.append(element('h2', '', '打开你的故事库'), element('p', '', '首次打开需要加载运行程序。故事保存在此设备；打开页面不会调用模型。'));
  const status = element('span', 'local-progress', '正在加载…');
  card.append(status); overlay.append(card); document.body.append(overlay);
  try {
    client = new BrowserClient({
      onprogress: message => {
        const text = typeof message === 'string' ? message : message.message || message.stage || '正在处理…';
        status.textContent = text;
        const writing = document.getElementById('writing-text');
        if (writing && isBusy) writing.textContent = text;
      },
      onbusy: value => {
        isBusy = typeof value === 'boolean' ? value : !!value.busy;
        window.dispatchEvent(new Event('oc-world-busy'));
      },
      oncheckpoint: info => { if (savedBadge) savedBadge.textContent = info?.error ? '请备份本地存档' : '已保存到此设备'; },
    });
    await client.initialize();
    const stored = await client.getSettings();
    publicSettings = {mode:stored.mode || DEFAULT_SETTINGS.mode,
      model:stored.model || DEFAULT_SETTINGS.model, base_url:stored.base_url || DEFAULT_SETTINGS.base_url, api_key:''};
    await client.setSettings(sessionSettings());
    window.ocWorldClient = client;
    localFetchBridge();
    overlay.remove();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    window.addEventListener('beforeunload', event => {
      if (!isBusy) return;
      event.preventDefault(); event.returnValue = '';
    });
  } catch (error) {
    status.textContent = error.message;
    const retry = element('button', '', '重新打开');
    retry.addEventListener('click', () => location.reload());
    card.append(element('p', '', '请使用允许保存网站数据的现代浏览器，并关闭其他正在使用这个故事库的标签页。'), retry);
    throw error;
  }
}
