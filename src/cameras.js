const fs = require('fs');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const DEFAULTS = {
  name: '',
  url: '',
  username: '',
  password: '',
  enabled: true,
  record: true,
  audio: false,
  transcode: false,
  segmentMinutes: 10,
  group: '',
};

function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base || 'camera';
}

function validate(input, { partial = false } = {}) {
  const out = {};
  const errors = [];
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 80) errors.push('name is required (max 80 chars)');
    out.name = name;
  }
  if (!partial || input.url !== undefined) {
    const url = String(input.url ?? '').trim();
    const isDevice = url.startsWith('/dev/');
    if (!isDevice && !/^(rtsp|rtsps|rtmp|http|https|udp|srt):\/\//i.test(url)) {
      errors.push('url must be rtsp://, rtsps://, http(s)://, rtmp://, udp://, srt:// or a /dev/videoN capture device');
    }
    out.url = url;
  }
  if (input.group !== undefined) {
    const group = String(input.group).trim();
    if (group.length > 80) errors.push('group must be at most 80 chars');
    out.group = group;
  }
  for (const k of ['username', 'password']) {
    if (input[k] !== undefined) out[k] = String(input[k]);
  }
  for (const k of ['enabled', 'record', 'audio', 'transcode']) {
    if (input[k] !== undefined) out[k] = Boolean(input[k]);
  }
  if (input.segmentMinutes !== undefined) {
    const m = Number(input.segmentMinutes);
    if (!Number.isInteger(m) || m < 1 || m > 60) errors.push('segmentMinutes must be an integer 1-60');
    out.segmentMinutes = m;
  }
  return { value: out, errors };
}

/** Public view of a camera: never expose the stored password. */
function toPublic(cam) {
  const { password, ...rest } = cam;
  return { ...rest, hasPassword: Boolean(password) };
}

class CameraStore {
  constructor(file) {
    this.file = file;
    this.cameras = [];
    if (fs.existsSync(file)) {
      this.cameras = JSON.parse(fs.readFileSync(file, 'utf8')).map((c) => ({ ...DEFAULTS, ...c }));
    }
  }

  save() {
    const tmp = `${this.file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cameras, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() { return this.cameras; }

  get(id) { return this.cameras.find((c) => c.id === id); }

  add(input) {
    const { value, errors } = validate(input);
    if (errors.length) return { errors };
    let id = slugify(value.name);
    for (let i = 2; this.get(id); i++) id = `${slugify(value.name)}-${i}`;
    const cam = { ...DEFAULTS, ...value, id };
    this.cameras.push(cam);
    this.save();
    return { camera: cam };
  }

  update(id, input) {
    const cam = this.get(id);
    if (!cam) return { notFound: true };
    const { value, errors } = validate(input, { partial: true });
    if (errors.length) return { errors };
    // An empty password in an update means "keep the existing one".
    if (value.password === '') delete value.password;
    if (input.clearPassword) value.password = '';
    Object.assign(cam, value);
    this.save();
    return { camera: cam };
  }

  remove(id) {
    const before = this.cameras.length;
    this.cameras = this.cameras.filter((c) => c.id !== id);
    if (this.cameras.length !== before) this.save();
    return this.cameras.length !== before;
  }
}

module.exports = { CameraStore, validate, toPublic, slugify, ID_RE };
