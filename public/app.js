'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder: el('div', {class: 'x', onclick: fn}, child, 'text') */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Not logged in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const stateLabel = { running: 'Live', starting: 'Connecting…', retrying: 'Reconnecting…', stopped: 'Disabled' };

const state = { cameras: [], view: null, players: [], pollTimer: null };

// ---------------------------------------------------------------- auth
function showLogin() {
  stopLive();
  $('#app').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name=username]').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
    e.target.reset();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

// ---------------------------------------------------------------- routing
function route() {
  const view = (location.hash.replace(/^#\//, '') || 'live').split('?')[0];
  const known = ['live', 'recordings', 'cameras', 'system'];
  const v = known.includes(view) ? view : 'live';
  for (const k of known) $(`#view-${k}`).hidden = k !== v;
  for (const a of document.querySelectorAll('.topbar nav a')) a.classList.toggle('active', a.dataset.view === v);
  if (state.view === 'live' && v !== 'live') stopLive();
  if (v !== 'recordings') $('#rec-player').pause();
  state.view = v;
  ({ live: renderLive, recordings: renderRecordings, cameras: renderCameras, system: renderSystem })[v]();
}
window.addEventListener('hashchange', route);

async function loadCameras() {
  state.cameras = await api('GET', '/api/cameras');
  return state.cameras;
}

// ---------------------------------------------------------------- live
function stopLive() {
  for (const p of state.players) p.destroy();
  state.players = [];
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function attachHls(video, src) {
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, lowLatencyMode: false, manifestLoadingMaxRetry: Infinity, manifestLoadingRetryDelay: 2000, levelLoadingMaxRetry: Infinity });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else setTimeout(() => hls.loadSource(src), 3000);
    });
    return { destroy: () => hls.destroy() };
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / iOS play HLS natively
    video.src = src;
    return { destroy: () => { video.removeAttribute('src'); video.load(); } };
  }
  return null;
}

function setLayout(cols) {
  $('#grid').style.setProperty('--cols', cols);
  for (const b of document.querySelectorAll('#layout-picker button')) b.classList.toggle('active', b.dataset.cols === String(cols));
  try { localStorage.setItem('nvr.cols', cols); } catch { /* storage unavailable */ }
}
$('#live-group').addEventListener('change', (e) => {
  try { localStorage.setItem('nvr.group', e.target.value); } catch { /* ignore */ }
  renderLive();
});
$('#layout-picker').addEventListener('click', (e) => { if (e.target.dataset.cols) setLayout(e.target.dataset.cols); });

function tileStatus(cam) {
  const s = cam.status.state;
  return el('span', { class: 'badges' },
    el('span', { class: `badge ${s}` }, stateLabel[s] || s),
    cam.record && s === 'running' ? el('span', { class: 'badge rec', style: 'margin-left:10px' }, 'REC') : null);
}

async function renderLive() {
  stopLive();
  let saved = 2;
  try { saved = localStorage.getItem('nvr.cols') || 2; } catch { /* ignore */ }
  setLayout(saved);
  const allCams = await loadCameras();
  const groups = [...new Set(allCams.map((c) => c.group).filter(Boolean))].sort();
  const gsel = $('#live-group');
  let group = gsel.value;
  if (!group) { try { group = localStorage.getItem('nvr.group') || ''; } catch { /* ignore */ } }
  if (group && !groups.includes(group)) group = '';
  gsel.hidden = groups.length === 0;
  gsel.replaceChildren(el('option', { value: '' }, 'All cameras'), ...groups.map((g) => el('option', { value: g }, g)));
  gsel.value = group;
  const cams = group ? allCams.filter((c) => c.group === group) : allCams;
  const grid = $('#grid');
  grid.replaceChildren();
  $('#live-empty').hidden = allCams.length > 0;

  for (const cam of cams) {
    const video = el('video', { muted: true, autoplay: true, playsinline: true });
    video.muted = true;
    const overlay = el('div', { class: 'overlay' });
    const status = el('span');
    const tile = el('div', { class: 'tile', 'data-id': cam.id, tabindex: 0 },
      video, overlay,
      el('div', { class: 'label' }, el('strong', {}, cam.name), status),
      el('div', { class: 'tools' },
        el('button', { class: 'small', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen()) }, 'Fullscreen'),
        el('button', { class: 'small', onclick: () => { location.hash = `#/recordings?cam=${encodeURIComponent(cam.id)}`; } }, 'Recordings')));
    tile.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen()));
    grid.append(tile);
    tile._update = (c) => {
      status.replaceChildren(tileStatus(c));
      const running = c.status.state === 'running';
      overlay.hidden = running;
      overlay.textContent = !c.enabled ? 'Camera disabled'
        : c.status.lastError ? `${stateLabel[c.status.state] || ''}\n${c.status.lastError.split('\n').pop()}`
        : stateLabel[c.status.state] || '';
      if (running && !tile._player) {
        tile._player = attachHls(video, `/live/${encodeURIComponent(c.id)}/index.m3u8`);
        if (tile._player) state.players.push(tile._player);
        else tile._player = { unsupported: true };
      }
      if (tile._player?.unsupported) {
        overlay.hidden = false;
        overlay.textContent = 'This browser cannot play H.264 video. Use Chrome, Edge, Firefox or Safari.';
      }
    };
    tile._update(cam);
  }

  // Refresh status badges every few seconds.
  state.pollTimer = setInterval(async () => {
    if (state.view !== 'live') return;
    const cams2 = await loadCameras().catch(() => null);
    if (!cams2) return;
    if (cams2.map((c) => c.id + c.group).join() !== allCams.map((c) => c.id + c.group).join()) return renderLive();
    for (const c of cams2) $(`.tile[data-id="${CSS.escape(c.id)}"]`)?._update(c);
  }, 4000);
}

