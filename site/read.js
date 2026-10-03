'use strict';

/* 阅读页。
   布局约定：body 不滚动，只有 #stage 滚动；顶栏与底栏是 flex 里的固定段，
   所以正文再长也不会把它们顶出视口或被它们盖住。
   跟随策略：贴底时新内容自动跟到底；正在回看前文时不动位置，改用「有新内容 ↓」提示。 */

const $ = (id) => document.getElementById(id);
const selectedStoryId = new URLSearchParams(location.search).get('story');
let leaving = false;

let view = null;              // 最近一次 /api/reading 的结果
let busy = false;             // 有请求在飞（单次动作）
let running = false;          // 连续演绎进行中
let batchLeft = 0;            // 本批还剩几刻
let batchLimit = 12;          // 每批上限（来自运行包的 demo.max_batch_ticks）
let pendingRequestId = null;  // 推进失败时复用同一个 request_id 重试
let lastAccounting = null;    // 上次正文调用的用量
let lastAdvanceAccounting = null;
let lastTiming = null;        // 仅保存时长与调用数，不保存正文或上下文
let lastIfTiming = null;
let lastIfAccounting = null;
let ifExampleIndex = -1;      // 「看例子」按顺序轮换运行包里的 IF 示例

const BATCH_INTERVAL_MS = 2000;   // 每段正文显示完后等一会儿再走下一刻

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return 'read-' + window.crypto.randomUUID();
  }
  return 'read-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10);
}

async function api(path, options) {
  const bound = selectedStoryId && path.startsWith('/api/')
    ? path + (path.includes('?') ? '&' : '?') + 'story=' + encodeURIComponent(selectedStoryId)
    : path;
  const response = await fetch(bound, options);
  let payload = null;
  try { payload = await response.json(); } catch (err) { payload = { error: '响应不是 JSON' }; }
  if (!response.ok) {
    const error = new Error(payload.error || ('HTTP ' + response.status));
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

async function postContinueStream(body, onFrame) {
  const path = '/api/continue-stream' + (selectedStoryId
    ? '?story=' + encodeURIComponent(selectedStoryId) : '');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // During a normal service upgrade, the old server may still serve the new JS.
  // A 404 means it did not start this action, so the old route is safe to use.
  if (response.status === 404) return post('/api/continue', body);
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch (error) { payload = null; }
    throw new Error((payload && payload.error) || ('HTTP ' + response.status));
  }
  if (!(response.headers.get('Content-Type') || '').includes('application/x-ndjson')) {
    throw new Error('继续接口没有返回分段响应；请正常关闭旧服务并重新打开。');
  }
  let pending = '';
  let final = null;
  const consume = (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    if (frame.type === 'fatal') throw new Error(frame.error || '分段生成失败');
    onFrame(frame);
    if (frame.type === 'result') final = frame.result;
  };
  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) break;
    }
  } else {
    pending = await response.text();
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    lines.forEach(consume);
  }
  if (pending.trim()) consume(pending);
  if (!final) throw new Error('分段响应在完成前中断；世界状态请以刷新后的存档为准。');
  return final;
}

// ------------------------------------------------------------ 滚动与提示

const stage = () => $('stage');

function isNearBottom(slack) {
  const node = stage();
  const limit = (slack === undefined) ? 90 : slack;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= limit;
}

function toBottom(behavior) {
  const node = stage();
  node.scrollTo({ top: node.scrollHeight, behavior: behavior || 'auto' });
}

function showNewHint() { $('new-hint').hidden = false; }
function hideNewHint() { $('new-hint').hidden = true; }

// ------------------------------------------------------------ 通用渲染

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function notice(message, kind) {
  const node = $('notice');
  if (!message) { node.hidden = true; node.textContent = ''; return; }
  node.hidden = false;
  node.className = 'notice' + (kind ? ' ' + kind : '');
  node.textContent = message;
}

function setStatus(message) {
  $('status-line').textContent = message || '';
  $('status-line').title = message || '';
}

function accountingText(accounting) {
  if (!accounting || !accounting.logical_requests) return '';
  const parts = ['本次调用 ' + accounting.logical_requests + ' 次逻辑请求',
                 '实际尝试 ' + accounting.attempts + ' 次'];
  if (accounting.tokens && accounting.tokens.total !== null
      && accounting.tokens.total !== undefined) {
    parts.push('token 用量 ' + accounting.tokens.total);
  } else if (accounting.mode === 'deepseek') {
    parts.push('服务端未返回 token 用量');
  } else {
    parts.push('模拟模式不产生 token 用量');
  }
  return parts.join(' · ');
}

function continueAccountingText(result) {
  const world = result.advance_accounting;
  const prose = result.accounting;
  if (!world || !world.logical_requests) return accountingText(prose);
  const count = world.logical_requests + ((prose && prose.logical_requests) || 0);
  return '本刻调用 ' + count + ' 次（世界与人物 ' + world.logical_requests
    + '、正文 ' + ((prose && prose.logical_requests) || 0) + '）';
}

