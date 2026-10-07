const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-api-'));
process.env.DATA_DIR = dataDir;
const cfg = require('../src/config');
const { createApp } = require('../src/server');
const { CameraStore } = require('../src/cameras');
const { createAuth } = require('../src/auth');

// A recorder stub: these tests exercise the HTTP layer, not ffmpeg.
const recorder = { sync: async () => {}, restart: async () => {}, status: () => ({ state: 'stopped' }) };
const probed = [];
const probe = async (cam) => { probed.push(cam); return { ok: true, video: { codec: 'h264', width: 1920, height: 1080 }, audio: null }; };

let base;
let server;
test.before(async () => {
  fs.mkdirSync(cfg.recordingsDir, { recursive: true });
  const store = new CameraStore(cfg.camerasFile);
  const auth = createAuth({ user: 'admin', password: 'pw', secret: 'test-secret', sessionHours: 1 });
  server = createApp({ store, recorder, auth, probe }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const login = async (password = 'pw') => fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }),
});

test('API requires login', async () => {
  assert.strictEqual((await fetch(`${base}/api/cameras`)).status, 401);
  assert.strictEqual((await fetch(`${base}/live/x/index.m3u8`)).status, 401);
});

test('wrong password is rejected', async () => {
  assert.strictEqual((await login('nope')).status, 401);
});

test('camera CRUD and recordings listing', async () => {
  const res = await login();
  assert.strictEqual(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const h = { cookie, 'Content-Type': 'application/json' };

  const created = await fetch(`${base}/api/cameras`, { method: 'POST', headers: h,
    body: JSON.stringify({ name: 'Driveway', url: 'rtsp://10.0.0.9/live', username: 'u', password: 'secret' }) });
  assert.strictEqual(created.status, 201);
  const cam = await created.json();
  assert.strictEqual(cam.password, undefined);

  const list = await (await fetch(`${base}/api/cameras`, { headers: h })).json();
  assert.strictEqual(list.length, 1);
  assert.ok(!JSON.stringify(list).includes('secret'));

  fs.mkdirSync(path.join(cfg.recordingsDir, cam.id), { recursive: true });
  fs.writeFileSync(path.join(cfg.recordingsDir, cam.id, '2026-01-02_03-04-05.mp4'), 'data');
  const dates = await (await fetch(`${base}/api/cameras/${cam.id}/dates`, { headers: h })).json();
  assert.deepStrictEqual(dates, ['2026-01-02']);
  const recs = await (await fetch(`${base}/api/cameras/${cam.id}/recordings?date=2026-01-02`, { headers: h })).json();
  assert.strictEqual(recs[0].name, '2026-01-02_03-04-05.mp4');

  const file = await fetch(`${base}/api/recordings/${cam.id}/2026-01-02_03-04-05.mp4`, { headers: h });
  assert.strictEqual(await file.text(), 'data');

  // Path traversal attempts never reach the filesystem
  for (const bad of ['..%2F..%2Fcameras.json', '%2E%2E', 'x.mp4']) {
    const r = await fetch(`${base}/api/recordings/${cam.id}/${bad}`, { headers: h });
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
  }
  assert.strictEqual((await fetch(`${base}/api/recordings/..%2F/2026-01-02_03-04-05.mp4`, { headers: h })).status, 404);

  const del = await fetch(`${base}/api/cameras/${cam.id}?deleteRecordings=1`, { method: 'DELETE', headers: h });
  assert.strictEqual(del.status, 200);
  assert.ok(!fs.existsSync(path.join(cfg.recordingsDir, cam.id)));
});

test('add a DVR creates a camera per channel; probe uses saved password', async () => {
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const h = { cookie, 'Content-Type': 'application/json' };
  const r = await fetch(`${base}/api/dvr`, { method: 'POST', headers: h, body: JSON.stringify({
    name: 'Shop DVR', brand: 'dahua', host: '10.0.0.20', username: 'admin', password: 'dvrpw', channels: 3 }) });
  assert.strictEqual(r.status, 201);
  const cams = await r.json();
  assert.deepStrictEqual(cams.map((c) => c.id), ['shop-dvr-ch-1', 'shop-dvr-ch-2', 'shop-dvr-ch-3']);
  assert.ok(cams.every((c) => c.group === 'Shop DVR' && c.hasPassword && c.password === undefined));

  const bad = await fetch(`${base}/api/dvr`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'x', brand: 'dahua', host: '', channels: 2 }) });
  assert.strictEqual(bad.status, 400);

  // Testing an existing camera with a blank password uses the stored one
  const p = await (await fetch(`${base}/api/probe`, { method: 'POST', headers: h, body: JSON.stringify({
    id: 'shop-dvr-ch-2', url: cams[1].url, username: 'admin', password: '' }) })).json();
  assert.strictEqual(p.ok, true);
  assert.strictEqual(probed.at(-1).password, 'dvrpw');

  // Testing a DVR before adding it probes its first channel
  await fetch(`${base}/api/probe`, { method: 'POST', headers: h, body: JSON.stringify({
    dvr: true, name: 'New', brand: 'hikvision', host: '10.0.0.30', channels: 8 }) });
  assert.strictEqual(probed.at(-1).url, 'rtsp://10.0.0.30:554/Streaming/Channels/101');
});
