const { spawn } = require('child_process');
const { inputUrl, redact } = require('./recorder');

/**
 * Try to open a camera stream with ffprobe and report what it sends.
 * Resolves { ok, video?, audio?, error? }; never rejects.
 */
function probe(cam, { ffprobePath = 'ffprobe', timeoutMs = 15000 } = {}) {
  const url = inputUrl(cam);
  const args = ['-v', 'error'];
  if (url.startsWith('/dev/')) args.push('-f', 'v4l2');
  else if (/^rtsps?:/i.test(url)) args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  else args.push('-rw_timeout', '10000000');
  args.push('-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', url);

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let proc;
    try {
      proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: `could not run ffprobe: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { err += e.message; });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return resolve({ ok: false, error: 'No answer from the camera within 15 seconds. Check the IP address and port.' });
      let streams = [];
      try { streams = JSON.parse(out).streams || []; } catch { /* no JSON */ }
      const video = streams.find((s) => s.codec_type === 'video');
      if (code !== 0 || !video) {
        return resolve({ ok: false, error: explain(redact(err.trim() || `ffprobe exited with code ${code}`, cam)) });
      }
      const audio = streams.find((s) => s.codec_type === 'audio');
      resolve({
        ok: true,
        video: { codec: video.codec_name, width: video.width, height: video.height },
        audio: audio ? { codec: audio.codec_name } : null,
      });
    });
  });
}

/** Add a plain-English hint to common ffprobe errors. */
function explain(msg) {
  const hints = [
    [/401|Unauthorized/i, 'Wrong username or password.'],
    [/404|Not Found|454|Session Not Found/i, 'The DVR answered but this stream address or channel does not exist.'],
    [/Connection refused/i, 'The device refused the connection. Check the port (RTSP is usually 554) and that RTSP is enabled on the DVR.'],
    [/No route to host|Network is unreachable|timed out|Connection timed out/i, 'Cannot reach that IP address from the server.'],
  ];
  const hint = hints.find(([re]) => re.test(msg));
  return hint ? `${hint[1]}\n(${msg.split('\n').pop()})` : msg;
}

module.exports = { probe, explain };
