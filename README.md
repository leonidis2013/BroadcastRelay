# BroadcastRelay

A Docker relay for church live streaming, run from a web page. OBS (or an NDI source) sends **one** high-quality feed to BroadcastRelay on your TrueNAS server. BroadcastRelay sends it everywhere it needs to go, each destination with its own encode:

- **YouTube** and **Facebook**, through their APIs (it creates the broadcast with your title and ends it when you stop) or with a stream key
- **Any RTMP / RTMPS or SRT service** (Vimeo, Restream, another church…)
- **A web player** for the church website and overflow rooms: WebRTC on the LAN (under a second behind), HLS from the internet
- **NDI out**: the feed shows up on the network as an NDI source (for BroadcastDecode, vMix, OBS…)
- **Recording** of the raw input for troubleshooting, kept for a set number of days
- **Audio meters** (EBU R128 loudness and true peak) and a live preview of what is coming in
- **Bitfocus Companion** control through a small HTTP API

Part of the Broadcast series (BroadcastMaster, BroadcastDecode), with the same look as the Live apps.

```
                       ┌──────────────────────────── BroadcastRelay (one container) ───────────────────────────┐
 OBS ── SRT/RTMP/WHIP ─┤                                                                                         │
                       │  MediaMTX ── live ──┬── FFmpeg (per destination) ── RTMPS ─▶ YouTube, Facebook, RTMP/SRT│
 NDI source ── NDI ────┤  ndi-bridge+FFmpeg ─┘├── FFmpeg web encode ── web (HLS) / webrtc (WebRTC) ─▶ web player  │
                       │                      ├── FFmpeg + ndi-bridge ─▶ NDI out                                 │
                       │                      ├── recorder ─▶ /recordings (raw input, MP4 segments)             │
                       │                      └── meters (FFmpeg ebur128) ─▶ control page                        │
                       └─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Install on TrueNAS SCALE

1. Create a dataset for recordings, for example `tank/broadcastrelay/recordings`. Give **user 1000** write access (an ACL entry for user 1000), or set `RUN_UID`/`RUN_GID` to a user that already has access.
2. **Apps › Discover Apps › Custom App › Install via YAML**, and paste [`truenas-app.yaml`](truenas-app.yaml) with your dataset path.
3. Open `http://<truenas-ip>:9180` and choose a password.

Settings, sign-ins and stream keys are kept in the `broadcastrelay-data` Docker volume. Recordings go to the dataset.