function modeNote(data) {
  const info = data.provider || {};
  if (data.mode === 'deepseek') {
    const sampling = info.sampling || {};
    const thinking = sampling.thinking === 'disabled' ? '思考关闭' : '思考开启';
    const effort = sampling.reasoning_effort ? ('，强度 ' + sampling.reasoning_effort) : '';
    return '真实模式：正文与角色决策都调用 DeepSeek 官方 API（' + (info.model || '模型未知')
      + '），按实际用量计费；' + thinking + effort + '；单次调用只发一次请求，不自动重发。';
  }
  return '模拟模式：不调用真实模型、不联网、不产生费用。'
    + '正文只用来检查阅读节奏与段落衔接。';
}

function renderMode(data) {
  const info = data.provider || {};
  const badge = $('mode-badge');
  if (data.mode === 'deepseek') {
    badge.textContent = '真实 · ' + (info.model || '未知模型');
    badge.className = 'badge real';
    badge.title = '真实模式：调用官方 API 会计费';
  } else {
    badge.textContent = '模拟';
    badge.className = 'badge fake';
    badge.title = '模拟模式：不调用真实模型、不产生费用';
  }
  $('menu-mode-note').textContent = modeNote(data);
}

function renderBanner(data) {
  // 模拟标注（或真实模式下的说明）统一展示一次，不写进段落正文里。
  // 兜底：后端是旧版本、没返回 prose_banner 时，仍要把「这是模拟文本」标出来，
  // 免得刷新页面后标注整个消失（换服务版本的空档期）。
  const banner = $('prose-banner');
  const text = data.prose_banner
    || (data.mode === 'fake' ? '本页正文是模拟文本（占位文字），不是模型写出来的。' : '');
  if (text) {
    banner.hidden = false;
    banner.textContent = text;
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }
}

// 世界标题块。以后接「世界／故事列表」时，列表项复用这里的字段
// （title / summary / characters），点进去再调 renderIntro 即可。
function renderIntro(data) {
  $('world-title').textContent = data.world.title || '（未命名世界）';
  $('story-name').textContent = data.story_title || '';
  $('world-title').title = data.world.title || '';
  $('world-summary').textContent = data.world.summary || '';
  $('world-description').textContent = data.world.description || '';

  const cast = $('cast');
  cast.innerHTML = '';
  (data.characters || []).forEach((ch) => {
    const box = el('div', 'person');
    box.appendChild(el('strong', null, ch.name));
    box.appendChild(el('span', null, ch.description));
    if (data.engine_mode !== 'chapters') {
      box.appendChild(el('span', null, '现在在：' + (ch.location_name || '—')
        + (ch.status_text ? ' · ' + ch.status_text : '')));
    }
    cast.appendChild(box);
  });

  const places = $('places');
  places.innerHTML = '';
  (data.places || []).forEach((loc) => {
    const box = el('div', 'person');
    box.appendChild(el('strong', null, loc.name));
    box.appendChild(el('span', null, loc.state_description || loc.description));
    places.appendChild(box);
  });

  // 本次条件（原文）也放进抽屉，方便随时回看
  const ifBox = $('drawer-if');
  if (data.run && data.run.if_condition) {
    ifBox.hidden = false;
    ifBox.textContent = '本次条件：' + data.run.if_condition;
  } else {
    ifBox.hidden = true;
    ifBox.textContent = '';
  }

  $('material-note').textContent = data.engine_mode === 'chapters'
    ? '正文按适中文笔展开。资料面板只展示公开设定和正文已出现的地点。可在章节停顿处继续，或投入新事件。'
    : '世界与人物来自当前故事资料；已保存正文按原来的阅读单位保留。';
  $('dev-link').hidden = data.engine_mode === 'chapters';
}

// 开演页：只在「有 IF 说明、且本次条件还没写」时出现；载入信息全部来自 /api/reading。
function renderOpening(data) {
  const options = data.if_options || {};
  const supported = options.supported || [];
  const started = !!(data.run && data.run.if_condition);
  const ended = !!(data.run && data.run.status === 'ended');
  const box = $('opening');
  const show = supported.length > 0 && !started && !ended;
  box.hidden = !show;
  if (!show) return;

  const pack = data.pack || {};
  $('opening-title').textContent = pack.title || data.world.title || '';
  $('opening-summary').textContent = pack.summary || data.world.summary || '';
  $('opening-world').textContent = pack.world_description || data.world.description || '';
  const docs = pack.source_docs || [];
  $('opening-sources').textContent = docs.length
    ? '资料已载入：' + pack.source_entries + ' 条来源关联，来自 ' + docs.join('、')
    : pack.source_entries ? '资料已载入：' + pack.source_entries + ' 条来源关联。' : '这个运行包没有来源关联。';

  const cast = $('opening-cast');
  cast.innerHTML = '';
  (data.characters || []).forEach((ch) => {
    const node = el('div', 'person');
    node.appendChild(el('strong', null, ch.name));
    node.appendChild(el('span', null, ch.description));
    cast.appendChild(node);
  });
  const places = $('opening-places');
  places.innerHTML = '';
  (data.places || []).forEach((loc) => places.appendChild(el('span', null, loc.name)));

  const lines = [];
  lines.push('可以做成的条件：');
  supported.forEach((item) => lines.push('· ' + item));
  const unsupported = options.unsupported || [];
  if (unsupported.length) {
    lines.push('');
    lines.push('这次做不到（写了会告诉你原因，不会偷偷换一个）：');
    unsupported.forEach((item) => lines.push('· ' + item));
  }
  $('if-help').textContent = lines.join('\n');
  $('if-note').textContent = '';
}

