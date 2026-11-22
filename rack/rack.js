// prism-fx rack: the page. Reads the catalogue from the wasm module, draws a
// panel for each effect from its descriptor, and drives the worklet.

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};

// The chain the page opens with, with settings you can hear on the first Play.
// Effects that need more than their defaults to make sense in a browser demo.
const ON_ADD = { convolution: { lengthMs: 1200 } };
const START = [['hp-chorus', { rateHz: 0.8, depth: 30 }], ['hp-echo', {}], ['lxp-hall', {}]];
const state = { catalog: [], byId: {}, rack: [], ctx: null, node: null, module: null, req: 0, pending: {}, source: 'kit', kit: 'funk-break', playing: false, bypass: false };

// ---------- values: the same mapping as ParamSpec::to_unit / from_unit
function clamp(p, v) {
  if (!Number.isFinite(v)) return p.default;
  v = Math.min(p.max, Math.max(p.min, v));
  if (p.kind === 'int' || p.kind === 'choice') return Math.round(v);
  if (p.kind === 'toggle') return v >= (p.min + p.max) / 2 ? p.max : p.min;
  return v;
}
const useLog = (p) => p.log && p.min > 0;
function toUnit(p, v) {
  v = clamp(p, v);
  const u = useLog(p) ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min || 1);
  return Math.min(1, Math.max(0, u));
}
function fromUnit(p, u) {
  u = Math.min(1, Math.max(0, u));
  return clamp(p, useLog(p) ? p.min * Math.pow(p.max / p.min, u) : p.min + (p.max - p.min) * u);
}
function show(p, v) {
  if (p.kind === 'choice') return p.choices[Math.round(v - p.min)] ?? String(v);
  if (p.kind === 'toggle') return v >= p.max ? 'On' : 'Off';
  const a = Math.abs(v);
  let s;
  if (p.unit === 'Hz' && a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + ' kHz';
  if (p.unit === 'ms' && a >= 1000) return (v / 1000).toFixed(2) + ' s';
  if (p.kind === 'int') s = String(Math.round(v));
  else s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return p.unit ? s + ' ' + p.unit : s;
}

// A short decaying noise burst: the second sound a convolution takes.
function impulse(rate) {
  const frames = Math.round(rate * 1.2), out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const env = Math.pow(1 - i / frames, 3) * Math.exp(-i / rate * 3);
    out[i * 2] = (Math.random() * 2 - 1) * env;
    out[i * 2 + 1] = (Math.random() * 2 - 1) * env;
  }
  return { frames, samples: out };
}

// ---------- audio
async function boot() {
  const bytes = await (await fetch('prism_rack.wasm')).arrayBuffer();
  state.module = await WebAssembly.compile(bytes);
  const { exports: x } = await WebAssembly.instantiate(state.module, {});
  const n = x.catalog_json_len(), ptr = x.catalog_json();
  state.catalog = JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, n)));
  state.catalog.forEach((e) => (state.byId[e.id] = e));
  $('#count').textContent = state.catalog.length;
  drawBrowser();
  START.forEach(([id, set]) => addEffect(id, false, set));
  drawRack();
}

async function audio() {
  if (state.ctx) return;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('worklet.js');
  const node = new AudioWorkletNode(ctx, 'prism-rack', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { module: state.module } });
  node.port.onmessage = (e) => onWorklet(e.data);
  const master = ctx.createGain(); master.gain.value = Number($('#vol').value);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.75;
  node.connect(master).connect(analyser).connect(ctx.destination);
  Object.assign(state, { ctx, node, master, analyser, buffers: {} });
  // Hand the worklet the rack that is already on the page, in order.
  state.rack.forEach((fx) => { fx.slot = null; send(fx); });
  post({ op: 'bypass', on: state.bypass });
  scope();
}

const post = (m) => state.node && state.node.port.postMessage(m);

function send(fx) {
  const req = ++state.req;
  state.pending[req] = fx;
  post({ op: 'add', id: fx.e.id, bytes: new TextEncoder().encode(fx.e.id), params: fx.values, req });
}