The container uses **host networking** (NDI discovery and WebRTC need the server's real network). These ports must be free on the server:

| Port | Use |
|---|---|
| 9180/tcp | Control page (keep it on your network) |
| 9181/tcp | Web player (the one to publish through a reverse proxy or tunnel) |
| 8890/udp | SRT in from OBS |
| 1935/tcp | RTMP in from OBS |
| 8889/tcp | WHIP in from OBS, WebRTC signaling for the player |
| 8189/udp | WebRTC media to LAN viewers |
| 8554, 8888, 9997 | Internal only (127.0.0.1) |

`PORT` and `PUBLIC_PORT` are set in the app's environment; the rest on **Settings › Ports**.

Elsewhere: `docker compose up -d` with [`docker-compose.yml`](docker-compose.yml).

## OBS

**Settings › Input** shows the exact addresses with this server's IP. In OBS, **Settings › Stream**, Service **Custom…**:

- **SRT** (recommended on a LAN): Server `srt://<server>:8890?streamid=publish:live&latency=200000`, Stream key empty
- **RTMP**: Server `rtmp://<server>:1935/`, Stream key `live`
- **WHIP**: Service WHIP, Server `http://<server>:8889/live/whip`

Send what your best destination needs at a generous bitrate, and let BroadcastRelay make the smaller versions: for example 1080p30, CBR 8000–12000 kb/s, keyframe interval 2 s, AAC 320 kb/s 48 kHz. Only encoders on private networks may publish (change it under *Who may send*).

## Destinations

Each destination has its own video (resolution, frame rate, bitrate, x264 speed) and audio settings, or **Send the original**, which costs almost no CPU. Audio is passed through untouched when it is AAC (one less generation of compression) and re-encoded to AAC otherwise.

The **Go live** button starts every destination marked *Include in Go live* (and the web player). **End** stops them all and ends the YouTube/Facebook broadcasts. A destination whose stream drops keeps retrying (2, 4, 8 … 30 s), and when OBS reconnects everything resumes on its own.

### CPU

Encoding is done on the CPU. As a rough guide, a 1080p30 encode at *Very fast* uses 2–4 threads, 720p30 about half that. The top bar shows total CPU and each card shows what its encode uses. Use *Send the original* where a destination can take the OBS feed as it is.

### YouTube (account)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. OAuth consent screen: External; add your Google account as a test user (or publish the app).
3. Credentials › **Create OAuth client ID** › type **TVs and Limited Input devices**.
4. **Settings › YouTube**: paste the client ID and secret, Save, **Connect**, and enter the code shown at google.com/device.

Go live then creates a broadcast with the destination's title (it can use `{date}`, `{weekday}`, `{time}`), bound to a reusable stream, and YouTube starts it when video arrives. Stop completes it.

### Facebook (Page)

Either:

- **Sign in with a code**: create a Meta app (type Business), add *Facebook Login for Business* and turn on **Login from Devices**. Paste the App ID, the **Client token** (App settings › Advanced) and optionally the App secret (makes the sign-in long-lived) under **Settings › Facebook**, then **Connect** and enter the code at facebook.com/device. Pick the Page.
- **Paste a Page access token** (with `publish_video` and `pages_manage_posts`) and the Page ID.

Go live creates a live video on the Page with the title; Stop ends it. Or skip all this and use Facebook's persistent stream key.

## Web player

- `http://<server>:9181/` the player, `/embed` for an iframe (Settings › Web player has the embed code)
- On the LAN it plays over **WebRTC** (under a second, good for overflow rooms and lobby TVs). If WebRTC can't connect it falls back to **HLS** (a few seconds behind, works through anything).
- For viewers on the internet, publish **port 9181 only** through a reverse proxy or a Cloudflare Tunnel, and enter its address under *Public address*. Never publish 9180.

## NDI

- **NDI in**: Settings › Input › NDI, *Find sources*, pick one. The source is encoded to H.264 (you choose the bitrate) with uncompressed audio, and from there it is treated exactly like an OBS feed. If the source disappears, the last frame and silence keep flowing so the destinations stay connected.
- **NDI out**: Settings › NDI › Publish the feed as NDI. It appears as `BROADCASTRELAY-HOST (Program)`.
- NDI finds sources with mDNS, which does not cross VLANs. For sources on another VLAN, use an **NDI Discovery Server** or enter their IPs under Settings › NDI.
- The container runs its own mDNS responder (Avahi) by default. `NDI_AVAHI=host` uses the host's instead (mount `/var/run/dbus` from the host); `NDI_AVAHI=off` uses none (Discovery Server only).
- The image is built with the NDI SDK, downloaded during the build; building it means accepting the [NDI SDK license](https://ndi.video). Build with `--build-arg WITH_NDI=0` for an image without NDI. NDI® is a registered trademark of Vizrt NDI AB.

## Recording

The raw input is recorded exactly as it arrived, in fragmented MP4 segments (30 minutes by default) under `/recordings/live/`. Fragmented MP4 is playable even if the power fails mid-recording. Files older than the *keep* days are deleted, and an optional size limit deletes the oldest first. The **Files** button lists, downloads and deletes them.

## Bitfocus Companion

Use a **Generic HTTP** connection. Every request needs the token from **Settings › Companion**, as `Authorization: Bearer <token>` or `?token=<token>`.

| Request | Does |
|---|---|
| `POST /api/v1/golive` | Start every destination marked for Go live, and the web player |
| `POST /api/v1/end` | Stop every destination |
| `POST /api/v1/destinations/<name, id or number>/start` | also `stop`, `toggle` |
| `POST /api/v1/web/toggle` | also `start`, `stop` |
| `POST /api/v1/ndi-out/toggle` | also `start`, `stop` |
| `POST /api/v1/recording/toggle` | also `on`, `off` |
| `POST /api/v1/input/source/ndi` | or `stream` |
| `GET /api/v1/status` | `any_live`, `input_live`, `input_kbps`, `recording`, `web_viewers`, `loudness_short`, `cpu`, `destinations.<id>.live`… |

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | 9180 | Control page |
| `PUBLIC_PORT` | 9181 | Web player |
| `RUN_UID` / `RUN_GID` | 1000 | User the app runs as (needs write access to /recordings) |
| `NDI_AVAHI` | auto | `auto`, `host` or `off` |
| `BROADCASTRELAY_MASTER_KEY` | | Keeps the encryption key for saved keys and tokens out of the data volume |
| `TZ` | | Time zone for recording file names and titles |

## Development

No npm packages; Node 22.

```
npm run demo   # the whole app with pretend processes: http://localhost:9180
npm test       # unit tests; the NDI and FFmpeg tests run when gcc and ffmpeg are installed
```

Pushing to `main` runs the tests and publishes `ghcr.io/leonidis2013/broadcastrelay:latest` and `:<version>` (amd64 and arm64).

Built on [MediaMTX](https://github.com/bluenviron/mediamtx), [FFmpeg](https://ffmpeg.org) and [hls.js](https://github.com/video-dev/hls.js).

© Jerod Ulicki