function renderIfLine(data) {
  const line = $('if-line');
  const text = data.run && data.run.if_condition;
  if (!text) { line.hidden = true; line.textContent = ''; return; }
  line.hidden = false;
  const kindLabel = {
    environment: '环境与现场', rumor: '一句说法', observed: '亲眼所见',
    position: '开局位置', resource: '开局物品',
  }[data.run.if_kind] || '';
  line.textContent = '本次条件（' + (kindLabel || '条件') + '，来源：'
    + (data.run.if_source || '未知') + '）：' + text;
}

function placeNamesFor(tick) {
  const map = (view && view.tick_places) || {};
  return (map[tick] || map[String(tick)] || []).join(' · ');
}

function buildBeat(tick, segment) {
  const beat = el('div', 'beat');
  beat.appendChild(el('span', 'tick', segment && segment.chapter_number
    ? (segment.chapter_title || '第 ' + segment.chapter_number + ' 章') : '第 ' + tick + ' 刻'));
  const places = placeNamesFor(tick);
  if (places) beat.appendChild(el('span', 'places', places));
  return beat;
}

function buildProse(segment, animate) {
  const wrap = el('div', 'prose' + (animate ? ' appear' : ''));
  const blocks = String(segment.prose || '').split(/\n+/).filter((line) => line.trim());
  blocks.forEach((block) => wrap.appendChild(el('p', null, block.trim())));
  return wrap;
}

function buildStalled(tick, message) {
  const box = el('div', 'stalled');
  box.appendChild(el('strong', null, '第 ' + tick + ' 刻的正文还没有写出来'));
  box.appendChild(el('span', 'why', message || '（没有更多信息）'));
  const row = el('div', 'row');
  const button = el('button', 'ghost', '补写这一段');
  button.type = 'button';
  button.addEventListener('click', () => fillTicks([tick], '正在补写'));
  row.appendChild(button);
  box.appendChild(row);
  return box;
}

function renderStory(data, animateFromTick) {
  const story = $('story');
  story.innerHTML = '';

  const segments = data.segments || [];
  const byTick = {};
  segments.forEach((seg) => { byTick[seg.tick] = seg; });

  const items = [];
  segments.forEach((seg) => items.push({ tick: seg.tick, segment: seg }));
  (data.missing_ticks || []).forEach((tick) => {
    if (!byTick[tick]) items.push({ tick: tick, segment: null });
  });
  items.sort((a, b) => a.tick - b.tick);

  // 开演页在的时候不显示「还没有正文」的空状态：那时底部还没有「继续」
  $('empty').hidden = items.length > 0 || !$('opening').hidden;
  const animate = typeof animateFromTick === 'number' ? animateFromTick : null;

  items.forEach((item) => {
    story.appendChild(buildBeat(item.tick, item.segment));
    const segment = item.segment;
    if (segment && segment.status === 'committed' && segment.has_prose) {
      story.appendChild(buildProse(segment, animate !== null && item.tick >= animate));
      return;
    }
    const message = segment && segment.error ? segment.error
      : '正文生成还没有成功（世界状态已经保存，重试只会补这一段，不会重复推进）。';
    story.appendChild(buildStalled(item.tick, message));
  });
}

function renderActions(data) {
  const missing = (data.missing_ticks || []).length;
  const fill = $('menu-fill');
  fill.hidden = missing === 0;
  fill.textContent = '补写缺失的段落（' + missing + '）';

  const failed = (data.failed_segments || []).length;
  if (data.run && data.run.status === 'error' && data.run.last_error) {
    notice('上一次推进失败：' + data.run.last_error
      + '\n世界状态没有被改动（失败的那一步没有提交）。可以点「重试这一步」。', 'bad');
    $('btn-retry').hidden = false;
  } else if (failed && missing) {
    notice('有 ' + missing + ' 段正文尚未生成；点「继续」会先补最早的那一段，不会重复推进世界。', 'warn');
    $('btn-retry').hidden = true;
  } else {
    notice('');
    $('btn-retry').hidden = true;
  }

  const pending = data.pending_external || [];
  if (pending.length) {
    setStatus('已排入 ' + pending.length + ' 件外部事件，下一步开始时会生效。');
  }
}

// 正文详略选择器：默认「正常」；切换只写一次设置，零模型调用。
function renderProseStyle(data) {
  const options = data.prose_styles || [];
  const box = $('style-pick');
  box.hidden = options.length === 0;
  if (!options.length) return;
  const current = (data.run && data.run.prose_style) || 'normal';
  options.forEach((option) => {
    const chip = $('style-' + option.value);
    if (!chip) return;
    chip.textContent = option.label;
    chip.setAttribute('aria-pressed', String(option.value === current));
    chip.disabled = busy;
  });
}