function onWorklet(m) {
  if (m.op === 'added') {
    const fx = state.pending[m.req]; delete state.pending[m.req];
    if (!fx) return;
    if (!state.rack.includes(fx)) { post({ op: 'remove', slot: m.slot }); return; }
    fx.slot = m.slot;
    if (!fx.on) post({ op: 'on', slot: fx.slot, on: false });
    if (fx.e.sound) post({ op: 'sound', slot: fx.slot, rate: state.ctx.sampleRate, ...impulse(state.ctx.sampleRate) });
    sendOrder();
  } else if (m.op === 'meter') {
    meter(m.peak);
    state.rack.forEach((fx) => { if (fx.tele) fx.tele.textContent = m.tele[fx.slot] ? '−' + m.tele[fx.slot].toFixed(1) + ' dB' : ''; });
  }
}

function sendOrder() { post({ op: 'order', order: state.rack.filter((fx) => fx.slot != null).map((fx) => fx.slot) }); }

async function play() {
  await audio();
  await state.ctx.resume();
  stopSource();
  const ctx = state.ctx;
  if (state.source === 'mic') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      state.stream = stream;
      state.src = ctx.createMediaStreamSource(stream);
    } catch (err) {
      note('The microphone is blocked. Allow it in the browser, or pick one of the sounds.');
      return;
    }
  } else {
    const src = ctx.createBufferSource();
    src.buffer = state.source === 'file' && state.file ? state.file : kitBuffer(state.kit);
    src.loop = true;
    src.start();
    state.src = src;
  }
  state.src.connect(state.node);
  state.playing = true;
  $('#play').textContent = 'Stop';
  $('#play').classList.add('on');
}

function kitBuffer(id) {
  return state.buffers[id] || (state.buffers[id] = SoundKit.toBuffer(state.ctx, id));
}

function stopSource() {
  if (state.src) { try { state.src.stop && state.src.stop(); } catch {} state.src.disconnect(); state.src = null; }
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  state.playing = false;
  $('#play').textContent = 'Play';
  $('#play').classList.remove('on');
}

async function loadFile(file) {
  await audio();
  try {
    state.file = await state.ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    note('That file could not be read. Try a WAV, AIFF, MP3 or FLAC.');
    return;
  }
  state.source = 'file';
  $('#src-file').textContent = file.name.length > 26 ? file.name.slice(0, 24) + '…' : file.name;
  srcButtons();
  note('');
  play();
}

const note = (t) => ($('#note').textContent = t);

