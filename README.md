# FluxPlayer

FluxPlayer is a modern web-based media player designed for high-compatibility playback of MKV, MP4, HLS and other formats in the browser. It includes an MKV demuxer + remuxer pipeline that can stream MKV content through Media Source Extensions (MSE) and a fallback path that uses FFmpeg WebAssembly to remux unsupported formats.

> **AI Disclaimer:** This project contains content created or edited with AI assistance. Review and validate all functionality before production use.

## Features

- Native playback of MP4/WebM/HLS in supported browsers
- Custom MKV playback pipeline using demuxing + remuxing into fMP4 fragments
- FFmpeg fallback path for unsupported codecs (transcodes audio as needed)
- Multi-audio track support and track switching UI
- Simple UI controls (play/pause, seek, volume, fullscreen)

## Local development

### Install dependencies

```bash
npm install
```

### Run development server

```bash
npm run dev
```

Then open the URL printed in the terminal (usually `http://localhost:5173`).

## Building for production

```bash
npm run build
```

The built output will be in the `dist` directory.

## Project structure

- `src/` — application source code
  - `main.js` — app entry point and UI binding
  - `engine.js` — core player engine (source detection, playback logic, FFmpeg fallback)
  - `pipeline/` — media pipeline implementation
    - `mkv-demuxer.js` — parses MKV and builds cluster index
    - `mp4-muxer.js` — generates fMP4 fragments from demuxed frames
    - `stream-controller.js` — manages MSE buffers and playback loops
    - `data-source.js` — file/range loader

- `public/ffmpeg/` — FFmpeg WebAssembly assets used for fallback remux

## How MKV playback works

1. The engine detects the source type (MKV, MP4, HLS, etc.).
2. For MKV:
   - It parses the MKV structure and builds a cluster index.
   - It streams clusters through a remuxer into fMP4 fragments and feeds them to MSE.
   - If the MKV uses codecs that cannot be remuxed directly to MP4 (e.g., Vorbis), it uses an FFmpeg WASM fallback path.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

This project is provided as-is. No license is included.