async function setProseStyle(value) {
  if (busy) return;
  setBusy(true);
  try {
    const applied = await post('/api/style', { style: value });
    await refresh();
    setStatus('正文详略已改为「' + applied.label + '」，从下一段开始生效；已经写好的段落不动。');
  } catch (error) {
    notice('没能切换正文详略：' + error.message, 'bad');
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  busy = value;
  $('btn-continue').disabled = value;
  $('btn-intervene').disabled = value;
  $('btn-intervene-toggle').disabled = value;
  $('menu-fill').disabled = value;
  $('btn-start').disabled = value;
  $('style-normal').disabled = value;
  $('style-brief').disabled = value;
  $('btn-continue').textContent = value ? '书写中…' : '继续';
  if (view) renderRunControls(view);
}

// 演绎控件：只在「这个包支持 IF 流程」时出现；旧的两人民场景继续用原来的单步按钮。
function renderRunControls(data) {
  const options = data.if_options || {};
  const demo = (options.supported || []).length > 0;
  const run = data.run || {};
  batchLimit = (data.limits && data.limits.max_batch_ticks) || batchLimit;
  const started = !!run.if_condition;
  const ended = run.status === 'ended';
  const runBtn = $('btn-run');
  const continueBtn = $('btn-continue');
  const endBtn = $('btn-end');

  runBtn.hidden = !demo;
  endBtn.hidden = !demo;
  if (data.engine_mode === 'chapters') {
    runBtn.hidden = true;
    continueBtn.hidden = demo && !started;
    continueBtn.disabled = busy || ended || (demo && !started);
    endBtn.hidden = ended || (demo && !started);
    endBtn.disabled = busy || ended;
    endBtn.textContent = '结束故事并保存';
    $('btn-intervene-toggle').disabled = busy || ended;
    $('btn-intervene').disabled = busy || ended;
    return;
  }
  if (!demo) {
    continueBtn.hidden = false;
    continueBtn.disabled = busy || ended;
    return;
  }
  // 演示档：先写条件再开演；结束后只剩阅读
  continueBtn.hidden = !started;
  continueBtn.disabled = busy || running || ended || !started;
  endBtn.disabled = busy || ended || !started;
  runBtn.disabled = busy || ended || !started;
  if (ended) {
    runBtn.hidden = true;
    endBtn.hidden = true;
    continueBtn.hidden = true;
    return;
  }
  if (!started) {
    runBtn.hidden = true;          // 条件还没写：按钮在开演页里
    continueBtn.hidden = true;
    endBtn.hidden = true;
    return;
  }
  runBtn.hidden = false;
  runBtn.textContent = running
    ? '暂停' + (batchLeft > 0 ? '（本批还剩 ' + batchLeft + ' 刻）' : '')
    : (batchLeft > 0 ? '继续演绎' : '开始演绎');
  runBtn.className = running ? 'ghost' : 'primary';
}

function render(data, options) {
  const opts = options || {};
  view = data;
  renderMode(data);
  renderBanner(data);
  renderIntro(data);
  renderOpening(data);
  renderIfLine(data);
  renderStory(data, opts.animateFromTick);
  renderActions(data);
  renderProseStyle(data);
  renderRunControls(data);
  if (pendingRequestId && data.run && data.run.status !== 'error') {
    pendingRequestId = null;
  }
  setBusy(busy);
}

// ------------------------------------------------------------ 动作

async function refresh(options) {
  const opts = options || {};
  const node = stage();
  const following = isNearBottom();
  const keepTop = node.scrollTop;
  const heightBefore = node.scrollHeight;

  const data = await api('/api/reading');
  render(data, opts);

  const hasNew = typeof opts.animateFromTick === 'number';
  if (hasNew) {
    if (following) {
      toBottom('smooth');
      hideNewHint();
    } else if (node.scrollHeight > heightBefore) {
      // 正在回看前文：不强行拉到底，只提示有新内容
      showNewHint();
    }
  } else if (!following) {
    node.scrollTop = Math.min(keepTop, Math.max(0, node.scrollHeight - node.clientHeight));
  }
  return data;
}

function startWriting(text) {
  $('writing').hidden = false;
  const started = Date.now();
  const tick = view ? (view.run.tick || 0) + 1 : 1;
  const label = text || (view && view.engine_mode === 'chapters'
    ? '正在组织场景和书写完整章节…' : '正在书写第 ' + tick + ' 刻…');
  $('writing-text').textContent = label;
  clearInterval(startWriting.timer);
  startWriting.timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    $('writing-text').textContent = label + '（已等待 ' + seconds + ' 秒）';
  }, 1000);
}

function stopWriting() {
  clearInterval(startWriting.timer);
  startWriting.timer = null;
  $('writing').hidden = true;
}

function resetLiveProse() {
  $('live-prose').hidden = true;
  $('live-prose-text').textContent = '';
}

function appendLiveProse(chunk, tick) {
  const box = $('live-prose');
  const follow = isNearBottom();
  if (box.hidden) {
    $('live-prose-label').textContent = '第 ' + tick + ' 刻正文生成中（尚未保存）';
    box.hidden = false;
  }
  const target = $('live-prose-text');
  if (!target.firstChild) target.appendChild(document.createTextNode(''));
  target.firstChild.appendData(chunk);
  if (follow) { toBottom(); hideNewHint(); } else { showNewHint(); }
}

function rememberAccounting(accounting, advanceAccounting) {
  if (accounting && accounting.logical_requests) lastAccounting = accounting;
  lastAdvanceAccounting = advanceAccounting || null;
}

function describeContinue(result, extra) {
  // extra 是「投入事件」这类需要留在页面上的说明：推进结束后它和结果一起显示，
  // 否则刚说完「已接入」就被下一次渲染清掉，用户不知道那件事到底去哪了。
  const prefix = extra ? extra + '\n' : '';
  if (result.action === 'ended') {
    notice(prefix + (result.message || '这次故事已经结束，不再推进。'), 'warn');
    setStatus('已结束。');
    running = false;
  } else if (result.action === 'recovered') {
    notice(prefix + '第 ' + result.recovered.tick + ' 刻的正文补写完成（世界没有重复推进）。', 'good');
    setStatus('补写完成。' + continueAccountingText(result));
  } else if (result.action === 'recovered_failed') {
    notice(prefix + '这一段正文仍然没有写出来：' + result.prose.error
      + '\n世界状态是完整的，不会因此重复推进；可以稍后再补写这一段。', 'bad');
    setStatus('正文待补。' + continueAccountingText(result));
  } else if (result.action === 'advance_failed') {
    notice(prefix + '推进失败：' + result.advanced.error
      + '\n世界状态没有被改动（这一步没有提交）。确认原因后可以点「重试这一步」。', 'bad');
    setStatus('推进失败。' + continueAccountingText(result));
    $('btn-retry').hidden = false;
  } else if (result.action === 'advance_prose_failed') {
    notice(prefix + '第 ' + result.advanced.tick + ' 刻的世界已经推进并保存，但本段文字尚未生成：'
      + result.prose.error
      + '\n点「继续」只会补这一段正文，不会重复推进世界。', 'warn');
    setStatus('第 ' + result.advanced.tick + ' 刻已推进，正文待补。'
      + continueAccountingText(result));
  } else {
    if (result.engine_mode === 'chapters') {
      notice(prefix + '第 ' + result.advanced.chapter_number + ' 章已保存。可以继续阅读，或从这里投入一件事。', 'good');
      setStatus(result.cache_hit ? '已接续保存好的后续。' : '章节已完成并保存。');
      if (result.preparation_warning) {
        notice(prefix + '本章已完整保存；提前准备后续时没有完成。继续会从本章节点接续。\n'
          + result.preparation_warning, 'warn');
      }
    } else {
      notice(prefix + '第 ' + result.advanced.tick + ' 刻已经写好了。', 'good');
      setStatus('第 ' + result.advanced.tick + ' 刻已写好。' + continueAccountingText(result));
    }
  }
  rememberAccounting(result.accounting, result.advance_accounting);
}

async function continueReading(force, extraNotice) {
  if (leaving) return { ok: false, action: 'left' };
  if (busy) return { ok: false, action: 'busy' };
  setBusy(true);
  notice('');
  $('empty').hidden = true;
  resetLiveProse();
  startWriting();
  if (!pendingRequestId) pendingRequestId = newRequestId();
  const started = performance.now();
  let worldVisible = null;
  let firstProseVisible = null;
  let proseTick = (view && view.run ? view.run.tick : 0) + 1;
  try {
    const result = await postContinueStream({
      request_id: pendingRequestId,
      force_narrate: !!force,
    }, (frame) => {
      if (leaving) return;
      if (frame.type === 'world_committed') {
        worldVisible = performance.now() - started;
        proseTick = frame.tick;
        startWriting(view && view.engine_mode === 'chapters'
          ? '完整章节已保存，正在显示…' : '第 ' + frame.tick + ' 刻世界已提交，正在写正文…');
      } else if (frame.type === 'prose_delta' && frame.text) {
        if (firstProseVisible === null) firstProseVisible = performance.now() - started;
        if (!view || view.engine_mode !== 'chapters') appendLiveProse(frame.text, proseTick);
      }
    });
    if (result.action !== 'advance_failed') pendingRequestId = null;
    const written = (result.prose && result.prose.ok && result.prose.segment)
      ? result.prose.segment : (result.recovered || null);
    if (leaving) return { ok: false, action: 'left' };
    await refresh({ animateFromTick: written ? written.tick : undefined });
    resetLiveProse();
    const fullyVisible = performance.now() - started;
    lastTiming = { worldVisible, firstProseVisible, fullyVisible,
                   server: result.timing || null };
    describeContinue(result, extraNotice);
    const ok = result.action === 'advanced' || result.action === 'recovered';
    return { ok: ok, action: result.action };
  } catch (error) {
    resetLiveProse();
    if (!leaving) {
      try { await refresh(); } catch (ignored) { /* keep the original error */ }
      notice('继续时出错：' + error.message + '\n已刷新存档状态；在途生成可能仍在原故事中收尾。', 'bad');
      setStatus('');
    }
    return { ok: false, action: 'error' };
  } finally {
    stopWriting();
    setBusy(false);
  }
}

// ---------------------------------------------------- 连续演绎（前台按批调度）

