'use strict';
const $ = id => document.getElementById(id);
const element = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const api = async (path, body) => {
  const response = await fetch(path, body === undefined ? undefined : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  let result;
  try { result = await response.json(); } catch (_) { throw new Error('返回内容无法读取，请保留材料后重试。'); }
  if (!response.ok) throw new Error(result.error || '操作未完成');
  return result;
};
let state = {materials:'', messages:[], scenario:null, evidence:{}};
let busy = false;
let saveTimer;
let pendingSaves = 0;
let saveQueue = Promise.resolve();
let savedWorld = null;
let savedScenario = '';
let jsonDirty = false;
let demoMode = false;

function note(text, error=false) {
  $('wb-status').hidden = !text;
  $('wb-status').className = 'notice' + (error ? ' error' : '');
  $('wb-status').textContent = text || '';
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('.workbench-shell button, .workbench-shell textarea, .workbench-shell input').forEach(n => { n.disabled = value; });
}
function workspace() {
  return {materials:$('wb-materials').value, messages:state.messages,
    scenario:state.scenario, evidence:state.evidence || {}};
}
function saveWorkspace() {
  clearTimeout(saveTimer);
  saveTimer = null;
  state.materials = $('wb-materials').value;
  const snapshot = JSON.parse(JSON.stringify(workspace()));
  pendingSaves++;
  $('wb-save-note').textContent = '正在保存讨论与设定…';
  saveQueue = saveQueue.catch(() => {}).then(() => api('/api/library/workbench', snapshot)).then(() => {
    $('wb-save-note').textContent = '讨论与设定已保存到此设备';
  }).catch(error => {
    $('wb-save-note').textContent = '保存未完成，请保留页面或下载讨论记录';
    throw error;
  }).finally(() => { pendingSaves--; });
  return saveQueue;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveWorkspace().catch(error => note('保存失败：' + error.message, true)), 700);
}
function renderMessages() {
  const log = $('wb-messages');
  log.replaceChildren();
  if (!state.messages.length) {
    log.append(element('p', 'discussion-empty', '可以从一个人、一种关系或一件事开始。讨论过程中，随时补充或改变想法。'));
    return;
  }
  for (const message of state.messages) {
    const box = element('article', 'discussion-message ' + message.role);
    box.append(element('span', 'message-author', message.role === 'user' ? '你' : demoMode ? 'AI · 模拟流程' : 'AI'));
    box.append(element('div', 'message-content', message.content));
    log.append(box);
  }
  log.scrollTop = log.scrollHeight;
}
const asText = item => typeof item === 'string' ? item : JSON.stringify(item, null, 2);
function evidenceBlock(title, items) {
  const n = element('article'); n.append(element('strong', '', title));
  n.append(element('div', '', Array.isArray(items) && items.length ? items.map(asText).join('\n') : '暂无需要处理的内容'));
  return n;
}
function field(parent, title, value, name, index, kind, rows=3) {
  const label = element('label', '', title), input = element('textarea');
  input.rows = rows; input.value = Array.isArray(value) ? value.join('\n') : value || '';
  input.dataset.kind = kind; input.dataset.index = index; input.dataset.field = name;
  label.append(input); parent.append(label);
}
function renderPreview(message='整理完成，可以修改设定或继续讨论。') {
  const pack = state.scenario;
  $('wb-preview').hidden = !pack; $('wb-empty').hidden = !!pack;
  if (!pack) return;
  jsonDirty = false;
  $('wb-preview-note').textContent = message;
  $('wb-title').value = pack.title || ''; $('wb-summary').value = pack.summary || '';
  $('wb-public').value = pack.world?.public_description || '';
  $('wb-description').value = pack.world?.description || '';
  const people = $('wb-people'); people.replaceChildren(element('h3', '', '人物 · ' + pack.characters.length));
  pack.characters.forEach((person, index) => {
    const card = element('details', 'setting-person');
    card.append(element('summary', '', person.name));
    field(card, '公开介绍', person.public_description, 'public_description', index, 'characters');
    field(card, '本人设定与经历', person.description, 'description', index, 'characters', 5);
    field(card, '目标（每行一项）', person.goals, 'goals', index, 'characters');
    field(card, '遇事可能怎么反应', person.situational_cues, 'situational_cues', index, 'characters');
    field(card, '称呼与代词', person.pronouns, 'pronouns', index, 'characters', 1);
    people.append(card);
  });
  const places = $('wb-places'); places.replaceChildren(element('h3', '', '地点 · ' + pack.locations.length));
  pack.locations.forEach((place, index) => {
    const card = element('details', 'setting-place'); card.append(element('summary', '', place.name));
    field(card, '公开介绍', place.public_description, 'public_description', index, 'locations');
    field(card, '后台设定', place.description, 'description', index, 'locations'); places.append(card);
  });
  const evidence = state.evidence || {};
  $('wb-evidence').replaceChildren(evidenceBlock('已提取的设定（请核对）', evidence.confirmed),
    evidenceBlock('尚未决定 / 缺漏 / 留白', evidence.unknown), evidenceBlock('需要澄清的矛盾', evidence.conflicts), evidenceBlock('AI 补充与运行默认值', evidence.defaults));
  $('wb-sources').replaceChildren(...(pack.sources || []).map(source => element('div', '',
    (source.field || '') + ' ← ' + (source.doc || '') + '：' + (source.note || ''))));
  $('wb-json').value = JSON.stringify(pack, null, 2);
}
function collectPreview() {
  if (!state.scenario) return;
  const pack = state.scenario;
  pack.title = $('wb-title').value; pack.summary = $('wb-summary').value;
  pack.world.description = $('wb-description').value; pack.world.public_description = $('wb-public').value;
  document.querySelectorAll('#wb-people textarea, #wb-places textarea').forEach(input => {
    const item = pack[input.dataset.kind][Number(input.dataset.index)];
    item[input.dataset.field] = input.dataset.field === 'goals' ? input.value.split('\n').map(s => s.trim()).filter(Boolean) : input.value;
  });
  if (!jsonDirty) $('wb-json').value = JSON.stringify(pack, null, 2);
}
function hasContent() { return $('wb-materials').value.trim() || state.messages.length || state.scenario; }
function payload() { return {materials:$('wb-materials').value, messages:state.messages, current_scenario:state.scenario}; }
async function sendMessage(event) {
  event.preventDefault(); if (busy) return;
  const content = $('wb-message').value.trim();
  if (!content && state.messages.at(-1)?.role !== 'user') { note('先写下想聊的内容。'); return; }
  collectPreview();
  if (content) { state.messages.push({role:'user', content}); $('wb-message').value = ''; }
  renderMessages(); setBusy(true); note('AI 正在看你的想法，请保持页面打开…');
  try {
    await saveWorkspace();
    const result = await api('/api/library/discuss-world', payload());
    if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('AI 没有返回讨论内容，已保留你的消息。');
    state.messages.push({role:'assistant', content:result.reply});
    renderMessages(); await saveWorkspace();
    if (state.scenario) $('wb-preview-note').textContent = '已有新的讨论。准备好后可重新整理，当前预览仍保留。';
    note('');
  } catch (error) {
    note('讨论未完成：' + error.message + '。你的消息已保留；可以再次点“发给 AI”重试。', true);
  } finally { setBusy(false); }
}
async function organize() {
  if (busy) return;
  if (!hasContent()) { note('先加入材料，或从一个想法开始讨论。'); $('wb-materials').focus(); return; }
  if (jsonDirty) { note('完整 JSON 有未应用的修改，请先应用并校验。', true); return; }
  collectPreview(); setBusy(true); note('正在整理当前材料与讨论，之前的结果会保留到新预览完成…');
  try {
    await saveWorkspace();
    const result = await api('/api/library/organize-world', {...payload(), fill_missing:$('wb-fill').checked});
    if (!result.scenario) throw new Error('未生成可预览的世界，原结果仍保留。');
    state.scenario = result.scenario; state.evidence = result.evidence || {};
    savedWorld = null; renderPreview(result.method === 'fake' ? '模拟整理：这是示例结果，用于检查流程，不代表 AI 理解了材料。' : '整理完成。请核对已确定内容、留白与 AI 补充。');
    await saveWorkspace(); note('预览已生成，还没有创建世界或故事。');
    $('setting-title').scrollIntoView({block:'start', behavior:'smooth'});
  } catch (error) { note('整理未完成：' + error.message + '。原材料与上次预览仍保留。', true); }
  finally { setBusy(false); }
}
async function checkedPreview() {
  if (!state.scenario) throw new Error('请先整理或载入一个世界。');
  if (jsonDirty) throw new Error('完整 JSON 有未应用的修改，请先应用并校验。');
  collectPreview();
  return api('/api/library/validate-world', {scenario:state.scenario, evidence:state.evidence,
    materials:$('wb-materials').value, messages:state.messages});
}
function download(name, text, mime='application/json') {
  const url = URL.createObjectURL(new Blob([text], {type:mime + ';charset=utf-8'}));
  const link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function filename(value) { return (value || '世界设定').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 70); }
