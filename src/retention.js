const fs = require('fs');
const path = require('path');

const FILE_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/;
const GB = 1024 ** 3;

/** Parse a recording filename into its start time (server local time). */
function parseRecordingName(name) {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const [y, mo, d] = m[1].split('-').map(Number);
  return new Date(y, mo - 1, d, Number(m[2]), Number(m[3]), Number(m[4]));
}

/** List every recording file under the recordings dir, oldest first. */
function listAll(recordingsDir) {
  const out = [];
  let camDirs = [];
  try { camDirs = fs.readdirSync(recordingsDir, { withFileTypes: true }); } catch { return out; }
  for (const dir of camDirs) {
    if (!dir.isDirectory()) continue;
    const camPath = path.join(recordingsDir, dir.name);
    for (const name of fs.readdirSync(camPath)) {
      const start = parseRecordingName(name);
      if (!start) continue;
      try {
        const st = fs.statSync(path.join(camPath, name));
        out.push({ camera: dir.name, name, file: path.join(camPath, name), start, size: st.size, mtime: st.mtimeMs });
      } catch { /* deleted meanwhile */ }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function diskStats(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

/**
 * Delete recordings that are too old, then the oldest recordings until both the
 * storage cap and the minimum free space are satisfied. Files modified in the
 * last minute are never deleted because ffmpeg may still be writing them.
 */
function enforce(cfg, log = console) {
  const files = listAll(cfg.recordingsDir);
  const now = Date.now();
  const deletable = (f) => now - f.mtime > 60_000;
  let total = files.reduce((s, f) => s + f.size, 0);
  let deleted = 0;

  const del = (f) => {
    try {
      fs.unlinkSync(f.file);
      total -= f.size;
      f.gone = true;
      deleted++;
    } catch (e) {
      log.warn(`retention: could not delete ${f.file}: ${e.message}`);
    }
  };

  if (cfg.retentionDays > 0) {
    const cutoff = now - cfg.retentionDays * 86_400_000;
    for (const f of files) if (f.start.getTime() < cutoff && deletable(f)) del(f);
  }

  const overCap = () => cfg.maxStorageGb > 0 && total > cfg.maxStorageGb * GB;
  const lowDisk = () => cfg.minFreeGb > 0 && diskStats(cfg.recordingsDir).free < cfg.minFreeGb * GB;
  for (const f of files) {
    if (!overCap() && !lowDisk()) break;
    if (!f.gone && deletable(f)) del(f);
  }

  if (deleted) log.log(`retention: deleted ${deleted} recording(s)`);
  return { deleted, totalBytes: total };
}

module.exports = { enforce, listAll, parseRecordingName, diskStats, FILE_RE };