async function startStory() {
  if (busy || running) return;
  const text = ($('if-input').value || '').trim();
  if (!text) { $('if-note').textContent = '先写下这次的条件。'; return; }
  $('if-note').textContent = '正在把这句话变成起始条件…';
  setBusy(true);
  const ifStarted = performance.now();
  try {
    const applied = await post('/api/start', { if_text: text });
    lastIfTiming = performance.now() - ifStarted;
    lastIfAccounting = applied.accounting || null;
    if (leaving) return;
    await refresh();
    notice('条件已经生效：' + applied.description
      + '\n范围：' + applied.scope_label + '；来源：' + applied.source
      + (applied.note ? '（' + applied.note + '）' : '')
      + '\n接下来会连续演绎，随时可以暂停或结束。', 'good');
    setStatus('条件已生效。');
    setBusy(false);
    if (!leaving) runBatch();
  } catch (error) {
    $('if-note').textContent = '没有写进去：' + error.message;
    notice('这个条件没有生效：' + error.message
      + '\n可以换一种说法，或者从下面的例子挑一个改。', 'bad');
    setBusy(false);
  }
}

async function runBatch() {
  if (running || busy) return;
  if (view && view.engine_mode === 'chapters') {
    await continueReading(false);
    return;
  }
  const run = (view && view.run) || {};
  if (run.status === 'ended') {
    notice('这次故事已经结束，不再推进；可以继续阅读，或新开一个存档换条件。', 'warn');
    return;
  }
  if (!run.if_condition) {
    notice('先写下这次的条件，再开始演绎。', 'warn');
    return;
  }
  running = true;
  batchLeft = batchLimit;
  renderRunControls(view);
  let stoppedByCap = false;
  let failed = false;
  try {
    while (running && !leaving && batchLeft > 0) {
      const outcome = await continueReading(false);
      if (!outcome.ok) { failed = !outcome.ok && outcome.action !== 'ended'; break; }
      batchLeft -= 1;
      renderRunControls(view);
      if (!running || batchLeft <= 0) break;
      await sleep(BATCH_INTERVAL_MS);      // 正文已经显示完，等一会儿再走下一刻
    }
    stoppedByCap = running && batchLeft <= 0;
  } finally {
    running = false;
    renderRunControls(view);
    if (stoppedByCap) {
      notice('本批已经走满 ' + batchLimit + ' 刻，先停在这里。'
        + '\n这是运行保护，不是故事结束；点「继续演绎」可以再走一批。', 'warn');
    } else if (!failed) {
      setStatus('已暂停在第 ' + (((view || {}).run || {}).tick || 0) + ' 刻。');
    }
  }
}

function pauseBatch() {
  if (!running) return;
  running = false;                       // 正在飞的那一步会正常收尾，之后不再调度
  renderRunControls(view);
  setStatus('已暂停；正在进行的这一步会正常结束，之后不会再自动推进。');
}

async function endStory() {
  if (busy || !view) return;
  const tick = (view.run || {}).tick || 0;
  if (!window.confirm('结束本次演示并保存？\\n故事会停在第 ' + tick
      + ' 刻，之后不再推进；已经写下的正文保留，随时可以重新打开阅读。')) {
    return;
  }
  running = false;
  setBusy(true);
  try {
    const result = await post('/api/end', {});
    if (leaving) return;
    await refresh();
    const endingPoint = view.engine_mode === 'chapters'
      ? '第 ' + view.run.chapter_number + ' 章'
      : '第 ' + result.tick + ' 刻';
    notice('故事已结束并保存（' + endingPoint + '）：' + result.note
      + '\n这是读者手动结束，不是剧情自然收束。已经写下的正文都在，重新打开还能读。', 'good');
    setStatus('已结束。');
  } catch (error) {
    notice('没能结束：' + error.message, 'bad');
  } finally {
    setBusy(false);
    renderRunControls(view);
  }
}

async function retryStep() {
  if (busy) return;
  setBusy(true);
  startWriting('正在重试第 ' + ((view.run.tick || 0) + 1) + ' 刻…');
  try {
    const rid = pendingRequestId || newRequestId();
    pendingRequestId = rid;
    const result = await post('/api/continue', { request_id: rid });
    if (leaving) return;
    if (result.action !== 'advance_failed') pendingRequestId = null;
    const written = result.prose && result.prose.ok ? result.prose.segment : null;
    await refresh({ animateFromTick: written ? written.tick : undefined });
    describeContinue(result);
  } catch (error) {
    notice('重试失败：' + error.message, 'bad');
  } finally {
    stopWriting();
    setBusy(false);
  }
}

async function fillTicks(ticks, label) {
  if (busy) return;
  setBusy(true);
  try {
    for (let index = 0; index < ticks.length && !leaving; index += 1) {
      const tick = ticks[index];
      startWriting((label || '正在补写') + '第 ' + tick + ' 刻…');
      const result = await post('/api/narrate', { tick: tick, force: true });
      stopWriting();
      if (leaving) break;
      await refresh({ animateFromTick: tick });
      rememberAccounting(result.accounting);
      setStatus('第 ' + tick + ' 刻补写完成。' + accountingText(result.accounting));
    }
    notice('补写完成。', 'good');
  } catch (error) {
    stopWriting();
    notice('补写出错：' + error.message
      + '\n世界状态不受影响；已经写好的段落不会重做。', 'bad');
  } finally {
    stopWriting();
    setBusy(false);
  }
}

function missingTicks() {
  if (!view) return [];
  const missing = (view.missing_ticks || []).slice();
  (view.failed_segments || []).forEach((seg) => {
    if (missing.indexOf(seg.tick) < 0) missing.push(seg.tick);
  });
  return missing.sort((a, b) => a - b);
}

