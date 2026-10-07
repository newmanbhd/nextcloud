const test = require('node:test');
const assert = require('node:assert');
const { planDvr } = require('../src/dvr');
const { explain } = require('../src/probe');

const base = { name: 'Shop DVR', brand: 'hikvision', host: '192.168.1.64', username: 'admin', password: 'pw', channels: 4 };

test('hikvision DVR creates one camera per channel', () => {
  const { cameras } = planDvr(base);
  assert.strictEqual(cameras.length, 4);
  assert.strictEqual(cameras[0].url, 'rtsp://192.168.1.64:554/Streaming/Channels/101');
  assert.strictEqual(cameras[3].url, 'rtsp://192.168.1.64:554/Streaming/Channels/401');
  assert.strictEqual(cameras[0].name, 'Shop DVR Ch 1');
  assert.strictEqual(cameras[0].group, 'Shop DVR');
  assert.strictEqual(cameras[0].password, 'pw');
});

test('channel 10+ and sub streams', () => {
  const { cameras } = planDvr({ ...base, channels: 16, stream: 'sub' });
  assert.strictEqual(cameras[15].url, 'rtsp://192.168.1.64:554/Streaming/Channels/1602');
});

test('dahua, uniview and reolink patterns', () => {
  assert.strictEqual(planDvr({ ...base, brand: 'dahua', channels: 1 }).cameras[0].url,
    'rtsp://192.168.1.64:554/cam/realmonitor?channel=1&subtype=0');
  assert.strictEqual(planDvr({ ...base, brand: 'uniview', channels: 1, stream: 'sub' }).cameras[0].url,
    'rtsp://192.168.1.64:554/unicast/c1/s1/live');
  assert.strictEqual(planDvr({ ...base, brand: 'reolink', channels: 1, port: 8554 }).cameras[0].url,
    'rtsp://192.168.1.64:8554/h264Preview_01_main');
});

test('TVT pattern (e.g. DVR-AT2716TE)', () => {
  const { cameras } = planDvr({ ...base, brand: 'tvt', channels: 16 });
  assert.strictEqual(cameras[0].url, 'rtsp://192.168.1.64:554/chID=1&streamType=main&linkType=tcp');
  assert.strictEqual(cameras[15].url, 'rtsp://192.168.1.64:554/chID=16&streamType=main&linkType=tcp');
  assert.strictEqual(planDvr({ ...base, brand: 'tvt', channels: 1, stream: 'sub' }).cameras[0].url,
    'rtsp://192.168.1.64:554/chID=1&streamType=sub&linkType=tcp');
});

test('custom pattern with zero-padded channels', () => {
  const { cameras } = planDvr({ ...base, brand: 'custom', template: 'rtsp://{host}:{port}/ch{ch2}/0', channels: 2 });
  assert.deepStrictEqual(cameras.map((c) => c.url), ['rtsp://192.168.1.64:554/ch01/0', 'rtsp://192.168.1.64:554/ch02/0']);
});

test('rejects bad input', () => {
  assert.ok(planDvr({ ...base, host: 'rtsp://192.168.1.64' }).errors);
  assert.ok(planDvr({ ...base, host: '1.2.3.4 -i x' }).errors);
  assert.ok(planDvr({ ...base, channels: 0 }).errors);
  assert.ok(planDvr({ ...base, brand: 'nope' }).errors);
  assert.ok(planDvr({ ...base, brand: 'custom', template: 'rtsp://{host}/live' }).errors);
});

test('probe errors get plain-English hints', () => {
  assert.match(explain('method DESCRIBE failed: 401 Unauthorized'), /Wrong username or password/);
  assert.match(explain('Connection to tcp://1.2.3.4:554 failed: Connection refused'), /refused/);
});