// ---------- the rack
function addEffect(id, live = true, set = {}) {
  const e = state.byId[id];
  if (!e) return;
  set = { ...(ON_ADD[id] || {}), ...set };
  const fx = { e, values: e.params.map((p) => clamp(p, p.key in set ? set[p.key] : p.default)), on: true, open: false, slot: null };
  state.rack.push(fx);
  if (live) { send(fx); drawRack(); fx.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function removeEffect(fx) {
  state.rack = state.rack.filter((f) => f !== fx);
  if (fx.slot != null) post({ op: 'remove', slot: fx.slot });
  drawRack();
}

function move(fx, by) {
  const i = state.rack.indexOf(fx), j = i + by;
  if (j < 0 || j >= state.rack.length) return;
  [state.rack[i], state.rack[j]] = [state.rack[j], state.rack[i]];
  sendOrder();
  drawRack();
}

function setValue(fx, i, v) {
  const p = fx.e.params[i];
  v = clamp(p, v);
  fx.values[i] = v;
  if (fx.slot != null) post({ op: 'param', slot: fx.slot, i, v });
  const c = fx.controls[i];
  if (c) c.update(v);
  if (fx.pad) fx.pad.draw();
  dimWhen(fx);
}

function dimWhen(fx) {
  fx.e.params.forEach((p, i) => {
    const c = fx.controls[i];
    if (!c || !p.when) return;
    const k = fx.e.params.findIndex((q) => q.key === p.when[0]);
    c.el.classList.toggle('dim', k >= 0 && fx.values[k] !== p.when[1]);
  });
}

function control(fx, i) {
  const p = fx.e.params[i], id = `c-${state.rack.indexOf(fx)}-${p.key}`;
  if (p.kind === 'toggle') {
    const b = h('button', { class: 'tog', id, type: 'button', 'aria-pressed': 'false', onclick: () => setValue(fx, i, fx.values[i] >= p.max ? p.min : p.max) });
    const el = h('div', { class: 'ctl toggle' }, h('span', { class: 'lab' }, p.label), b);
    return { el, update: (v) => { const on = v >= p.max; b.textContent = on ? 'On' : 'Off'; b.setAttribute('aria-pressed', on); } };
  }
  if (p.kind === 'choice' && p.choices.length <= 4) {
    const bs = p.choices.map((c, k) => h('button', { type: 'button', onclick: () => setValue(fx, i, p.min + k) }, c));
    const el = h('div', { class: 'ctl choice' }, h('span', { class: 'lab' }, p.label), h('div', { class: 'seg' }, bs));
    return { el, update: (v) => bs.forEach((b, k) => b.classList.toggle('on', p.min + k === Math.round(v))) };
  }
  if (p.kind === 'choice') {
    const s = h('select', { id, onchange: () => setValue(fx, i, p.min + s.selectedIndex) }, p.choices.map((c) => h('option', {}, c)));
    const el = h('label', { class: 'ctl choice', for: id }, h('span', { class: 'lab' }, p.label), s);
    return { el, update: (v) => (s.selectedIndex = Math.round(v - p.min)) };
  }
  const r = h('input', { type: 'range', id, min: 0, max: 1000, step: 1, 'aria-label': p.label });
  const val = h('output', { for: id });
  r.addEventListener('input', () => setValue(fx, i, fromUnit(p, r.value / 1000)));
  r.addEventListener('dblclick', () => setValue(fx, i, p.default));
  const el = h('label', { class: 'ctl', for: id, title: 'Double-click to reset' }, h('span', { class: 'lab' }, p.label), r, val);
  return {
    el,
    update: (v) => {
      r.value = Math.round(toUnit(p, v) * 1000);
      r.style.setProperty('--u', toUnit(p, v));
      val.textContent = show(p, v);
    },
  };
}

function pad(fx) {
  const P = fx.e.pad, xi = fx.e.params.findIndex((q) => q.key === P.x), yi = fx.e.params.findIndex((q) => q.key === P.y);
  if (xi < 0 || yi < 0) return null;
  const cv = h('canvas', { class: 'pad', width: 320, height: 220, role: 'img', 'aria-label': `Pad: ${fx.e.params[xi].label} across, ${fx.e.params[yi].label} up` });
  const px = fx.e.params[xi], py = fx.e.params[yi];
  const ux = (v) => (v - P.xRange[0]) / (P.xRange[1] - P.xRange[0]), uy = (v) => (v - P.yRange[0]) / (P.yRange[1] - P.yRange[0]);
  const draw = () => {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(124,227,134,.12)'; g.lineWidth = 1;
    for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo((W * k) / 4, 0); g.lineTo((W * k) / 4, H); g.moveTo(0, (H * k) / 4); g.lineTo(W, (H * k) / 4); g.stroke(); }
    const x = Math.min(1, Math.max(0, ux(fx.values[xi]))) * W, y = (1 - Math.min(1, Math.max(0, uy(fx.values[yi])))) * H;
    g.strokeStyle = 'rgba(124,227,134,.35)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillStyle = '#7ce386'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(232,240,233,.55)'; g.font = '11px ui-monospace, monospace';
    g.fillText(`→ ${px.label} ${show(px, fx.values[xi])}`, 8, H - 8);
    g.fillText(`↑ ${py.label} ${show(py, fx.values[yi])}`, 8, 16);
  };
  const at = (ev) => {
    const b = cv.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width)), w = Math.min(1, Math.max(0, 1 - (ev.clientY - b.top) / b.height));
    setValue(fx, xi, P.xRange[0] + u * (P.xRange[1] - P.xRange[0]));
    setValue(fx, yi, P.yRange[0] + w * (P.yRange[1] - P.yRange[0]));
  };
  cv.addEventListener('pointerdown', (ev) => { cv.setPointerCapture(ev.pointerId); at(ev); });
  cv.addEventListener('pointermove', (ev) => { if (cv.hasPointerCapture(ev.pointerId)) at(ev); });
  return { el: cv, draw };
}