async function fillMissing() {
  if (busy || !view) return;
  const all = missingTicks();
  if (!all.length) return;
  const warning = view.mode === 'deepseek'
    ? '每段会调用一次模型（真实模式会计费）。' : '模拟模式不会调用真实模型。';
  if (!window.confirm('有 ' + all.length + ' 段正文尚未生成，将逐段补写。'
      + warning + '\n继续吗？')) {
    return;
  }
  await fillTicks(all, '正在补写');
}

async function intervene() {
  if (busy || !view) return;
  const input = $('intervene-input');
  const text = (input.value || '').trim();
  if (!text) { notice('先写一件希望发生的事。', 'warn'); return; }
  setBusy(true);
  notice('');
  let summary = '';
  try {
    const queued = await post('/api/intervene', { text: text });
    if (leaving) return;
    $('intervene-note').textContent = '已接入（' + queued.source + '）：' + queued.scope_label;
    summary = '你把这件事放进了世界：' + queued.description
      + '\n范围：' + queued.scope_label + '；' + queued.note;
    notice(summary + (view.engine_mode === 'chapters'
      ? '\n未读后续会按新条件重新组织，从这里展开下一章。'
      : '\n接下来推进的一刻它就会生效，人物会按各自知道的情况作出反应。'), 'good');
    input.value = '';
  } catch (error) {
    $('intervene-note').textContent = '';
    notice('这件事没有接入：' + error.message, 'bad');
    setBusy(false);
    return;
  }
  setBusy(false);
  setInterveneOpen(false);
  // 让事件真的生效：跳过「先补正文」那一步，直接推进一刻，并把上面的说明带过去。
  if (!leaving) await continueReading(true, summary);
}

// ------------------------------------------------------------ 抽屉与菜单

function setDrawer(open) {
  $('drawer').hidden = !open;
  $('drawer-backdrop').hidden = !open;
  $('btn-cast').setAttribute('aria-expanded', String(open));
  // 抽屉是覆盖层：不动 #stage 的滚动位置，关闭后仍在原来的段落
  if (open) { $('drawer-close').focus(); } else { $('btn-cast').focus(); }
}

function setMenu(open) {
  $('more-menu').hidden = !open;
  $('btn-more').setAttribute('aria-expanded', String(open));
  if (!open) $('usage-detail').hidden = true;
}

function setInterveneOpen(open) {
  $('intervene-box').hidden = !open;
  $('btn-intervene-toggle').setAttribute('aria-expanded', String(open));
  if (open) { $('intervene-input').focus(); }
}

function toggleUsage() {
  const box = $('usage-detail');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  if (lastAccounting || lastAdvanceAccounting || lastIfTiming !== null) {
    const lines = [];
    if (lastIfTiming !== null) {
      lines.push('本页 IF 理解：' + (lastIfTiming / 1000).toFixed(1) + ' 秒；'
        + accountingText(lastIfAccounting));
    }
    if (lastAdvanceAccounting) lines.push('世界与人物：' + accountingText(lastAdvanceAccounting));
    if (lastAccounting) lines.push((view && view.engine_mode === 'chapters' ? '章节生成：' : '正文：') + accountingText(lastAccounting));
    const cacheSummary = (stats) => {
      if (!stats) return;
      const cache = stats.cache_tokens;
      if (stats.cache_usage_known && cache && Number.isFinite(stats.cache_hit_rate)) {
        lines.push('输入缓存：命中 ' + cache.hit + ' · 未命中 ' + cache.miss
          + ' · 输入命中率 ' + (stats.cache_hit_rate * 100).toFixed(1) + '%（仅以输入为分母）');
      } else if (stats.cache_usage_known === false) {
        lines.push('输入缓存：服务未返回完整统计，不能据此计算本次命中率。');
      }
    };
    cacheSummary(lastAdvanceAccounting); cacheSummary(lastAccounting);
    const stages = (stats) => ((stats && stats.calls) || []).forEach((call) => {
      const name = call.stage + (call.actor_id ? '/' + call.actor_id : '');
      const transport = call.transport || {};
      const bits = ['用时 ' + ((call.elapsed_ms || 0) / 1000).toFixed(1) + ' 秒'];
      if (transport.connect_ms !== undefined) bits.push('连接 ' + (transport.connect_ms / 1000).toFixed(2));
      if (transport.headers_wait_ms !== undefined) bits.push('等头 ' + (transport.headers_wait_ms / 1000).toFixed(2));
      if (transport.body_ms !== undefined) bits.push('读体 ' + (transport.body_ms / 1000).toFixed(2));
      if (call.tokens && Number.isFinite(call.tokens.prompt)) bits.push('输入 ' + call.tokens.prompt);
      if (call.tokens && Number.isFinite(call.tokens.completion)) bits.push('输出 ' + call.tokens.completion);
      if (call.tokens && Number.isFinite(call.tokens.prompt_cache_hit_tokens) && Number.isFinite(call.tokens.prompt_cache_miss_tokens)) {
        bits.push('缓存命中 ' + call.tokens.prompt_cache_hit_tokens + ' / 未命中 ' + call.tokens.prompt_cache_miss_tokens);
      }
      if (call.tokens && call.tokens.reasoning !== undefined) bits.push('推理 token ' + call.tokens.reasoning);
      lines.push(name + '：' + bits.join(' · '));
    });
    stages(lastAdvanceAccounting);
    stages(lastAccounting);
    if (lastTiming) {
      const fmt = (ms) => ms === null || ms === undefined ? '未取得' : (ms / 1000).toFixed(1) + ' 秒';
      lines.push('本页点击到世界提交 ' + fmt(lastTiming.worldVisible)
        + '；正文首字 ' + fmt(lastTiming.firstProseVisible)
        + '；完整可读 ' + fmt(lastTiming.fullyVisible));
      const server = lastTiming.server || {};
      if (server.world_committed_ms !== undefined) {
        lines.push('服务端：世界提交 ' + fmt(server.world_committed_ms)
          + '；首字 ' + fmt(server.first_prose_ms)
          + '；完成 ' + fmt(server.complete_ms));
      }
    }
    box.textContent = lines.join('\n');
  } else {
    box.textContent = '这次打开页面还没有调用过模型；点「继续」或「让它发生」之后这里会有明细。';
  }
}

