const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildArgs, inputUrl, redact } = require('../src/recorder');
const { validate, toPublic, CameraStore } = require('../src/cameras');
const retention = require('../src/retention');

const dirs = { liveDir: '/data/live', recordingsDir: '/data/rec' };
const cam = (o = {}) => ({ id: 'front', name: 'Front', url: 'rtsp://10.0.0.5/stream', username: '', password: '',
  enabled: true, record: true, audio: false, transcode: false, segmentMinutes: 10, ...o });

test('rtsp camera: tcp transport, copy codec, live + record outputs', () => {
  const a = buildArgs(cam(), dirs);
  assert.deepStrictEqual(a.slice(a.indexOf('-rtsp_transport'), a.indexOf('-rtsp_transport') + 2), ['-rtsp_transport', 'tcp']);
  assert.ok(a.includes('copy'));
  assert.ok(a.includes('-an'));
  const tee = a[a.length - 1];
  assert.match(tee, /f=hls/);
  assert.match(tee, /segment_time=600/);
  assert.match(tee, /\/data\/rec\/front\/%Y-%m-%d_%H-%M-%S\.mp4$/);
});

test('record disabled produces only the live output', () => {
  const tee = buildArgs(cam({ record: false }), dirs).at(-1);
  assert.doesNotMatch(tee, /f=segment/);
});

test('capture devices are always transcoded', () => {
  const a = buildArgs(cam({ url: '/dev/video0' }), dirs);
  assert.deepStrictEqual(a.slice(a.indexOf('-f'), a.indexOf('-f') + 4), ['-f', 'v4l2', '-i', '/dev/video0']);
  assert.ok(a.includes('libx264'));
});

test('audio is converted to AAC', () => {
  const a = buildArgs(cam({ audio: true }), dirs);
  assert.ok(a.includes('aac'));
  assert.ok(!a.includes('-an'));
});

test('credentials are injected and URL-encoded', () => {
  assert.strictEqual(inputUrl(cam({ username: 'admin', password: 'p@ss:w/rd' })), 'rtsp://admin:p%40ss%3Aw%2Frd@10.0.0.5/stream');
});

test('redact hides passwords', () => {
  const c = cam({ password: 'hunter2' });
  assert.strictEqual(redact('rtsp://admin:hunter2@10.0.0.5/x failed', c), 'rtsp://admin:***@10.0.0.5/x failed');
  assert.strictEqual(redact('bad auth hunter2', c), 'bad auth ***');
});

test('validation rejects bad URLs and segment lengths', () => {
  assert.ok(validate({ name: 'x', url: 'file:///etc/passwd' }).errors.length);
  assert.ok(validate({ name: 'x', url: '-i /etc/passwd' }).errors.length);
  assert.ok(validate({ name: 'x', url: 'rtsp://a/b', segmentMinutes: 0 }).errors.length);
  assert.deepStrictEqual(validate({ name: 'x', url: 'rtsp://a/b' }).errors, []);
});

test('public camera view omits the password', () => {
  const p = toPublic(cam({ password: 'secret' }));
  assert.strictEqual(p.password, undefined);
  assert.strictEqual(p.hasPassword, true);
});

test('camera store: unique ids, password kept on blank update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-'));
  const s = new CameraStore(path.join(dir, 'c.json'));
  const a = s.add({ name: 'Back Yard', url: 'rtsp://a/1', password: 'pw' }).camera;
  const b = s.add({ name: 'Back Yard', url: 'rtsp://a/2' }).camera;
  assert.strictEqual(a.id, 'back-yard');
  assert.strictEqual(b.id, 'back-yard-2');
  s.update(a.id, { password: '' });
  assert.strictEqual(new CameraStore(path.join(dir, 'c.json')).get(a.id).password, 'pw');
});

test('retention deletes recordings older than the limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-'));
  const camDir = path.join(dir, 'front');
  fs.mkdirSync(camDir);
  const old = new Date(Date.now() - 20 * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const name = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.mp4`;
  const oldFile = path.join(camDir, name(old));
  const newFile = path.join(camDir, name(new Date(Date.now() - 3600_000)));
  for (const f of [oldFile, newFile]) {
    fs.writeFileSync(f, 'x');
    const t = new Date(Date.now() - 3600_000);
    fs.utimesSync(f, t, t);
  }
  const r = retention.enforce({ recordingsDir: dir, retentionDays: 14, maxStorageGb: 0, minFreeGb: 0 }, { log() {}, warn() {} });
  assert.strictEqual(r.deleted, 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));
});