function panel(fx, index) {
  const e = fx.e;
  fx.controls = {};
  const live = e.params.map((p, i) => i).filter((i) => !e.params[i].inert);
  const keyIndex = (k) => e.params.findIndex((q) => q.key === k);
  const primary = e.primary.map(keyIndex).filter((i) => i >= 0 && !e.params[i].inert);
  const groups = e.groups.length ? e.groups.map((g) => ({ label: g.label, idx: g.keys.map(keyIndex).filter((i) => i >= 0 && !e.params[i].inert) })) : [{ label: '', idx: live }];
  const grouped = new Set(groups.flatMap((g) => g.idx));
  const rest = live.filter((i) => !grouped.has(i));
  if (rest.length) groups.push({ label: 'More', idx: rest });
  const big = live.length > 8 && primary.length > 0;
  const showAll = fx.open || !big;

  const body = h('div', { class: 'body' });
  if (e.pad) { fx.pad = pad(fx); if (fx.pad) body.append(h('div', { class: 'padwrap' }, fx.pad.el)); } else fx.pad = null;
  const ctls = h('div', { class: 'ctls' });
  if (showAll) {
    groups.forEach((g) => {
      if (!g.idx.length) return;
      ctls.append(h('div', { class: 'grp' }, g.label ? h('small', {}, g.label) : null, g.idx.map((i) => (fx.controls[i] = control(fx, i)).el)));
    });
  } else {
    ctls.append(h('div', { class: 'grp' }, h('small', {}, 'Main controls'), primary.map((i) => (fx.controls[i] = control(fx, i)).el)));
  }
  if (!live.length) ctls.append(h('p', { class: 'none' }, 'No controls: it does one thing.'));
  body.append(ctls);

  fx.tele = h('span', { class: 'tele' });
  const onBtn = h('button', { class: 'pill' + (fx.on ? ' on' : ''), type: 'button', 'aria-pressed': String(fx.on), onclick: () => { fx.on = !fx.on; post({ op: 'on', slot: fx.slot, on: fx.on }); onBtn.classList.toggle('on', fx.on); onBtn.setAttribute('aria-pressed', fx.on); el.classList.toggle('off', !fx.on); } }, 'On');
  const head = h('header', {},
    h('div', { class: 'ttl' }, h('b', {}, h('span', { class: 'num' }, String(index + 1).padStart(2, '0')), e.label), h('small', {}, `${e.category} · ${e.source.split(/[:—(]/)[0].trim()}`)),
    fx.tele,
    h('div', { class: 'acts' },
      onBtn,
      h('button', { class: 'icon', type: 'button', title: 'Move up', 'aria-label': 'Move up', onclick: () => move(fx, -1), disabled: index === 0 }, '↑'),
      h('button', { class: 'icon', type: 'button', title: 'Move down', 'aria-label': 'Move down', onclick: () => move(fx, 1), disabled: index === state.rack.length - 1 }, '↓'),
      h('button', { class: 'icon', type: 'button', title: 'Remove', 'aria-label': 'Remove ' + e.label, onclick: () => removeEffect(fx) }, '×')));
  const el = h('article', { class: 'fx' + (fx.on ? '' : ' off') }, head, body,
    big ? h('button', { class: 'more', type: 'button', onclick: () => { fx.open = !fx.open; drawRack(); } }, fx.open ? 'Main controls only' : `All ${live.length} controls`) : null,
    e.sound ? h('p', { class: 'none' }, 'Its second sound is a generated noise burst.') : null);
  fx.el = el;
  Object.entries(fx.controls).forEach(([i, c]) => c.update(fx.values[i]));
  if (fx.pad) fx.pad.draw();
  dimWhen(fx);
  return el;
}

function drawRack() {
  const r = $('#rack');
  r.replaceChildren(...state.rack.map((fx, i) => panel(fx, i)));
  if (!state.rack.length) r.append(h('div', { class: 'empty' }, h('b', {}, 'The rack is empty.'), ' Pick an effect from the list to add it. Effects run top to bottom.'));
  $('#chain').textContent = state.rack.length ? state.rack.map((fx) => fx.e.label).join('  →  ') : 'Dry signal';
}

// ---------- the effect list
function drawBrowser() {
  const cats = [...new Set(state.catalog.map((e) => e.category))];
  const chips = $('#cats');
  const pick = (c) => { state.cat = state.cat === c ? null : c; chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === state.cat)); list(); };
  chips.replaceChildren(...cats.map((c) => h('button', { type: 'button', 'data-c': c, onclick: () => pick(c) }, c)));
  $('#q').addEventListener('input', list);
  list();
}

