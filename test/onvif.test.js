const test = require('node:test');
const assert = require('node:assert');
const { discoverStreams, parseProfiles } = require('../src/onvif');

const { fakeDevice } = require('./fake-onvif');

async function withDevice(opts, fn) {
  const srv = fakeDevice(opts).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try { return await fn(srv.address().port); } finally { srv.close(); }
}

test('discovers channels and streams from an ONVIF DVR', () => withDevice({}, async (port) => {
  const r = await discoverStreams({ host: '127.0.0.1', port, username: 'admin', password: 'pw' });
  assert.deepStrictEqual(r.device, { manufacturer: 'TVT', model: 'TD-2716TE' });
  assert.strictEqual(r.streams.length, 4);
  const main = r.streams.filter((s) => s.main);
  assert.deepStrictEqual(main.map((s) => s.channel), [1, 2]);
  // Device-reported IP is replaced by the one the user entered; & is unescaped
  assert.strictEqual(main[0].url, 'rtsp://127.0.0.1:554/chID=1&streamType=main&linkType=tcp');
  assert.strictEqual(main[1].width, 2560);
}));

test('wrong password gives a clear message', () => withDevice({}, async (port) => {
  await assert.rejects(discoverStreams({ host: '127.0.0.1', port, username: 'admin', password: 'nope' }), /Wrong username or password/);
}));

test('falls back to HTTP digest authentication', () => withDevice({ httpDigestOnly: true }, async (port) => {
  const r = await discoverStreams({ host: '127.0.0.1', port, username: 'admin', password: 'pw' });
  assert.strictEqual(r.streams.length, 4);
}));

test('unreachable port gives a clear message', async () => {
  await assert.rejects(discoverStreams({ host: '127.0.0.1', port: 1, username: 'a', password: 'b' }), /refused the connection/);
});

test('rejects a URL typed into the IP field gracefully', () => withDevice({}, async (port) => {
  const r = await discoverStreams({ host: 'http://127.0.0.1/', port, username: 'admin', password: 'pw' });
  assert.strictEqual(r.streams.length, 4);
}));

test('parseProfiles ignores profiles without a token', () => {
  assert.deepStrictEqual(parseProfiles('<x:Profiles><x:Name>bad</x:Name></x:Profiles>'), []);
});