function renderHints(data) {
  const box = $('hints');
  box.innerHTML = '';
  const items = data.hints || [];
  if (!items.length) {
    box.appendChild(el('div', null, '直接写一件你希望发生的事即可。'));
    return;
  }
  items.forEach((line) => box.appendChild(el('div', null, line)));
}

// ------------------------------------------------------------ 绑定

function bind() {
  $('btn-back').hidden = !selectedStoryId;
  if (selectedStoryId) $('dev-link').hidden = true;
  $('btn-back').addEventListener('click', () => { running = false; });
  $('btn-continue').addEventListener('click', () => continueReading(false));
  $('btn-run').addEventListener('click', () => { if (running) pauseBatch(); else runBatch(); });
  $('btn-end').addEventListener('click', endStory);
  $('btn-start').addEventListener('click', startStory);
  $('btn-if-example').addEventListener('click', () => {
    const examples = ((view || {}).if_options || {}).examples || [];
    if (!examples.length) return;
    ifExampleIndex = (ifExampleIndex + 1) % examples.length;
    $('if-input').value = examples[ifExampleIndex];
    $('if-note').textContent = '示例 ' + (ifExampleIndex + 1) + '/' + examples.length
      + '（可以直接改）';
  });
  $('btn-retry').addEventListener('click', retryStep);
  $('style-normal').addEventListener('click', () => setProseStyle('normal'));
  $('style-brief').addEventListener('click', () => setProseStyle('brief'));
  $('btn-intervene-toggle').addEventListener('click', () => {
    setInterveneOpen($('intervene-box').hidden);
  });
  $('btn-intervene').addEventListener('click', intervene);
  $('btn-hint').addEventListener('click', () => {
    const box = $('hints');
    box.hidden = !box.hidden;
  });
  $('btn-cast').addEventListener('click', () => setDrawer($('drawer').hidden));
  $('drawer-close').addEventListener('click', () => setDrawer(false));
  $('drawer-backdrop').addEventListener('click', () => setDrawer(false));
  $('btn-more').addEventListener('click', (event) => {
    event.stopPropagation();
    setMenu($('more-menu').hidden);
  });
  $('more-menu').addEventListener('click', (event) => event.stopPropagation());
  $('menu-fill').addEventListener('click', () => { setMenu(false); fillMissing(); });
  $('menu-usage').addEventListener('click', toggleUsage);
  $('new-hint').addEventListener('click', () => { toBottom('smooth'); hideNewHint(); });
  stage().addEventListener('scroll', () => {
    if (isNearBottom(24)) hideNewHint();
  });
  document.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('drawer').hidden) { setDrawer(false); return; }
    if (!$('more-menu').hidden) { setMenu(false); return; }
    if (!$('intervene-box').hidden) setInterveneOpen(false);
  });
  $('intervene-input').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') intervene();
  });
}

async function boot() {
  bind();
  try {
    const data = await refresh();
    renderHints(data);
    batchLimit = (data.limits && data.limits.max_batch_ticks) || batchLimit;
    toBottom('auto');            // 打开就停在最新一段
    const started = !!(data.run && data.run.if_condition);
    const supported = ((data.if_options || {}).supported || []).length;
    if (data.last_failure) {
      notice('上次章节生成未完成：' + data.last_failure.error, 'bad');
      $('btn-retry').hidden = false;
    } else if (supported && !started) {
      notice('这是这一次要演的世界。写下你的条件，点「开始演绎」才会开始调用模型。');
    } else if (!(data.segments || []).length && !(data.missing_ticks || []).length) {
      notice(data.engine_mode === 'chapters'
        ? '这个故事还没有正文。点「继续」展开第一章，在自然停顿处保存。'
        : '这个世界还没有正文。点「继续」推进一刻，程序会先让角色行动，再把这一刻写成正文。');
    }
  } catch (error) {
    notice('读不到这个世界：' + error.message
      + '\n可以刷新重试，或从备份文件恢复本地存档。', 'bad');
  }
}

// 离开页面时停掉调度：不 promise 取消已发出的请求，但不会再发下一步。
window.addEventListener('pagehide', () => { leaving = true; running = false; });


boot();
