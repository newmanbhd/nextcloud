// URL patterns for adding every channel of a DVR/NVR at once.
// {host}, {port}, {ch} (1, 2, ...) and {ch2} (01, 02, ...) are substituted.
const BRANDS = {
  hikvision: {
    label: 'Hikvision / HiLook / Annke / Swann (Hik-based)',
    main: 'rtsp://{host}:{port}/Streaming/Channels/{ch}01',
    sub: 'rtsp://{host}:{port}/Streaming/Channels/{ch}02',
  },
  dahua: {
    label: 'Dahua / Amcrest / Lorex / IMOU',
    main: 'rtsp://{host}:{port}/cam/realmonitor?channel={ch}&subtype=0',
    sub: 'rtsp://{host}:{port}/cam/realmonitor?channel={ch}&subtype=1',
  },
  uniview: {
    label: 'Uniview (UNV)',
    main: 'rtsp://{host}:{port}/unicast/c{ch}/s0/live',
    sub: 'rtsp://{host}:{port}/unicast/c{ch}/s1/live',
  },
  tvt: {
    label: 'TVT (incl. DVR-AT / TD-27xx and rebadged TVT units)',
    main: 'rtsp://{host}:{port}/chID={ch}&streamType=main&linkType=tcp',
    sub: 'rtsp://{host}:{port}/chID={ch}&streamType=sub&linkType=tcp',
  },
  reolink: {
    label: 'Reolink NVR',
    main: 'rtsp://{host}:{port}/h264Preview_{ch2}_main',
    sub: 'rtsp://{host}:{port}/h264Preview_{ch2}_sub',
  },
  custom: { label: 'Other (enter the address pattern yourself)' },
};

const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$|^\[[0-9a-fA-F:]+\]$/;

function channelUrl({ brand, host, port, stream, template }, ch) {
  const pattern = brand === 'custom' ? template : BRANDS[brand][stream];
  return pattern
    .replaceAll('{host}', host)
    .replaceAll('{port}', String(port))
    .replaceAll('{ch2}', String(ch).padStart(2, '0'))
    .replaceAll('{ch}', String(ch));
}

/** Validate a DVR request and return the list of cameras to create. */
function planDvr(input) {
  const errors = [];
  const name = String(input.name ?? '').trim();
  const brand = String(input.brand ?? '');
  const host = String(input.host ?? '').trim();
  const port = Number(input.port ?? 554);
  const channels = Number(input.channels);
  const firstChannel = Number(input.firstChannel ?? 1);
  const stream = input.stream === 'sub' ? 'sub' : 'main';
  const template = String(input.template ?? '').trim();

  if (!name || name.length > 60) errors.push('DVR name is required (max 60 chars)');
  if (!BRANDS[brand]) errors.push('choose a DVR brand');
  if (!HOST_RE.test(host)) errors.push('enter the DVR IP address or host name (without rtsp://)');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be 1-65535');
  if (!Number.isInteger(channels) || channels < 1 || channels > 64) errors.push('channels must be 1-64');
  if (!Number.isInteger(firstChannel) || firstChannel < 0 || firstChannel > 64) errors.push('first channel must be 0-64');
  if (brand === 'custom') {
    if (!/^rtsps?:\/\//i.test(template) || !template.includes('{ch')) {
      errors.push('the address pattern must start with rtsp:// and contain {ch} or {ch2}');
    }
  }
  if (errors.length) return { errors };

  const opts = { brand, host, port, stream, template };
  const cameras = [];
  for (let i = 0; i < channels; i++) {
    const ch = firstChannel + i;
    cameras.push({
      name: `${name} Ch ${ch}`,
      group: name,
      url: channelUrl(opts, ch),
      username: String(input.username ?? ''),
      password: String(input.password ?? ''),
      record: input.record !== false,
      audio: Boolean(input.audio),
      transcode: Boolean(input.transcode),
      enabled: true,
    });
  }
  return { cameras };
}

module.exports = { BRANDS, channelUrl, planDvr };
