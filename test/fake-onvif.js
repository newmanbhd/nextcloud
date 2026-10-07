const http = require('http');
const crypto = require('crypto');
const assert = require('node:assert');

// A fake 2-channel ONVIF DVR. It validates WS-Security digests like a real
// device, and reports its own (different) LAN IP in addresses it returns.
function fakeDevice({ password = 'pw', httpDigestOnly = false } = {}) {
  const env = (body) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const authOk = (req, xml) => {
    if (httpDigestOnly) return /^Digest /.test(req.headers.authorization || '');
    const nonce = /<Nonce[^>]*>([^<]+)</.exec(xml)?.[1];
    const created = /<Created[^>]*>([^<]+)</.exec(xml)?.[1];
    const digest = /<Password[^>]*>([^<]+)</.exec(xml)?.[1];
    if (!nonce) return false;
    const want = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(password)])).digest('base64');
    return want === digest;
  };
  const profile = (tok, src, w, h) => `<trt:Profiles token="${tok}" fixed="true"><tt:Name>${tok}</tt:Name>`
    + `<tt:VideoSourceConfiguration token="vsc_${src}"><tt:Name>vs</tt:Name><tt:SourceToken>${src}</tt:SourceToken></tt:VideoSourceConfiguration>`
    + `<tt:VideoEncoderConfiguration token="ve_${tok}"><tt:Name>enc</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${w}</tt:Width><tt:Height>${h}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>`;
  return http.createServer((req, res) => {
    let xml = '';
    req.on('data', (d) => { xml += d; });
    req.on('end', () => {
      const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/soap+xml', ...headers }); res.end(env(body)); };
      if (/GetSystemDateAndTime/.test(xml)) {
        const d = new Date();
        return send(200, `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
      }
      if (!authOk(req, xml)) {
        if (httpDigestOnly) return send(401, '', { 'WWW-Authenticate': 'Digest realm="dvr", nonce="abc", qop="auth"' });
        return send(400, '<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text>Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>');
      }
      if (/GetCapabilities/.test(xml)) return send(200, '<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://10.9.9.9:80/onvif/Media</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>');
      if (/GetDeviceInformation/.test(xml)) return send(200, '<tds:GetDeviceInformationResponse><tds:Manufacturer>TVT</tds:Manufacturer><tds:Model>TD-2716TE</tds:Model></tds:GetDeviceInformationResponse>');
      if (/GetProfiles/.test(xml)) {
        assert.strictEqual(req.url, '/onvif/Media');
        return send(200, `<trt:GetProfilesResponse>${profile('ch1_main', 'vs1', 1920, 1080)}${profile('ch1_sub', 'vs1', 704, 576)}${profile('ch2_main', 'vs2', 2560, 1440)}${profile('ch2_sub', 'vs2', 640, 360)}</trt:GetProfilesResponse>`);
      }
      if (/GetStreamUri/.test(xml)) {
        const tok = /<ProfileToken>([^<]+)</.exec(xml)[1];
        const [ch, type] = tok.replace('ch', '').split('_');
        return send(200, `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.9.9.9:554/chID=${ch}&amp;streamType=${type}&amp;linkType=tcp</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
      }
      send(400, '');
    });
  });
}

module.exports = { fakeDevice };

if (require.main === module) {
  // Run standalone for manual UI testing: node test/fake-onvif.js 8899
  fakeDevice().listen(Number(process.argv[2] || 8899), () => console.log('fake ONVIF device up'));
}