function list() {
  const q = $('#q').value.trim().toLowerCase();
  const xs = state.catalog.filter((e) => (!state.cat || e.category === state.cat) && (!q || (e.label + ' ' + e.source + ' ' + e.category).toLowerCase().includes(q)));
  $('#list').replaceChildren(...xs.map((e) => h('li', {}, h('button', { type: 'button', onclick: () => addEffect(e.id) }, h('b', {}, e.label), h('small', {}, e.source.split(/[:—(]/)[0].trim()), h('i', { 'aria-hidden': 'true' }, '+')))));
  $('#shown').textContent = xs.length === state.catalog.length ? '' : `${xs.length} shown`;
}

// ---------- meters and scope
function meter(peak) {
  peak.forEach((v, k) => {
    const db = 20 * Math.log10(Math.max(v, 1e-5));
    const bar = document.querySelectorAll('.meter i')[k];
    if (bar) { bar.style.setProperty('--u', Math.max(0, Math.min(1, (db + 60) / 60))); bar.classList.toggle('hot', db > -1); }
  });
}

function scope() {
  const cv = $('#scope'), g = cv.getContext('2d');
  const a = state.analyser, data = new Uint8Array(a.frequencyBinCount);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frame = () => {
    const W = (cv.width = cv.clientWidth * devicePixelRatio), H = (cv.height = cv.clientHeight * devicePixelRatio);
    a.getByteFrequencyData(data);
    g.clearRect(0, 0, W, H);
    const grad = g.createLinearGradient(0, H, 0, 0); grad.addColorStop(0, 'rgba(124,227,134,.05)'); grad.addColorStop(1, 'rgba(124,227,134,.55)');
    g.fillStyle = grad; g.strokeStyle = '#7ce386'; g.lineWidth = 1.5 * devicePixelRatio;
    g.beginPath(); g.moveTo(0, H);
    const nyq = state.ctx.sampleRate / 2;
    for (let x = 0; x <= W; x += 2) {
      const f = 20 * Math.pow(nyq / 20, x / W), bin = Math.min(data.length - 1, Math.round((f / nyq) * data.length));
      g.lineTo(x, H - (data[bin] / 255) * H * 0.92);
    }
    g.lineTo(W, H); g.closePath(); g.fill(); g.stroke();
    if (!reduce || state.playing) requestAnimationFrame(frame);
  };
  frame();
}

// ---------- the bar
function srcButtons() {
  document.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === state.source));
  $('.kit').classList.toggle('off', state.source !== 'kit');
}

// The sound menu: SoundKit's twelve sounds, grouped.
(function soundMenu() {
  const sel = $('#sound'), groups = {};
  SoundKit.list.forEach((s) => (groups[s.group] = groups[s.group] || []).push(s));
  sel.replaceChildren(...Object.entries(groups).map(([g, xs]) => h('optgroup', { label: g }, xs.map((s) => h('option', { value: s.id, title: s.note, selected: s.id === state.kit }, s.bpm ? `${s.name} · ${s.bpm} BPM` : s.name)))));
  sel.addEventListener('change', () => { state.kit = sel.value; state.source = 'kit'; srcButtons(); if (state.playing) play(); });
})();

$('#play').addEventListener('click', () => (state.playing ? stopSource() : play()));
document.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.src === 'file' && !state.file) { $('#file').click(); return; }
  state.source = b.dataset.src; srcButtons(); if (state.playing) play();
}));
$('#file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
$('#bypass').addEventListener('click', (e) => { state.bypass = !state.bypass; e.currentTarget.classList.toggle('on', state.bypass); e.currentTarget.setAttribute('aria-pressed', state.bypass); post({ op: 'bypass', on: state.bypass }); });
$('#vol').addEventListener('input', (e) => state.master && state.master.gain.setTargetAtTime(Number(e.target.value), state.ctx.currentTime, 0.02));
$('#clear').addEventListener('click', () => { state.rack.forEach((fx) => fx.slot != null && post({ op: 'remove', slot: fx.slot })); state.rack = []; drawRack(); });
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drop'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

// Inside the portfolio site, offer the way back to the case study.
fetch('../case-prism-fx.html', { method: 'HEAD' }).then((r) => { if (r.ok) { const a = $('#back'); a.href = '../case-prism-fx.html'; a.textContent = '← The prism-fx case study'; } }).catch(() => {});

boot().catch((err) => { note('The rack could not start: ' + err.message); console.error(err); });