async function downloadWorld() {
  if (busy) return; setBusy(true);
  try {
    const result = await checkedPreview();
    state.scenario = result.scenario; await saveWorkspace();
    download(filename(state.scenario.title) + '.json', JSON.stringify(state.scenario, null, 2));
    note('世界 JSON 已准备下载，可在“从资料导入世界”中使用。');
  } catch (error) { note('下载未完成：' + error.message, true); }
  finally { setBusy(false); }
}
async function saveWorld(createStory=false) {
  if (busy) return; setBusy(true);
  try {
    const result = await checkedPreview(), signature = JSON.stringify(result.scenario);
    if (!savedWorld || signature !== savedScenario) {
      const saved = await api('/api/library/save-world', {draft_id:result.draft_id, edits:{}});
      savedWorld = saved.world_id; savedScenario = signature;
    }
    await saveWorkspace();
    if (createStory) {
      const story = await api('/api/library/story', {world_id:savedWorld, title:state.scenario.title + ' · 新故事'});
      setBusy(false);
      location.href = './read.html?story=' + encodeURIComponent(story.id);
    } else { note('世界已保存。返回故事列表时可以选它创建故事。'); }
  } catch (error) { note('保存未完成：' + error.message, true); }
  finally { setBusy(false); }
}
async function applyJson() {
  if (busy) return; setBusy(true);
  try {
    const scenario = JSON.parse($('wb-json').value);
    const body = {scenario};
    if (!scenario || typeof scenario !== 'object' || !scenario.scenario) body.evidence = state.evidence;
    const result = await api('/api/library/validate-world', body);
    state.scenario = result.scenario; state.evidence = result.evidence || {}; savedWorld = null;
    renderPreview('JSON 已通过结构校验，内容仍请核对。'); await saveWorkspace(); note('修改已应用，没有调用模型。');
  } catch (error) { note('JSON 未应用：' + error.message + '。原有效设定仍保留。', true); }
  finally { setBusy(false); }
}
async function example() {
  if (busy) return;
  if (hasContent() && !confirm('载入示例会替换当前工作台内容。需要保留时，请先下载讨论记录和世界 JSON。')) return;
  setBusy(true);
  try {
    const worlds = (await api('/api/library/worlds')).worlds;
    const preset = worlds.find(world => world.kind === 'preset') || worlds[0];
    if (!preset) throw new Error('未找到示例世界。');
    const result = await api('/api/library/world?world_id=' + encodeURIComponent(preset.id));
    state = {materials:'示例世界：' + JSON.stringify(result.scenario, null, 2), messages:[], scenario:result.scenario,
      evidence:{confirmed:['这是现有内置世界，供查看编辑、下载和创建故事的流程。'], unknown:[], conflicts:[], defaults:[]}};
    $('wb-materials').value = state.materials; savedWorld = null;
    renderMessages(); renderPreview('内置示例。可以直接编辑或下载；没有调用模型。'); await saveWorkspace(); note('示例已载入。');
  } catch (error) { note('示例未载入：' + error.message, true); }
  finally { setBusy(false); }
}
function notesMarkdown() {
  collectPreview();
  let text = '# 设定讨论记录\n\n## 材料\n\n' + $('wb-materials').value + '\n\n## 讨论\n\n';
  for (const message of state.messages) text += '### ' + (message.role === 'user' ? '用户' : 'AI') + '\n\n' + message.content + '\n\n';
  if (state.scenario) text += '## 当前整理结果\n\n```json\n' + JSON.stringify(state.scenario, null, 2) + '\n```\n\n## 待处理与补充\n\n```json\n' + JSON.stringify(state.evidence || {}, null, 2) + '\n```\n';
  return text;
}
async function clearWorkspace() {
  if (busy || !confirm('清空当前材料、讨论与预览？已保存的世界和故事会保留。')) return;
  setBusy(true);
  const previous = JSON.parse(JSON.stringify(state));
  try {
    state = {materials:'', messages:[], scenario:null, evidence:{}}; $('wb-materials').value = '';
    await saveWorkspace(); $('wb-message').value = ''; savedWorld = null; renderMessages(); renderPreview(); note('工作台已清空。');
  } catch (error) { state = previous; $('wb-materials').value = state.materials; renderMessages(); renderPreview(); note('清空未完成：' + error.message, true); }
  finally { setBusy(false); }
}
async function boot() {
  setBusy(true);
  try {
    const health = await api('/api/health');
    demoMode = health.provider?.mode === 'fake' || health.provider?.name === 'fake';
    $('wb-mode').textContent = demoMode ? '模拟流程 · 无 API 调用' : '使用自己的 API';
    state = {...state, ...await api('/api/library/workbench')};
    $('wb-materials').value = state.materials || ''; renderMessages(); renderPreview('已恢复上次的设定稿。可以继续讨论和修改。');
  } catch (error) { note('工作台载入失败：' + error.message + '。可以刷新页面重试。', true); }
  finally { setBusy(false); }
  $('wb-chat-form').addEventListener('submit', sendMessage);
  $('wb-organize').onclick = organize; $('wb-example').onclick = example;
  $('wb-download').onclick = downloadWorld; $('wb-save').onclick = () => saveWorld(false); $('wb-create').onclick = () => saveWorld(true);
  $('wb-apply-json').onclick = applyJson; $('wb-clear').onclick = clearWorkspace;
  $('wb-guide').onclick = async () => { try { const guide = await api('/api/library/setting-guide'); download('设定讨论与JSON整理提示词.md', guide.markdown, 'text/markdown'); } catch (error) { note(error.message, true); } };
  $('wb-notes').onclick = () => download('设定讨论记录.md', notesMarkdown(), 'text/markdown');
  $('wb-materials').oninput = scheduleSave;
  $('wb-preview').addEventListener('input', event => {
    if (event.target.id === 'wb-json') { jsonDirty = true; return; }
    collectPreview(); savedWorld = null; scheduleSave();
  });
  $('wb-file').onchange = async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file || busy) return;
    try {
      if (file.size > 256 * 1024) throw new Error('单份材料超过 256 KB，请先精简或在外部 AI 整理成世界 JSON。');
      const text = new TextDecoder('utf-8', {fatal:true}).decode(await file.arrayBuffer());
      $('wb-materials').value += '\n\n## ' + file.name + '\n\n' + text;
      await saveWorkspace(); note('材料已加入，没有调用模型。');
    } catch (error) { note('材料未保存：' + error.message + '。可检查文件编码或减少材料量。', true); }
  };
  document.querySelector('.back-link').onclick = async event => {
    event.preventDefault(); if (busy) return;
    const href = event.currentTarget.href;
    if (jsonDirty) { note('完整 JSON 有未应用的修改，请先应用并校验。', true); return; }
    setBusy(true);
    try { collectPreview(); await saveWorkspace(); setBusy(false); location.href = href; }
    catch (error) { note('保存未完成：' + error.message, true); }
    finally { setBusy(false); }
  };
  window.addEventListener('beforeunload', event => {
    if (busy || saveTimer || pendingSaves || jsonDirty) { event.preventDefault(); event.returnValue = ''; }
  });
}
boot().catch(error => note(error.message, true));
