'use strict';
const $ = (id) => document.getElementById(id);
let worlds = [];
let draft = null;
let savedWorldId = null;
let refreshTimer = null;
let editingWorld = null;
const api = async (path, body) => {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); } catch (_) { data = {error: '服务返回了无法读取的内容'}; }
  if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
};
const node = (tag, cls, value) => { const e = document.createElement(tag); if (cls) e.className = cls; if (value != null) e.textContent = value; return e; };
function say(message, error = false) { const n = $('notice'); n.hidden = !message; n.className = 'notice' + (error ? ' error' : ''); n.textContent = message || ''; if (message) n.scrollIntoView({behavior:'smooth', block:'nearest'}); }
function readStory(id) { location.href = './read.html?story=' + encodeURIComponent(id); }
function showCreate(show = true) { $('create-panel').hidden = !show; if (show) $('create-panel').scrollIntoView({behavior:'smooth'}); }
function showImport(show = true) { $('import-panel').hidden = !show; if (show) $('import-panel').scrollIntoView({behavior:'smooth'}); }
function card(item) {
  const box = node('article', 'story-card');
  const left = node('div');
  left.append(node('div', 'meta', (item.legacy ? (item.working_copy ? '旧档工作副本 · ' : '旧档首次打开将制作副本 · ') : '') + (item.mode === 'fake' ? '模拟 · ' : '') + (item.world_title || '未知世界')));
  left.append(node('h3', null, item.title));
  left.append(node('p', null, '本地存档 · ' + (item.in_progress ? '正在完成已发出的这一步；结束后列表会刷新' : item.status === 'ended' ? '已结束，可阅读' : item.available ? '可继续' : '存档暂不可读')));
  if (item.if_condition) left.append(node('p', 'if', 'IF · ' + item.if_condition));
  box.append(left);
  const actions = node('div', 'story-actions');
  const add = (label, cls, action) => { const b = node('button', cls, label); b.type='button'; b.addEventListener('click', action); actions.append(b); };
  if (item.removed) {
    add('恢复', 'enter', async () => { try { await api('/api/library/restore', {story_id:item.id}); await loadStories(); say('已恢复《' + item.title + '》。'); } catch(e) {say(e.message,true);} });
  } else {
    add('阅读', 'enter', () => readStory(item.id));
    add('改名', '', async () => { const title = prompt('给这份故事改名：',item.title); if (title === null) return; try { await api('/api/library/rename',{story_id:item.id,title:title}); await loadStories(); } catch(e) {say(e.message,true);} });
    add('移除', 'danger', async () => { if (!confirm('将《'+item.title+'》移入最近移除？\n存档和世界设定会保留，可以恢复。')) return; try {await api('/api/library/remove',{story_id:item.id}); await loadStories(); say('已移入最近移除，可在页面下方恢复。');} catch(e){say(e.message,true);} });
  }
  box.append(actions); return box;
}
async function loadStories() {
  const data = await api('/api/library/stories');
  const active = data.stories.filter(s => !s.removed), removed = data.stories.filter(s => s.removed);
  $('stories').replaceChildren(...(active.length ? active.map(card) : [node('div','empty','还没有故事。点“创建故事”开始一份新记录。')]));
  $('removed').replaceChildren(...removed.map(card)); $('removed-section').hidden = !removed.length;
  $('count').textContent = active.length + ' 份故事';
  clearTimeout(refreshTimer);
  if (active.some(s => s.in_progress)) refreshTimer = setTimeout(() => loadStories().catch(e => say(e.message,true)), 1500);
}
async function loadWorlds() {
  worlds = (await api('/api/library/worlds')).worlds;
  const select = $('world-select'); select.replaceChildren();
  worlds.forEach(w => { const option = node('option',null,w.title + (w.kind === 'preset' ? ' · 内置预设' : ' · 已导入')); option.value=w.id; select.append(option); });
  if (!$('story-title').value && worlds.length) $('story-title').value = worlds[0].title + ' · 新故事';
  $('edit-world').hidden = select.value === 'browser-sample';
}
async function create(worldId, title, button) {
  button.disabled = true;
  try { const result = await api('/api/library/story',{world_id:worldId,title:title}); readStory(result.id); }
  catch(e) { say('创建失败：'+e.message,true); button.disabled=false; }
}
function evidenceBlock(title, value) { const e=node('article'); e.append(node('strong',null,title)); e.append(node('div',null,Array.isArray(value)&&value.length?value.join('\n'):'暂无记录')); return e; }
function renderPreview(result) {
  draft = result; savedWorldId = null;
  $('preview').hidden = false;
  $('preview-files').textContent = '读取：'+result.files.map(f => f.name+'（'+f.encoding+'）').join('、') + (result.skipped.length?'；未读取：'+result.skipped.join('、'):'') + '。整理方式：'+(result.method==='structured'?'结构化包校验':'DeepSeek 整理');
  const ev=result.evidence||{}; $('evidence').replaceChildren(evidenceBlock('整理出的明确项（请核对）',ev.confirmed),evidenceBlock('尚缺信息',ev.unknown),evidenceBlock('互相矛盾',ev.conflicts),evidenceBlock('运行默认值',ev.defaults));
  const s=result.scenario;
  $('source-links').replaceChildren(...(s.sources||[]).map(link=>node('div',null,
    (link.field||'未标字段')+' ← '+(link.doc||'未标文件')+'：'+(link.note||''))));
  $('preview-title').value=s.title||''; $('preview-summary').value=s.summary||''; $('preview-description').value=(s.world||{}).description||'';
  $('import-story-title').value=(s.title||'导入世界')+' · 新故事';
  const fields=(id,items,title)=>{const parent=$(id); parent.replaceChildren(node('h3',null,title)); items.forEach(item=>{const label=node('label',null,item.name+'（'+item.id+'）的描述'); const text=node('textarea'); text.rows=2; text.value=item.description||''; text.dataset.itemId=item.id; label.append(text); parent.append(label);});};
  fields('preview-people',s.characters,'人物'); fields('preview-places',s.locations,'地点');
  $('preview').scrollIntoView({behavior:'smooth'});
}
function renderEditFields(parentId, items, title) {
  const parent=$(parentId); parent.replaceChildren(node('h3',null,title));
  items.forEach(item=>{const label=node('label',null,item.name+'（'+item.id+'）的描述'); const t=node('textarea');t.rows=2;t.dataset.itemId=item.id;t.value=item.description||'';label.append(t);parent.append(label);});
}
async function openWorldEdit() {
  try {
    const id=$('world-select').value;
    editingWorld=await api('/api/library/world?world_id='+encodeURIComponent(id));
    if(!editingWorld.editable) throw new Error('内置预设不可直接修改');
    const s=editingWorld.scenario;
    $('edit-title').value=s.title;$('edit-summary').value=s.summary;$('edit-description').value=s.world.description;
    renderEditFields('edit-people',s.characters,'人物');renderEditFields('edit-places',s.locations,'地点');
    $('world-edit-panel').hidden=false;$('world-edit-panel').scrollIntoView({behavior:'smooth'});
  } catch(e) {say('无法打开世界编辑：'+e.message,true);}
}
async function saveWorldEdit() {
  if(!editingWorld)return;
  const button=$('save-world-edit');button.disabled=true;
  const edits={title:$('edit-title').value,summary:$('edit-summary').value,world_description:$('edit-description').value,characters:{},locations:{}};
  for(const [key,id] of [['characters','edit-people'],['locations','edit-places']]) $(id).querySelectorAll('textarea').forEach(t=>edits[key][t.dataset.itemId]=t.value);
  try {await api('/api/library/update-world',{world_id:editingWorld.id,expected_version:editingWorld.scenario.version,edits:edits});
    await loadWorlds();$('world-select').value=editingWorld.id;$('edit-world').hidden=false;
    $('world-edit-panel').hidden=true;editingWorld=null;say('世界新版本已保存；已有故事的设定和正文保持原样。');
  } catch(e) {say('修改失败：'+e.message,true);} finally {button.disabled=false;}
}
function fileBase64(file) { return file.arrayBuffer().then(buffer=>{const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=8192){binary+=String.fromCharCode(...bytes.subarray(i,i+8192));}return btoa(binary);}); }
async function analyze() {
  const file=$('import-file').files[0]; if(!file) {say('请先选择资料文件。',true);return;}
  draft=null; savedWorldId=null; $('preview').hidden=true;
  if(file.size>1024*1024){say('文件超过 1 MB，请拆分资料。',true);return;}
  const button=$('analyze'); button.disabled=true; $('import-status').textContent='正在读取并整理；自由文档会请求 DeepSeek，请保持页面打开…';
  try {const data=await api('/api/library/analyze',{filename:file.name,data_base64:await fileBase64(file)});renderPreview(data);$('import-status').textContent='预览已完成。请检查设定、来源区分与初始位置，再确认保存。';say('整理完成；世界尚未保存。');}
  catch(e){$('import-status').textContent='整理失败：'+e.message+'。原文件仍可重新分析，未创建世界或故事。';say($('import-status').textContent,true);}
  finally{button.disabled=false;}
}
async function saveImport() {
  if(!draft) return;
  const button=$('save-import'); button.disabled=true;
  try {
    if (!savedWorldId) {
      const edits={title:$('preview-title').value,summary:$('preview-summary').value,world_description:$('preview-description').value,characters:{},locations:{}};
      for(const [key,id] of [['characters','preview-people'],['locations','preview-places']]) $(id).querySelectorAll('textarea').forEach(t=>edits[key][t.dataset.itemId]=t.value);
      const saved=await api('/api/library/save-world',{draft_id:draft.draft_id,edits:edits}); savedWorldId=saved.world_id;
      await loadWorlds();
    }
    await create(savedWorldId,$('import-story-title').value,button);
  } catch(e) {say('保存失败：'+e.message,true);button.disabled=false;}
}
async function boot() {
  $('open-create').onclick=()=>showCreate(true); $('close-create').onclick=()=>showCreate(false);
  $('open-import').onclick=()=>showImport(true); $('close-import').onclick=()=>showImport(false);
  $('create-story').onclick=()=>create($('world-select').value,$('story-title').value,$('create-story'));
  $('analyze').onclick=analyze; $('save-import').onclick=saveImport;
  $('import-file').onchange=()=>{draft=null;savedWorldId=null;$('preview').hidden=true;$('import-status').textContent='文件已选择，点击“分析资料”后再预览。';};
  $('refresh-stories').onclick=()=>loadStories().catch(e=>say(e.message,true));
  $('world-select').onchange=()=>{$('edit-world').hidden=$('world-select').value==='browser-sample';};
  $('edit-world').onclick=openWorldEdit;$('close-world-edit').onclick=()=>{$('world-edit-panel').hidden=true;};
  $('save-world-edit').onclick=saveWorldEdit;
  try {const health=await api('/api/health'); $('mode').textContent=health.provider.mode==='fake'?'模拟模式':'DeepSeek 真实模式';await loadWorlds();await loadStories();}
  catch(e){say('无法载入故事目录：'+e.message,true);}
}
boot();
