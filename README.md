# CamVault NVR

A self-hosted web app that connects to your CCTV and IP cameras, records their video to your server's disk, and gives you a browser-based view screen for live viewing and playback.

- **Live view**: a 1 / 2×2 / 3×3 / 4×4 camera grid in the browser, with fullscreen
- **Continuous recording**: each camera is saved as MP4 files in fixed-length segments (10 minutes by default), aligned to the clock
- **Playback**: browse recordings by camera and date, play them in the browser (the next segment starts automatically), download or delete them
- **Automatic retention**: deletes the oldest footage by age, by a total size cap, or when free disk space runs low
- **Resilient**: reconnects automatically when a camera drops, with backoff and a stall watchdog. Recordings are finalised cleanly on shutdown.
- **Secure by default**: login required for everything, camera passwords are never sent to the browser, and failed logins are rate-limited

## How it works

```
 IP camera ─┐  RTSP/HTTP                 ┌─► data/recordings/<camera>/2026-10-06_14-30-00.mp4
 DVR / NVR ─┼──────────► ffmpeg (1 per ──┤
 Capture   ─┘            camera)         └─► data/live/<camera>/index.m3u8  ──► browser (hls.js)
 card (/dev/video0)
```

The server runs one `ffmpeg` process per camera. It opens a single connection to the camera and writes two outputs at once: segmented MP4 recordings and a short rolling HLS stream for the live view. For H.264 cameras the video is **copied, not re-encoded**, so CPU usage stays very low, even on a Raspberry Pi or a small NAS.

## Quick start (Docker)

```bash
cp .env.example .env        # then set ADMIN_PASSWORD (and RECORDINGS_PATH to a big disk)
docker compose up -d --build
```

Open `http://<server-ip>:8080`, sign in, go to **Cameras → Add camera**, and paste the camera's stream URL.

## Quick start (without Docker)

You need Node.js 20 or later and ffmpeg (`apt install ffmpeg`).

```bash
npm ci
ADMIN_PASSWORD='something-long' RECORDINGS_PATH=/mnt/cctv node src/server.js
```

To run it as a service, use a systemd unit with `ExecStart=/usr/bin/node /opt/camvault/src/server.js`, `Environment=ADMIN_PASSWORD=...` and `KillSignal=SIGTERM`.

## Connecting cameras

### IP cameras

Most IP cameras provide an RTSP stream. Enter the URL without credentials and put the username and password in their own fields. Typical URLs:

| Brand | Main stream URL |
|---|---|
| Hikvision / Annke / HiLook | `rtsp://IP:554/Streaming/Channels/101` (sub-stream: `102`) |
| Dahua / Amcrest / Lorex | `rtsp://IP:554/cam/realmonitor?channel=1&subtype=0` |
| Reolink | `rtsp://IP:554/h264Preview_01_main` |
| Uniview | `rtsp://IP:554/unicast/c1/s0/live` |
| Axis | `rtsp://IP/axis-media/media.amp` |
| TP-Link Tapo / VIGI | `rtsp://IP:554/stream1` (create a "camera account" in the app first) |
| Ubiquiti UniFi Protect | Enable RTSP per camera in Protect, then use the `rtsps://IP:7441/...` URL it shows |
| Generic ONVIF | Use ONVIF Device Manager to find the RTSP URL |

You can check a URL first with `ffprobe rtsp://user:pass@IP:554/...`.

### Analog CCTV cameras (coax / BNC)

Analog cameras don't speak IP. You have two options:

1. **Through your existing DVR (recommended).** Almost every DVR (Hikvision, Dahua and similar) exposes each channel over RTSP, e.g. `rtsp://DVR-IP:554/Streaming/Channels/301` for channel 3. Add each channel as a camera.
2. **Capture card / USB video grabber** in the server. Use `/dev/video0` (`/dev/video1`, ...) as the URL. With Docker, uncomment the `devices:` section in `docker-compose.yml`. Capture devices are always encoded to H.264, which uses some CPU.

### Codec tips

- **H.264** works everywhere with no transcoding. Use it where the camera lets you choose.
- **H.265 / HEVC** cameras still record fine, but many browsers can't play H.265. Either switch the camera to H.264, or tick **Transcode to H.264** (this costs CPU).
- Camera audio (usually G.711) is converted to AAC when **Record audio** is ticked.
- For lots of cameras, consider recording the main stream and using a lower-resolution camera, or add the camera's sub-stream as a second, live-only camera (untick "Record to disk").

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_USER` | `admin` | Login username |
| `ADMIN_PASSWORD` | *(required)* | Login password |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` | Camera config, session secret and live buffers |
| `RECORDINGS_DIR` | `$DATA_DIR/recordings` | Where MP4 files are stored |
| `RETENTION_DAYS` | `14` | Delete recordings older than this (0 = never) |
| `MAX_STORAGE_GB` | `0` | Keep total recordings under this size (0 = no cap) |
| `MIN_FREE_GB` | `5` | Delete the oldest recordings if free space drops below this |
| `SESSION_HOURS` | `12` | Login duration |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary |

Recordings are plain MP4 files named `<camera-id>/YYYY-MM-DD_HH-MM-SS.mp4` (server local time), so you can also open them in VLC or back them up with any tool.

## Storage planning

The rough storage per camera per day is `bitrate (Mbps) × 10.8 GB`:

| Stream | Typical bitrate | Per day | 14 days |
|---|---|---|---|
| 1080p H.264 | 4 Mbps | ~43 GB | ~600 GB |
| 4MP H.264 | 6 Mbps | ~65 GB | ~900 GB |
| 1080p H.265 | 2 Mbps | ~22 GB | ~300 GB |

Use a dedicated disk for `RECORDINGS_PATH`, ideally a surveillance-rated drive.

## Using it with Nextcloud

Because recordings are ordinary files, you can make them browsable in Nextcloud: enable the **External storage support** app and add a *Local* mount pointing at your recordings folder (mount it read-only in the Nextcloud container). The NVR stays responsible for recording and retention, and Nextcloud gives you file access and sharing.

## Security

- Don't port-forward this directly to the internet. Use a VPN (WireGuard or Tailscale) or put it behind a reverse proxy with HTTPS (Caddy, nginx, Traefik) and set `TRUST_PROXY=1`.
- Put cameras on their own VLAN or network without internet access where possible.
- Camera credentials are stored in `data/cameras.json` (mode 600) and are never returned by the API.

## Development

```bash
npm ci
npm test          # unit + API tests (node:test)
ADMIN_PASSWORD=dev npm start
```

Project layout:

```
src/server.js     Express app and REST API
src/recorder.js   ffmpeg process manager (one worker per camera)
src/retention.js  Disk clean-up
src/cameras.js    Camera config store and validation
src/auth.js       Signed-cookie login
public/           Browser UI (vanilla JS + hls.js)
```

Live view latency is roughly 4–8 seconds, which is normal for HLS.
