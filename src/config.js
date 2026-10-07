const path = require('path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  recordingsDir: path.resolve(process.env.RECORDINGS_DIR || path.join(dataDir, 'recordings')),
  liveDir: path.join(dataDir, 'live'),
  camerasFile: path.join(dataDir, 'cameras.json'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionHours: num(process.env.SESSION_HOURS, 12),
  // Retention: delete recordings older than this many days (0 = keep forever)
  retentionDays: num(process.env.RETENTION_DAYS, 14),
  // Retention: keep total recordings under this size in GB (0 = no limit)
  maxStorageGb: num(process.env.MAX_STORAGE_GB, 0),
  // Retention: always keep at least this much free disk space in GB (0 = disabled)
  minFreeGb: num(process.env.MIN_FREE_GB, 5),
  retentionIntervalMin: num(process.env.RETENTION_INTERVAL_MIN, 5),
};
