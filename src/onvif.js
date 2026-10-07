// Minimal ONVIF client: asks a camera/DVR for its media profiles and the RTSP
// address of each one, so users don't need to know the brand's URL format.
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/;
const TIMEOUT_MS = 8000;

const NS = {
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
};

class OnvifError extends Error {}

// ---------------------------------------------------------------- XML helpers
// ONVIF responses use varying namespace prefixes, so match on local names only.
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function tag(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? m[1] : null;
}
const text = (xml, name) => {
  const v = xml && tag(xml, name);
  return v === null || v === undefined ? '' : unescapeXml(v.replace(/<[^>]+>/g, '').trim());
};
function blocks(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g');
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1], body: m[2] }));
}
const attr = (attrs, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unescapeXml(m[1]) : '';
};

// ---------------------------------------------------------------- SOAP
function wsSecurity(username, password, clockOffsetMs) {
  if (!username) return '';
  const nonce = crypto.randomBytes(16);
  const created = new Date(Date.now() + clockOffsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password || '')])).digest('base64');
  return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
    + `<UsernameToken><Username>${escapeXml(username)}</Username>`
    + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
    + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
    + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
    + '</UsernameToken></Security></s:Header>';
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: TIMEOUT_MS,
      // Cameras almost always use self-signed certificates.
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 2_000_000) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new OnvifError('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** HTTP Digest (RFC 2617) Authorization header, used by devices that reject WS-Security alone. */
function digestHeader(wwwAuth, { username, password }, method, uri) {
  const p = {};
  for (const m of wwwAuth.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3];
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${username}:${p.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (p.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  let h = `Digest username="${username}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (p.opaque) h += `, opaque="${p.opaque}"`;
  return h;
}

async function soap(url, bodyXml, creds, clockOffsetMs = 0) {
  const envelope = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
    + wsSecurity(creds.username, creds.password, clockOffsetMs)
    + `<s:Body>${bodyXml}</s:Body></s:Envelope>`;
  let res;
  try {
    res = await httpPost(url, envelope, {});
    const challenge = res.headers['www-authenticate'];
    if (res.status === 401 && creds.username && /^Digest/i.test(challenge || '')) {
      const u = new URL(url);
      res = await httpPost(url, envelope, { Authorization: digestHeader(challenge, creds, 'POST', u.pathname + u.search) });
    }
  } catch (e) {
    throw new OnvifError(networkHint(e));
  }
  if (res.status >= 200 && res.status < 300) return res.body;
  const fault = text(res.body, 'Reason') || text(res.body, 'faultstring') || text(res.body, 'Subcode');
  if (res.status === 401 || /NotAuthorized|not authorized|Sender not Authorized|authority failure/i.test(res.body)) {
    throw new OnvifError('Wrong username or password (the device refused the ONVIF login). Some DVRs need ONVIF enabled and an ONVIF user created in their network settings.');
  }
  if (res.status === 404) throw new OnvifError('The device answered, but has no ONVIF service at this port. Check the ONVIF port and that ONVIF is enabled on the device.');
  throw new OnvifError(`The device returned an error${fault ? `: ${fault}` : ` (HTTP ${res.status})`}`);
}

function networkHint(e) {
  const msg = e.message || String(e);
  if (/timeout/i.test(msg)) return 'No answer from the device within 8 seconds. Check the IP address and ONVIF port.';
  if (/ECONNREFUSED/.test(msg)) return 'The device refused the connection on that port. Check the ONVIF port (often 80, 8000, 8080 or 8899) and that ONVIF is enabled.';
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Cannot reach that IP address from the server.';
  return `Could not connect: ${msg}`;
}

// ---------------------------------------------------------------- ONVIF calls
function parseDeviceTime(xml) {
  const utc = tag(xml, 'UTCDateTime');
  if (!utc) return null;
  const n = (k) => Number(text(utc, k));
  const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
  return Number.isFinite(t) ? t : null;
}

/** Point a URL the device reports at the host the user actually entered (fixes NAT / wrong-NIC addresses). */
function rehost(rawUrl, host, port) {
  const u = new URL(rawUrl);
  u.hostname = host;
  if (port !== undefined) u.port = String(port);
  u.username = '';
  u.password = '';
  return u.toString();
}

function parseProfiles(xml) {
  return blocks(xml, 'Profiles').map(({ attrs, body }) => {
    const enc = tag(body, 'VideoEncoderConfiguration') || '';
    const res = tag(enc, 'Resolution') || '';
    const src = tag(body, 'VideoSourceConfiguration') || '';
    return {
      token: attr(attrs, 'token'),
      name: text(body, 'Name'),
      source: text(src, 'SourceToken'),
      encoding: text(enc, 'Encoding').toLowerCase(),
      width: Number(text(res, 'Width')) || 0,
      height: Number(text(res, 'Height')) || 0,
    };
  }).filter((p) => p.token);
}

/**
 * Connect to an ONVIF device and list its video streams.
 * Returns { device: {manufacturer, model}, streams: [{channel, main, name, encoding, width, height, url}] }.
 */
async function discoverStreams({ host, port = 80, username = '', password = '', https: useHttps = false }) {
  host = String(host || '').trim().replace(/^\w+:\/\//, '').replace(/[/:].*$/, '');
  port = Number(port);
  if (!HOST_RE.test(host)) throw new OnvifError('Enter the device IP address (e.g. 192.168.1.64), without http:// or rtsp://');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OnvifError('ONVIF port must be 1-65535');
  const creds = { username: String(username), password: String(password) };
  const deviceUrl = `${useHttps ? 'https' : 'http'}://${host}:${port}/onvif/device_service`;

  // Sync to the device's clock: WS-Security logins fail if the clocks differ by more than a few seconds.
  let offset = 0;
  try {
    const t = parseDeviceTime(await soap(deviceUrl, `<GetSystemDateAndTime xmlns="${NS.device}"/>`, {}));
    if (t) offset = t - Date.now();
  } catch (e) {
    if (/refused|reach|No answer|no ONVIF/.test(e.message)) throw e;
    // Some devices require auth even for this call; carry on with our own clock.
  }

  const caps = await soap(deviceUrl, `<GetCapabilities xmlns="${NS.device}"><Category>All</Category></GetCapabilities>`, creds, offset);
  const mediaXAddr = text(tag(caps, 'Media') || '', 'XAddr');
  const mediaUrl = mediaXAddr ? rehost(mediaXAddr, host, port) : deviceUrl;

  let device = { manufacturer: '', model: '' };
  try {
    const info = await soap(deviceUrl, `<GetDeviceInformation xmlns="${NS.device}"/>`, creds, offset);
    device = { manufacturer: text(info, 'Manufacturer'), model: text(info, 'Model') };
  } catch { /* optional */ }

  const profiles = parseProfiles(await soap(mediaUrl, `<GetProfiles xmlns="${NS.media}"/>`, creds, offset));
  if (!profiles.length) throw new OnvifError('The device has no video profiles over ONVIF.');

  // Number channels by video source, in the order the device lists them.
  const sources = [...new Set(profiles.map((p) => p.source || p.token))];
  const streams = [];
  for (const p of profiles) {
    const body = `<GetStreamUri xmlns="${NS.media}"><StreamSetup>`
      + `<Stream xmlns="${NS.schema}">RTP-Unicast</Stream><Transport xmlns="${NS.schema}"><Protocol>RTSP</Protocol></Transport>`
      + `</StreamSetup><ProfileToken>${escapeXml(p.token)}</ProfileToken></GetStreamUri>`;
    let uri;
    try {
      uri = text(await soap(mediaUrl, body, creds, offset), 'Uri');
    } catch {
      continue;
    }
    if (!/^rtsps?:\/\//i.test(uri)) continue;
    let rtspPort;
    try { rtspPort = new URL(uri).port || undefined; } catch { continue; }
    streams.push({
      channel: sources.indexOf(p.source || p.token) + 1,
      name: p.name,
      encoding: p.encoding,
      width: p.width,
      height: p.height,
      url: rehost(uri, host, rtspPort),
    });
  }
  if (!streams.length) throw new OnvifError('Connected over ONVIF, but the device did not give any RTSP stream addresses.');

  // The highest resolution stream of each channel is its main stream.
  for (const ch of new Set(streams.map((s) => s.channel))) {
    const list = streams.filter((s) => s.channel === ch);
    const best = list.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    for (const s of list) s.main = s === best;
  }
  return { device, streams };
}

module.exports = { discoverStreams, parseProfiles, parseDeviceTime, rehost, digestHeader, OnvifError };
