const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const cfg = require('./config');
const { CameraStore, toPublic, ID_RE } = require('./cameras');
const { RecorderManager } = require('./recorder');
const retention = require('./retention');
const { createAuth } = require('./auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function loadSecret() {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  const file = path.join(cfg.dataDir, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function createApp({ store, recorder, auth }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // --- public ---
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/vendor/hls.min.js', (req, res) => {
    res.sendFile(require.resolve('hls.js/dist/hls.min.js'));
  });
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);
  app.get('/api/me', (req, res) => {
    const s = auth.verify(req);
    res.json(s ? { user: s.u } : { user: null });
  });

  // --- everything below requires a session ---
  const priv = express.Router();
  priv.use(auth.requireAuth);

  const camParam = (req, res) => {
    const cam = ID_RE.test(req.params.id) && store.get(req.params.id);
    if (!cam) res.status(404).json({ error: 'Camera not found' });
    return cam;
  };

  const withStatus = (cam) => ({ ...toPublic(cam), status: recorder.status(cam.id) });

  priv.get('/api/cameras', (req, res) => {
    res.json(store.list().map(withStatus));
  });

  priv.post('/api/cameras', async (req, res) => {
    const r = store.add(req.body || {});
    if (r.errors) return res.status(400).json({ error: r.errors.join('; ') });
    await recorder.sync(store.list());
    res.status(201).json(withStatus(r.camera));
  });

  priv.put('/api/cameras/:id', async (req, res) => {
    if (!camParam(req, res)) return;
    const r = store.update(req.params.id, req.body || {});
    if (r.errors) return res.status(400).json({ error: r.errors.join('; ') });
    await recorder.sync(store.list());
    res.json(withStatus(r.camera));
  });

  priv.delete('/api/cameras/:id', async (req, res) => {
    const cam = camParam(req, res);
    if (!cam) return;
    store.remove(cam.id);
    await recorder.sync(store.list());
    fs.rmSync(path.join(cfg.liveDir, cam.id), { recursive: true, force: true });
    if (req.query.deleteRecordings === '1') {
      fs.rmSync(path.join(cfg.recordingsDir, cam.id), { recursive: true, force: true });
    }
    res.json({ ok: true });
  });

  priv.post('/api/cameras/:id/restart', async (req, res) => {
    if (!camParam(req, res)) return;
    await recorder.restart(req.params.id);
    res.json({ ok: true });
  });

  const camFiles = (id) => {
    const dir = path.join(cfg.recordingsDir, id);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none yet */ }
    return names.filter((n) => retention.FILE_RE.test(n)).sort();
  };

  priv.get('/api/cameras/:id/dates', (req, res) => {
    const cam = camParam(req, res);
    if (!cam) return;
    const dates = [...new Set(camFiles(cam.id).map((n) => n.slice(0, 10)))].reverse();
    res.json(dates);
  });

  priv.get('/api/cameras/:id/recordings', (req, res) => {
    const cam = camParam(req, res);
    if (!cam) return;
    const date = String(req.query.date || '');
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const all = camFiles(cam.id);
    const newest = all[all.length - 1];
    const running = recorder.status(cam.id).state === 'running';
    const list = all.filter((n) => n.startsWith(date)).map((name) => {
      let size = 0;
      try { size = fs.statSync(path.join(cfg.recordingsDir, cam.id, name)).size; } catch { /* gone */ }
      return {
        name,
        start: retention.parseRecordingName(name).toISOString(),
        size,
        // The newest file is still being written and has no MP4 index yet.
        inProgress: running && cam.record && name === newest,
      };
    });
    res.json(list);
  });

  const recFile = (req, res) => {
    const cam = camParam(req, res);
    if (!cam) return null;
    if (!retention.FILE_RE.test(req.params.file)) {
      res.status(400).json({ error: 'Bad file name' });
      return null;
    }
    return path.join(cfg.recordingsDir, cam.id, req.params.file);
  };

  priv.get('/api/recordings/:id/:file', (req, res) => {
    const file = recFile(req, res);
    if (!file) return;
    if (req.query.download === '1') res.attachment(`${req.params.id}_${req.params.file}`);
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Recording not found' });
    });
  });

  priv.delete('/api/recordings/:id/:file', (req, res) => {
    const file = recFile(req, res);
    if (!file) return;
    try {
      fs.unlinkSync(file);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Recording not found' });
    }
  });

  priv.get('/api/system', (req, res) => {
    const files = retention.listAll(cfg.recordingsDir);
    const perCamera = {};
    for (const f of files) perCamera[f.camera] = (perCamera[f.camera] || 0) + f.size;
    res.json({
      disk: retention.diskStats(cfg.recordingsDir),
      recordingsBytes: files.reduce((s, f) => s + f.size, 0),
      recordingsCount: files.length,
      oldest: files[0]?.start ?? null,
      perCamera,
      retention: { days: cfg.retentionDays, maxStorageGb: cfg.maxStorageGb, minFreeGb: cfg.minFreeGb },
    });
  });

  // Live HLS playlists and segments
  priv.get('/live/:id/:file', (req, res) => {
    const { id, file } = req.params;
    if (!ID_RE.test(id) || !/^(index\.m3u8|seg_\d+\.ts)$/.test(file)) return res.status(404).end();
    res.sendFile(path.join(cfg.liveDir, id, file), {
      headers: { 'Cache-Control': 'no-cache' },
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.use(priv);
  return app;
}

async function main() {
  if (!cfg.adminPassword) {
    console.error('ADMIN_PASSWORD must be set (see .env.example). Refusing to start without a login password.');
    process.exit(1);
  }
  for (const d of [cfg.dataDir, cfg.recordingsDir, cfg.liveDir]) fs.mkdirSync(d, { recursive: true });

  const store = new CameraStore(cfg.camerasFile);
  const recorder = new RecorderManager({
    liveDir: cfg.liveDir, recordingsDir: cfg.recordingsDir, ffmpegPath: cfg.ffmpegPath,
  });
  const auth = createAuth({
    user: cfg.adminUser, password: cfg.adminPassword, secret: loadSecret(), sessionHours: cfg.sessionHours,
  });

  const app = createApp({ store, recorder, auth });
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`NVR listening on http://${cfg.host}:${cfg.port} (recordings: ${cfg.recordingsDir})`);
  });

  await recorder.sync(store.list());

  const runRetention = () => {
    try { retention.enforce(cfg); } catch (e) { console.error('retention failed:', e); }
  };
  runRetention();
  const timer = setInterval(runRetention, cfg.retentionIntervalMin * 60_000);

  const shutdown = async () => {
    console.log('Shutting down, finalising recordings...');
    clearInterval(timer);
    server.close();
    await recorder.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp };
