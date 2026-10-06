const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STALL_SECONDS = 30;
const MAX_BACKOFF_MS = 60_000;

/** Escape a value for use inside an ffmpeg tee muxer slave spec. */
function teeEscape(s) {
  return String(s).replace(/([\\:|[\]=])/g, '\\$1');
}

/** Build the input URL, inserting credentials if they are stored separately. */
function inputUrl(cam) {
  if (!cam.username || cam.url.startsWith('/dev/')) return cam.url;
  try {
    const u = new URL(cam.url);
    u.username = encodeURIComponent(cam.username);
    u.password = encodeURIComponent(cam.password || '');
    return u.toString();
  } catch {
    return cam.url;
  }
}

/**
 * Build ffmpeg arguments for a camera. A single ffmpeg process reads the camera
 * once and writes both a rolling HLS live stream and segmented MP4 recordings
 * (via the tee muxer), so the camera only sees one connection.
 */
function buildArgs(cam, { liveDir, recordingsDir }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-nostats'];
  const url = inputUrl(cam);

  if (url.startsWith('/dev/')) {
    args.push('-f', 'v4l2', '-i', url);
  } else {
    if (/^rtsps?:/i.test(url)) args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
    else if (/^https?:/i.test(url)) args.push('-rw_timeout', '10000000', '-reconnect', '1');
    args.push('-fflags', '+genpts', '-i', url);
  }

  // Analog/USB capture devices produce raw frames and must always be encoded.
  const transcode = cam.transcode || url.startsWith('/dev/');

  args.push('-map', '0:v:0');
  if (transcode) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-g', '50', '-sc_threshold', '0');
  } else {
    args.push('-c:v', 'copy');
  }
  if (cam.audio) {
    // Most cameras send G.711 audio, which MP4/HLS cannot carry: convert to AAC.
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k');
  } else {
    args.push('-an');
  }

  const camLive = path.join(liveDir, cam.id);
  const outputs = [
    '[f=hls:hls_time=2:hls_list_size=6:hls_flags=delete_segments+omit_endlist:onfail=ignore' +
      `:hls_segment_filename=${teeEscape(path.join(camLive, 'seg_%06d.ts'))}]` +
      teeEscape(path.join(camLive, 'index.m3u8')),
  ];
  if (cam.record) {
    const camRec = path.join(recordingsDir, cam.id);
    outputs.push(
      `[f=segment:segment_time=${cam.segmentMinutes * 60}:segment_atclocktime=1` +
        ':reset_timestamps=1:strftime=1:segment_format=mp4]' +
        teeEscape(path.join(camRec, '%Y-%m-%d_%H-%M-%S.mp4')),
    );
  }
  args.push('-f', 'tee', outputs.join('|'));
  return args;
}

/** Hide passwords from anything that might be logged or shown in the UI. */
function redact(text, cam) {
  let out = String(text).replace(/(\w+:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@');
  if (cam.password) out = out.split(cam.password).join('***');
  if (cam.password) out = out.split(encodeURIComponent(cam.password)).join('***');
  return out;
}

class CameraWorker {
  constructor(cam, opts) {
    this.cam = cam;
    this.opts = opts;
    this.proc = null;
    this.state = 'stopped';
    this.since = Date.now();
    this.restarts = 0;
    this.backoff = 2000;
    this.lastError = '';
    this.stderrTail = [];
    this.wanted = false;
    this.retryTimer = null;
    this.watchdog = null;
  }

  setState(s) {
    if (this.state !== s) { this.state = s; this.since = Date.now(); }
  }

  start() {
    this.wanted = true;
    if (this.proc || this.retryTimer) return;
    this.spawn();
  }

  spawn() {
    this.retryTimer = null;
    const { liveDir, recordingsDir, ffmpegPath } = this.opts;
    const camLive = path.join(liveDir, this.cam.id);
    fs.rmSync(camLive, { recursive: true, force: true });
    fs.mkdirSync(camLive, { recursive: true });
    fs.mkdirSync(path.join(recordingsDir, this.cam.id), { recursive: true });

    const args = buildArgs(this.cam, { liveDir, recordingsDir });
    this.setState('starting');
    this.stderrTail = [];
    const startedAt = Date.now();
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(redact(line.trim(), this.cam));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });

    proc.on('error', (err) => {
      this.lastError = `failed to launch ffmpeg: ${err.message}`;
    });

    proc.on('exit', (code, signal) => {
      clearInterval(this.watchdog);
      this.proc = null;
      if (!this.wanted) { this.setState('stopped'); return; }
      const tail = this.stderrTail.slice(-5).join('\n');
      if (!this.lastError || tail) this.lastError = tail || `ffmpeg exited (code ${code}, signal ${signal})`;
      // Reset the backoff if the stream had been healthy for a while.
      if (Date.now() - startedAt > 120_000) this.backoff = 2000;
      this.restarts++;
      this.setState('retrying');
      this.retryTimer = setTimeout(() => this.spawn(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });

    // Watchdog: mark running once the live playlist appears, and kill ffmpeg
    // if the stream stalls without ffmpeg noticing (e.g. a half-open socket).
    const playlist = path.join(camLive, 'index.m3u8');
    this.watchdog = setInterval(() => {
      let mtime = 0;
      try { mtime = fs.statSync(playlist).mtimeMs; } catch { /* not yet written */ }
      if (mtime && Date.now() - mtime < STALL_SECONDS * 1000) {
        if (this.state !== 'running') { this.setState('running'); this.lastError = ''; }
      } else if (Date.now() - Math.max(mtime, startedAt) > STALL_SECONDS * 1000) {
        this.lastError = `no video received for ${STALL_SECONDS}s`;
        clearInterval(this.watchdog);
        // SIGINT lets ffmpeg write the MP4 index so the partial file stays playable.
        proc.kill('SIGINT');
        setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
      }
    }, 2000);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.proc) { this.setState('stopped'); return Promise.resolve(); }
    const proc = this.proc;
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
      // 'q' is not available with -nostdin; SIGINT lets ffmpeg finalise the MP4.
      proc.kill('SIGINT');
    });
  }

  status() {
    return {
      state: this.state,
      since: this.since,
      restarts: this.restarts,
      lastError: this.state === 'running' ? '' : this.lastError,
    };
  }
}

class RecorderManager {
  constructor(opts) {
    this.opts = opts;
    this.workers = new Map();
  }

  /** Bring running workers in line with the camera list. */
  async sync(cameras) {
    const ids = new Set(cameras.map((c) => c.id));
    for (const [id, w] of this.workers) {
      if (!ids.has(id)) { await w.stop(); this.workers.delete(id); }
    }
    for (const cam of cameras) {
      const existing = this.workers.get(cam.id);
      if (existing && JSON.stringify(existing.cam) !== JSON.stringify(cam)) {
        await existing.stop();
        this.workers.delete(cam.id);
      }
      if (!this.workers.has(cam.id)) this.workers.set(cam.id, new CameraWorker({ ...cam }, this.opts));
      const w = this.workers.get(cam.id);
      if (cam.enabled) w.start(); else await w.stop();
    }
  }

  async restart(id) {
    const w = this.workers.get(id);
    if (!w) return;
    await w.stop();
    w.restarts = 0;
    w.backoff = 2000;
    if (w.cam.enabled) w.start();
  }

  status(id) {
    const w = this.workers.get(id);
    return w ? w.status() : { state: 'stopped', since: Date.now(), restarts: 0, lastError: '' };
  }

  async stopAll() {
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
  }
}

module.exports = { RecorderManager, buildArgs, inputUrl, redact, teeEscape };