// ---------------------------------------------------------------- recordings
const recState = { list: [], playing: null };

async function renderRecordings() {
  const cams = await loadCameras();
  const sel = $('#rec-camera');
  const wanted = new URLSearchParams(location.hash.split('?')[1] || '').get('cam') || sel.value;
  sel.replaceChildren(...cams.map((c) => el('option', { value: c.id }, c.name)));
  if (!cams.length) {
    $('#rec-date').replaceChildren();
    $('#rec-list').replaceChildren(el('p', { class: 'empty' }, 'No cameras configured.'));
    return;
  }
  if (cams.some((c) => c.id === wanted)) sel.value = wanted;
  await loadDates();
}

async function loadDates() {
  const id = $('#rec-camera').value;
  const dates = await api('GET', `/api/cameras/${encodeURIComponent(id)}/dates`);
  const dsel = $('#rec-date');
  const prev = dsel.value;
  dsel.replaceChildren(...dates.map((d) => el('option', { value: d }, fmtDate(d))));
  if (dates.includes(prev)) dsel.value = prev;
  if (!dates.length) {
    $('#rec-list').replaceChildren(el('p', { class: 'empty' }, 'No recordings for this camera yet.'));
    return;
  }
  await loadRecordings();
}

async function loadRecordings() {
  const id = $('#rec-camera').value;
  const date = $('#rec-date').value;
  recState.list = await api('GET', `/api/cameras/${encodeURIComponent(id)}/recordings?date=${date}`);
  recState.camera = id;
  const list = $('#rec-list');
  list.replaceChildren();
  let lastHour = null;
  for (const r of recState.list) {
    const hour = new Date(r.start).getHours();
    if (hour !== lastHour) {
      list.append(el('div', { class: 'hour' }, `${String(hour).padStart(2, '0')}:00`));
      lastHour = hour;
    }
    const url = `/api/recordings/${encodeURIComponent(id)}/${encodeURIComponent(r.name)}`;
    list.append(el('div', { class: `rec-item${recState.playing === r.name ? ' playing' : ''}`, 'data-name': r.name },
      el('div', {},
        el('button', { class: 'time', disabled: r.inProgress, onclick: () => play(r.name) }, fmtTime(r.start)),
        el('div', { class: 'meta' }, r.inProgress ? 'Recording now…' : fmtBytes(r.size))),
      el('div', { class: 'acts' },
        r.inProgress ? null : el('a', { class: 'small', href: `${url}?download=1`, title: 'Download' }, '⤓'),
        r.inProgress ? null : el('button', { class: 'small ghost danger', title: 'Delete', onclick: () => delRecording(r.name) }, '✕'))));
  }
}

function play(name) {
  const r = recState.list.find((x) => x.name === name);
  if (!r || r.inProgress) return;
  recState.playing = name;
  const player = $('#rec-player');
  player.src = `/api/recordings/${encodeURIComponent(recState.camera)}/${encodeURIComponent(name)}`;
  player.play().catch(() => {});
  const cam = state.cameras.find((c) => c.id === recState.camera);
  $('#rec-now').textContent = `${cam ? cam.name : recState.camera} — ${new Date(r.start).toLocaleString()}`;
  for (const item of document.querySelectorAll('.rec-item')) item.classList.toggle('playing', item.dataset.name === name);
}

// Continue to the next segment automatically.
$('#rec-player').addEventListener('ended', () => {
  const i = recState.list.findIndex((x) => x.name === recState.playing);
  const next = recState.list[i + 1];
  if (next && !next.inProgress) play(next.name);
});

async function delRecording(name) {
  if (!confirm(`Delete recording ${name}?`)) return;
  await api('DELETE', `/api/recordings/${encodeURIComponent(recState.camera)}/${encodeURIComponent(name)}`);
  if (recState.playing === name) { $('#rec-player').removeAttribute('src'); $('#rec-player').load(); }
  await loadRecordings();
}

$('#rec-camera').addEventListener('change', loadDates);
$('#rec-date').addEventListener('change', loadRecordings);

// ---------------------------------------------------------------- cameras
const form = $('#cam-form');

function openForm(cam) {
  form.reset();
  form.hidden = false;
  $('#dvr-form').hidden = true;
  $('#cam-form-error').textContent = '';
  showTest($('#cam-test-result'), null);
  $('#cam-form-title').textContent = cam ? `Edit ${cam.name}` : 'Add camera';
  form.elements.id.value = cam ? cam.id : '';
  form.elements.password.placeholder = cam && cam.hasPassword ? '(unchanged)' : '';
  if (cam) {
    for (const k of ['name', 'url', 'username', 'segmentMinutes', 'group']) form.elements[k].value = cam[k] ?? '';
    for (const k of ['enabled', 'record', 'audio', 'transcode']) form.elements[k].checked = Boolean(cam[k]);
  }
  form.elements.name.focus();
}

$('#add-camera').addEventListener('click', () => openForm(null));

/** Show the result of a /api/probe call under a form. */
function showTest(node, r) {
  node.className = 'test-result';
  if (!r) { node.textContent = ''; return; }
  if (r.pending) { node.textContent = 'Connecting… (this can take up to 15 seconds)'; return; }
  if (r.ok) {
    const v = r.video;
    let msg = `✓ Connected: ${v.codec.toUpperCase()} ${v.width}×${v.height}${r.audio ? `, audio ${r.audio.codec}` : ''}`;
    if (v.codec !== 'h264') msg += '\nNote: this is not H.264, so browsers may not show it. Tick "Transcode to H.264", or set the camera/DVR to H.264.';
    node.textContent = msg;
    node.classList.add('ok');
  } else {
    node.textContent = `✗ ${r.error}`;
    node.classList.add('bad');
  }
}

async function runTest(button, node, body) {
  button.disabled = true;
  showTest(node, { pending: true });
  try {
    showTest(node, await api('POST', '/api/probe', body));
  } catch (err) {
    showTest(node, { ok: false, error: err.message });
  } finally {
    button.disabled = false;
  }
}

$('#cam-test').addEventListener('click', () => {
  const f = form.elements;
  runTest($('#cam-test'), $('#cam-test-result'),
    { id: f.id.value, url: f.url.value, username: f.username.value, password: f.password.value });
});

// ---------------------------------------------------------------- DVR
const dvrForm = $('#dvr-form');
let dvrBrands = null;

function dvrBody() {
  const f = dvrForm.elements;
  return {
    name: f.name.value, brand: f.brand.value, host: f.host.value.trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, ''),
    port: Number(f.port.value), username: f.username.value, password: f.password.value,
    channels: Number(f.channels.value), stream: f.stream.value, template: f.template.value,
    record: f.record.checked, audio: f.audio.checked,
  };
}

function updateDvrPreview() {
  const b = dvrBody();
  $('#dvr-template-row').hidden = b.brand !== 'custom';
  const brand = dvrBrands?.find((x) => x.id === b.brand);
  const pattern = b.brand === 'custom' ? b.template : brand?.[b.stream];
  if (!pattern || !b.host) { $('#dvr-preview').textContent = ''; return; }
  const url = (ch) => pattern.replaceAll('{host}', b.host).replaceAll('{port}', b.port)
    .replaceAll('{ch2}', String(ch).padStart(2, '0')).replaceAll('{ch}', ch);
  $('#dvr-preview').textContent = b.channels > 1
    ? `Will add ${b.channels} cameras, e.g. channel 1: ${url(1)}`
    : `Will add 1 camera: ${url(1)}`;
}

$('#add-dvr').addEventListener('click', async () => {
  if (!dvrBrands) {
    dvrBrands = await api('GET', '/api/dvr/brands');
    $('#dvr-brand').replaceChildren(...dvrBrands.map((b) => el('option', { value: b.id }, b.label)));
  }
  form.hidden = true;
  dvrForm.reset();
  dvrForm.hidden = false;
  $('#dvr-form-error').textContent = '';
  showTest($('#dvr-test-result'), null);
  updateDvrPreview();
  dvrForm.elements.name.focus();
});
dvrForm.addEventListener('input', updateDvrPreview);
$('#dvr-cancel').addEventListener('click', () => { dvrForm.hidden = true; });
$('#dvr-test').addEventListener('click', () => {
  runTest($('#dvr-test'), $('#dvr-test-result'), { ...dvrBody(), dvr: true });
});

dvrForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#dvr-form-error').textContent = '';
  try {
    await api('POST', '/api/dvr', dvrBody());
    dvrForm.hidden = true;
    renderCameras();
  } catch (err) {
    $('#dvr-form-error').textContent = err.message;
  }
});
$('#cam-cancel').addEventListener('click', () => { form.hidden = true; });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const body = {
    name: f.name.value, url: f.url.value, username: f.username.value, password: f.password.value, group: f.group.value,
    segmentMinutes: Number(f.segmentMinutes.value),
    enabled: f.enabled.checked, record: f.record.checked, audio: f.audio.checked, transcode: f.transcode.checked,
  };
  try {
    if (f.id.value) await api('PUT', `/api/cameras/${encodeURIComponent(f.id.value)}`, body);
    else await api('POST', '/api/cameras', body);
    form.hidden = true;
    renderCameras();
  } catch (err) {
    $('#cam-form-error').textContent = err.message;
  }
});

async function renderCameras() {
  const cams = await loadCameras();
  const tbody = $('#cam-table tbody');
  tbody.replaceChildren(...cams.map((c) => el('tr', {},
    el('td', {}, el('strong', {}, c.name), el('div', { class: 'muted' }, c.group ? `${c.group} · ${c.id}` : c.id)),
    el('td', { class: 'src' }, c.url),
    el('td', {},
      el('span', { class: `badge ${c.status.state}` }, stateLabel[c.status.state] || c.status.state),
      c.status.restarts ? el('div', { class: 'muted' }, `${c.status.restarts} reconnect(s)`) : null,
      c.status.lastError ? el('div', { class: 'err' }, c.status.lastError) : null),
    el('td', {}, c.record ? `${c.segmentMinutes} min segments${c.audio ? ' + audio' : ''}` : 'Live only'),
    el('td', { class: 'row-acts' },
      el('button', { class: 'small', onclick: () => openForm(c) }, 'Edit'), ' ',
      el('button', { class: 'small', onclick: async () => { await api('POST', `/api/cameras/${encodeURIComponent(c.id)}/restart`); renderCameras(); } }, 'Restart'), ' ',
      el('button', { class: 'small danger', onclick: () => deleteCamera(c) }, 'Delete')))));
  if (!cams.length) tbody.append(el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No cameras yet.')));
}

async function deleteCamera(c) {
  if (!confirm(`Remove camera "${c.name}"?`)) return;
  const wipe = confirm('Also delete all of its recordings from disk?\n\nOK = delete recordings, Cancel = keep them');
  await api('DELETE', `/api/cameras/${encodeURIComponent(c.id)}${wipe ? '?deleteRecordings=1' : ''}`);
  renderCameras();
}

// ---------------------------------------------------------------- storage
async function renderSystem() {
  const [s, cams] = await Promise.all([api('GET', '/api/system'), loadCameras()]);
  const used = s.disk.total - s.disk.free;
  const pct = s.disk.total ? Math.round((used / s.disk.total) * 100) : 0;
  const stat = (label, value, extra) => el('div', { class: 'card stat' }, el('div', { class: 'muted' }, label), el('div', { class: 'v' }, value), extra || null);
  const r = s.retention;
  $('#system-info').replaceChildren(
    stat('Disk used', `${pct}%`, el('div', {}, el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` })), el('div', { class: 'muted', style: 'margin-top:6px' }, `${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}`))),
    stat('Recordings', fmtBytes(s.recordingsBytes), el('div', { class: 'muted' }, `${s.recordingsCount} files`)),
    stat('Oldest recording', s.oldest ? new Date(s.oldest).toLocaleString() : '—'),
    stat('Retention', r.days ? `${r.days} days` : 'Forever', el('div', { class: 'muted' },
      [r.maxStorageGb ? `Max ${r.maxStorageGb} GB` : null, r.minFreeGb ? `Keep ${r.minFreeGb} GB free` : null].filter(Boolean).join(' · ') || 'No size limit')),
    ...cams.map((c) => stat(c.name, fmtBytes(s.perCamera[c.id] || 0))),
  );
}

// ---------------------------------------------------------------- boot
async function start() {
  $('#login-view').hidden = true;
  $('#app').hidden = false;
  route();
}

(async () => {
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({}));
  if (me.user) start(); else showLogin();
})();
