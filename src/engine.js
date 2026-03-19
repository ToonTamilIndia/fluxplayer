import Hls from 'hls.js';
import { DataSource } from './pipeline/data-source.js';
import { MKVDemuxer } from './pipeline/mkv-demuxer.js';
import { MP4Muxer } from './pipeline/mp4-muxer.js';
import { StreamController } from './pipeline/stream-controller.js';
import { AudioTrackManager } from './pipeline/audio-track-manager.js';
import { SubtitleManager } from './pipeline/subtitle-manager.js';

export function detectSourceType(source) {
  if (typeof source === 'string') {
    const lower = source.toLowerCase();

    // HLS-specific patterns (check first, before stripping params)
    if (
      lower.includes('.m3u8') ||
      lower.includes('manifest') ||
      lower.includes('/hls/')
    ) {
      return 'hls';
    }

    // Strip query parameters and hash fragments for extension matching
    let pathname = lower;
    try {
      pathname = new URL(source).pathname.toLowerCase();
    } catch (_) {
      // Not a valid URL — strip manually
      pathname = lower.split('?')[0].split('#')[0];
    }

    if (pathname.endsWith('.mkv')) return 'mkv';
    if (pathname.endsWith('.webm')) return 'webm';
    if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) return 'mp4';
    if (pathname.endsWith('.avi')) return 'avi';
    if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) return 'hls';
    if (pathname.endsWith('.ts')) return 'hls';

    // Unknown extension — default to mp4 (native playback) rather than hls
    return 'mp4';
  }

  if (source instanceof File) {
    const name = source.name.toLowerCase();
    if (name.endsWith('.mkv')) return 'mkv';
    if (name.endsWith('.webm')) return 'webm';
    if (name.endsWith('.mp4') || name.endsWith('.m4v')) return 'mp4';
    if (name.endsWith('.avi')) return 'avi';
    if (name.endsWith('.m3u8')) return 'hls';
    return 'mp4';
  }

  return 'mp4';
}

export function formatTime(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

const STREAM_BUFFER_AHEAD_SECONDS = 30;
const STREAM_BUFFER_BEHIND_SECONDS = 15;

function waitForEvent(target, name, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const onEvent = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(`Event ${name} failed`));
    };

    const cleanup = () => {
      target.removeEventListener(name, onEvent);
      target.removeEventListener('error', onError);
      if (timer) clearTimeout(timer);
    };

    target.addEventListener(name, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
  });
}

export class FluxPlayerEngine {
  constructor() {
    this.videoElement = null;
    this.hls = null;

    this._logLevel = 1; // 0=off, 1=warn, 2=info, 3=debug
    this._listeners = {};

    this.currentSource = null;
    this.currentSourceType = null;

    this._dataSource = null;
    this._demuxer = null;
    this._streamController = null;
    this._audioTrackManager = null;
    this._subtitleManager = null;

    this._mkvFallbackMode = false;

    this._currentVideoObjectUrl = null;

    this.ffmpeg = null;
    this.ffmpegLoaded = false;
    this.ffmpegLoadFailed = false;
    this._ffmpegLogLines = [];
    this._fetchFile = null;

    this.videoTracks = [];
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.qualityLevels = [];

    this.activeVideoTrackIndex = 0;
    this.activeAudioTrackIndex = 0;
    this.activeSubtitleTrackIndex = -1;
    this.activeQualityIndex = -1;

    this.fileMetadata = {};

    this._nativeAudioTracksList = null;
    this._nativeAudioSyncHandler = null;
  }

  setLogLevel(level) {
    const map = {
      off: 0,
      none: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };
    if (typeof level === 'string') {
      this._logLevel = map[level.toLowerCase()] ?? 0;
      return;
    }
    this._logLevel = Number(level) || 0;
  }

  enableDebug() {
    this.setLogLevel('debug');
  }

  disableDebug() {
    this.setLogLevel('off');
  }

  _log(level, ...args) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    const normalized = String(level || 'info').toLowerCase();
    if (this._logLevel < (levels[normalized] ?? 2)) return;

    const prefix = '[FluxPlayer]';
    if (normalized === 'debug' && console.debug) console.debug(prefix, ...args);
    else if (normalized === 'info' && console.info) console.info(prefix, ...args);
    else if (normalized === 'warn' && console.warn) console.warn(prefix, ...args);
    else if (normalized === 'error' && console.error) console.error(prefix, ...args);
    else console.log(prefix, ...args);
  }

  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((cb) => cb !== callback);
  }

  emit(event, data) {
    (this._listeners[event] || []).forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        this._log('error', 'Event callback failed', err);
      }
    });
  }

  init(videoElement) {
    if (this._nativeAudioTracksList && this._nativeAudioSyncHandler) {
      this._nativeAudioTracksList.removeEventListener('addtrack', this._nativeAudioSyncHandler);
      this._nativeAudioTracksList.removeEventListener('removetrack', this._nativeAudioSyncHandler);
      this._nativeAudioTracksList.removeEventListener('change', this._nativeAudioSyncHandler);
    }

    this.videoElement = videoElement;
    this._bindVideoListeners();
  }

  _bindVideoListeners() {
    const video = this.videoElement;
    if (!video || !video.audioTracks) return;

    this._nativeAudioSyncHandler = () => {
      if (this.currentSourceType === 'mkv') return;
      this._syncNativeAudioTracks();
    };

    this._nativeAudioTracksList = video.audioTracks;
    this._nativeAudioTracksList.addEventListener('addtrack', this._nativeAudioSyncHandler);
    this._nativeAudioTracksList.addEventListener('removetrack', this._nativeAudioSyncHandler);
    this._nativeAudioTracksList.addEventListener('change', this._nativeAudioSyncHandler);
  }

  async loadSource(source) {
    if (!this.videoElement) {
      throw new Error('Player not initialized with a video element');
    }

    await this._teardownCurrentPlayback({ resetVideoSrc: true });

    this.currentSource = source;
    this.currentSourceType = detectSourceType(source);

    this.emit('loading', {
      loading: true,
      message: 'Loading media source...',
      progress: 0,
    });

    try {
      if (this.currentSourceType === 'hls') {
        await this._loadHLS(source);
      } else if (this.currentSourceType === 'mkv') {
        await this._loadMKV(source);
      } else {
        await this._loadDirect(source);
      }
    } catch (err) {
      // If direct playback fails (e.g. unsupported codec/format), try a FFmpeg fallback.
      if (
        (this.currentSourceType === 'mp4' ||
          this.currentSourceType === 'webm' ||
          this.currentSourceType === 'avi' ||
          this.currentSourceType === 'unknown') &&
        source &&
        (source instanceof File || typeof source === 'string')
      ) {
        this._log('warn', 'Direct playback failed, trying FFmpeg fallback', err);
        try {
          await this._loadMKVFallback(source, 'Direct playback failed');
          return;
        } catch (fallbackErr) {
          err = fallbackErr || err;
        }
      }

      this._log('error', 'Load source failed', err);
      this.emit('loading', { loading: false });
      this.emit('error', { message: `Failed to load source: ${err.message}` });
      throw err;
    }
  }

  async _loadHLS(url) {
    if (!Hls.isSupported()) {
      if (this.videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        this.videoElement.src = url;
        await waitForEvent(this.videoElement, 'loadedmetadata', 8000);
        this.emit('loading', { loading: false });
        this.emit('ready');
        return;
      }
      throw new Error('HLS is not supported in this browser');
    }

    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
    });

    await new Promise((resolve, reject) => {
      this.hls.loadSource(url);
      this.hls.attachMedia(this.videoElement);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this._updateHLSAudioTracks();
        this._updateHLSQualityLevels();
        this.emit('loading', { loading: false });
        this.emit('ready');
        resolve();
      });

      this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this._updateHLSAudioTracks());

      this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
        this.activeAudioTrackIndex = data.id;
        this.emit('audioTracks', {
          tracks: this.audioTracks,
          activeIndex: this.activeAudioTrackIndex,
        });
      });

      this.hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        this.activeQualityIndex = data.level;
        this.emit('qualityLevels', {
          levels: this.qualityLevels,
          activeIndex: this.activeQualityIndex,
        });
      });

      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.hls.startLoad();
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          this.hls.recoverMediaError();
          return;
        }

        reject(new Error(data.details || 'Fatal HLS error'));
      });
    });
  }

  _updateHLSAudioTracks() {
    if (!this.hls) return;

    this.audioTracks = this.hls.audioTracks.map((track, index) => ({
      id: track.id ?? index,
      number: track.id ?? index,
      label: track.name || `Audio ${index + 1}`,
      language: track.lang || 'und',
      codec: track.audioCodec || '',
      enabled: index === this.hls.audioTrack,
    }));

    this.activeAudioTrackIndex = this.hls.audioTrack;

    this.emit('audioTracks', {
      tracks: this.audioTracks,
      activeIndex: this.activeAudioTrackIndex,
    });
  }

  _updateHLSQualityLevels() {
    if (!this.hls) return;

    this.qualityLevels = this.hls.levels.map((level, index) => ({
      id: index,
      width: level.width,
      height: level.height,
      bitrate: level.bitrate,
      label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}kbps`,
    }));

    this.activeQualityIndex = this.hls.currentLevel;

    this.emit('qualityLevels', {
      levels: this.qualityLevels,
      activeIndex: this.activeQualityIndex,
    });
  }

  async _loadMKV(source) {
    this.emit('loading', {
      loading: true,
      message: 'Reading MKV metadata...',
      progress: 10,
    });

    this._dataSource = new DataSource(source);
    await this._dataSource.init();

    this._demuxer = new MKVDemuxer(this._dataSource);
    await this._demuxer.init();

    const info = this._demuxer.getInfo();
    const tracks = this._demuxer.getTracks();

    if (!tracks.length) {
      throw new Error('No MKV tracks found');
    }

    this.fileMetadata = {
      duration: info.durationSeconds || 0,
      timecodeScale: info.timecodeScale,
      trackCount: tracks.length,
    };

    this.emit('fileInfo', { metadata: this.fileMetadata });

    this._populateMKVTracks(tracks);

    this.emit('loading', {
      loading: true,
      message: 'Preparing MKV streaming pipeline...',
      progress: 28,
    });

    const support = this._evaluateMKVSupport();
    if (!support.supported) {
      this._log('warn', 'MKV pipeline unsupported, using fallback', support.reason);
      await this._loadMKVFallback(source, support.reason);
      return;
    }

    await this._startMKVPipeline(0);

    this.emit('loading', { loading: false });
    this.emit('ready');
  }

  _populateMKVTracks(tracks) {
    const video = [];
    const audio = [];
    const subtitles = [];

    tracks.forEach((track) => {
      if (track.typeName === 'video') {
        const index = video.length;
        video.push({
          id: index,
          number: track.number,
          label:
            track.name ||
            `Video ${index + 1}${track.video ? ` (${track.video.width}x${track.video.height})` : ''}`,
          language: track.language || 'und',
          codec: track.codecId,
          enabled: index === 0,
          raw: track,
        });
      } else if (track.typeName === 'audio') {
        const index = audio.length;
        audio.push({
          id: index,
          number: track.number,
          label: track.name || `Audio ${index + 1} (${track.language || 'und'})`,
          language: track.language || 'und',
          codec: track.codecId,
          enabled: index === 0,
          raw: track,
        });
      } else if (track.typeName === 'subtitle') {
        const index = subtitles.length;
        subtitles.push({
          id: index,
          number: track.number,
          label: track.name || `Subtitle ${index + 1} (${track.language || 'und'})`,
          language: track.language || 'und',
          codec: track.codecId,
          raw: track,
        });
      }
    });

    this.videoTracks = video;
    this.audioTracks = audio;
    this.subtitleTracks = subtitles;

    this.activeVideoTrackIndex = 0;
    this.activeAudioTrackIndex = audio.length > 0 ? 0 : -1;
    this.activeSubtitleTrackIndex = -1;

    this.emit('videoTracks', {
      tracks: this.videoTracks,
      activeIndex: this.activeVideoTrackIndex,
    });

    this.emit('audioTracks', {
      tracks: this.audioTracks,
      activeIndex: this.activeAudioTrackIndex,
    });

    this.emit('subtitleTracks', {
      tracks: this.subtitleTracks,
      activeIndex: this.activeSubtitleTrackIndex,
    });
  }

  _evaluateMKVSupport() {
    const selectedVideo = this.videoTracks[this.activeVideoTrackIndex];
    if (!selectedVideo) {
      return { supported: false, reason: 'MKV has no video track' };
    }

    if (!MP4Muxer.canMuxTrack(selectedVideo.raw)) {
      return {
        supported: false,
        reason: `Video codec not remuxable: ${selectedVideo.codec}`,
      };
    }

    if (!StreamController.canAttachTrack(selectedVideo.raw)) {
      return {
        supported: false,
        reason: `Video codec unsupported by browser MSE: ${selectedVideo.codec}`,
      };
    }

    if (this.audioTracks.length > 0) {
      const selectedAudio = this.audioTracks[this.activeAudioTrackIndex];
      if (!selectedAudio) {
        return { supported: false, reason: 'Audio track selection missing' };
      }

      if (!MP4Muxer.canMuxTrack(selectedAudio.raw)) {
        return {
          supported: false,
          reason: `Audio codec not remuxable: ${selectedAudio.codec}`,
        };
      }

      if (!StreamController.canAttachTrack(selectedAudio.raw)) {
        return {
          supported: false,
          reason: `Audio codec unsupported by browser MSE: ${selectedAudio.codec}`,
        };
      }
    }

    return { supported: true, reason: '' };
  }

  async _startMKVPipeline(startTimeSeconds) {
    if (!this._demuxer || !this.videoElement) {
      throw new Error('MKV pipeline cannot start without demuxer/video element');
    }

    const wasPaused = this.videoElement.paused;
    const resumeTime = Number.isFinite(startTimeSeconds)
      ? startTimeSeconds
      : this.videoElement.currentTime || 0;

    if (this._streamController) {
      await this._streamController.destroy();
      this._streamController = null;
    }

    const selectedVideo = this.videoTracks[this.activeVideoTrackIndex];
    const selectedAudio =
      this.activeAudioTrackIndex >= 0 ? this.audioTracks[this.activeAudioTrackIndex] : null;

    if (!selectedVideo) {
      throw new Error('Selected video track is unavailable');
    }

    if (this._subtitleManager) {
      this._subtitleManager.cleanup();
    }

    this._subtitleManager = new SubtitleManager(this.videoElement);
    this._subtitleManager.setTracks(this.subtitleTracks.map((track) => track.raw));

    this._streamController = new StreamController({
      videoElement: this.videoElement,
      demuxer: this._demuxer,
      videoTrack: selectedVideo.raw,
      audioTrack: selectedAudio ? selectedAudio.raw : null,
      subtitleManager: this._subtitleManager,
      logger: (level, ...args) => this._log(level, ...args),
      onState: (state) => {
        this.emit('bufferState', state);
      },
      options: {
        bufferAheadSeconds: STREAM_BUFFER_AHEAD_SECONDS,
        bufferBehindSeconds: STREAM_BUFFER_BEHIND_SECONDS,
      },
    });

    this._audioTrackManager = new AudioTrackManager(this._streamController);
    this._audioTrackManager.setTracks(this.audioTracks, Math.max(this.activeAudioTrackIndex, 0));

    this.emit('loading', {
      loading: true,
      message: 'Starting fMP4 stream pipeline...',
      progress: 42,
    });

    await this._streamController.start(resumeTime);
    await waitForEvent(this.videoElement, 'loadedmetadata', 10000);

    if (resumeTime > 0) {
      try {
        this.videoElement.currentTime = resumeTime;
      } catch (_) {
        // ignore seek race during metadata load
      }
    }

    if (!wasPaused) {
      this.videoElement.play().catch(() => { });
    }

    this._mkvFallbackMode = false;
  }

  async _loadMKVFallback(source, reason = '') {
    this.emit('loading', {
      loading: true,
      message: reason
        ? `Fallback remux (${reason})...`
        : 'Fallback remux to MP4...',
      progress: 55,
    });

    const ffmpegAvailable = await this._ensureFFmpeg();
    if (!ffmpegAvailable) {
      this._log('warn', 'FFmpeg unavailable for MKV fallback, attempting native playback');
      await this._loadDirect(source);
      return;
    }

    await this._remuxFullMKV(source);
    this._mkvFallbackMode = true;
  }

  async _loadDirect(source) {
    if (source instanceof File) {
      if (this._currentVideoObjectUrl) {
        URL.revokeObjectURL(this._currentVideoObjectUrl);
      }
      this._currentVideoObjectUrl = URL.createObjectURL(source);
      this.videoElement.src = this._currentVideoObjectUrl;
    } else {
      this.videoElement.src = source;
    }

    await waitForEvent(this.videoElement, 'loadedmetadata', 8000);

    this._syncNativeAudioTracks();
    this.emit('loading', { loading: false });
    this.emit('ready');
  }

  _syncNativeAudioTracks() {
    const video = this.videoElement;
    if (!video || !video.audioTracks || video.audioTracks.length === 0) {
      this.audioTracks = [];
      this.activeAudioTrackIndex = -1;
      this.emit('audioTracks', { tracks: this.audioTracks, activeIndex: -1 });
      return;
    }

    this.audioTracks = [];
    for (let i = 0; i < video.audioTracks.length; i += 1) {
      const track = video.audioTracks[i];
      const enabled = !!track.enabled;
      this.audioTracks.push({
        id: i,
        number: i,
        label: track.label || `Audio ${i + 1}`,
        language: track.language || 'und',
        codec: '',
        enabled,
      });
      if (enabled) this.activeAudioTrackIndex = i;
    }

    this.emit('audioTracks', {
      tracks: this.audioTracks,
      activeIndex: this.activeAudioTrackIndex,
    });
  }

  async _ensureFFmpeg() {
    if (this.ffmpegLoaded) return true;
    if (this.ffmpegLoadFailed) return false;

    this.emit('ffmpegStatus', { available: false, message: 'Loading FFmpeg...' });

    try {
      const ffmpegModule = await import('@ffmpeg/ffmpeg');
      const utilModule = await import('@ffmpeg/util');

      const FFmpeg = ffmpegModule.FFmpeg;
      const toBlobURL = utilModule.toBlobURL;

      this._fetchFile = utilModule.fetchFile;
      this.ffmpeg = new FFmpeg();

      this.ffmpeg.on('log', (evt) => {
        this._ffmpegLogLines.push(evt.message);
        if (this._ffmpegLogLines.length > 1000) this._ffmpegLogLines.shift();
      });

      const cdnVersion = '0.12.10';
      const localBase = `${window.location.origin}/ffmpeg`;
      const cdnBase = `https://unpkg.com/@ffmpeg/core@${cdnVersion}/dist`;
      const basePath = import.meta.env.PROD ? cdnBase : localBase;

      const coreURL = await toBlobURL(`${basePath}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${basePath}/ffmpeg-core.wasm`, 'application/wasm');

      await this.ffmpeg.load({ coreURL, wasmURL });

      this.ffmpegLoaded = true;
      this.emit('ffmpegStatus', { available: true, message: 'FFmpeg ready' });
      return true;
    } catch (err) {
      this._log('warn', 'FFmpeg load failed', err);
      this.ffmpegLoadFailed = true;
      this.ffmpeg = null;
      this.emit('ffmpegStatus', {
        available: false,
        message: 'FFmpeg unavailable',
      });
      return false;
    }
  }

  async _remuxFullMKV(source) {
    if (!this.ffmpeg || !this.ffmpegLoaded) {
      throw new Error('FFmpeg is not ready');
    }

    this.emit('loading', {
      loading: true,
      message: 'Reading MKV for fallback remux...',
      progress: 70,
    });

    let inputData;
    if (source instanceof File) {
      inputData = new Uint8Array(await source.arrayBuffer());
    } else if (this._fetchFile) {
      inputData = await this._fetchFile(source);
    } else {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch source (${res.status})`);
      inputData = new Uint8Array(await res.arrayBuffer());
    }

    await this.ffmpeg.writeFile('fallback-input.mkv', inputData);
    inputData = null;

    const videoIndex = Math.max(0, this.activeVideoTrackIndex);
    const audioIndex = Math.max(0, this.activeAudioTrackIndex);

    const args = ['-i', 'fallback-input.mkv', '-map', `0:v:${videoIndex}`];

    // If we have an audio track, select it. We may need to transcode the audio
    // when the codec is not MP4-friendly (e.g. Vorbis), otherwise the MP4 will
    // contain no playable audio.
    if (this.audioTracks.length > 0) {
      args.push('-map', `0:a:${audioIndex}`);

      const audioCodec = (this.audioTracks[audioIndex]?.codec || '').toUpperCase();
      const isCopyableToMp4 = /A_AAC|A_OPUS/.test(audioCodec);

      if (!isCopyableToMp4) {
        // Transcode to AAC for maximum MP4 compatibility.
        args.push('-c:a', 'aac', '-b:a', '160k');
      }
    }

    args.push(
      '-c',
      'copy',
      '-movflags',
      '+faststart+frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'fallback-output.mp4'
    );

    await this.ffmpeg.exec(args);

    const outputData = await this.ffmpeg.readFile('fallback-output.mp4');

    if (outputData.byteLength < 8) {
      throw new Error('FFmpeg fallback remux produced empty output');
    }

    const blob = new Blob([outputData], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);

    if (this._currentVideoObjectUrl) {
      URL.revokeObjectURL(this._currentVideoObjectUrl);
    }

    this._currentVideoObjectUrl = url;
    this.videoElement.src = url;

    await waitForEvent(this.videoElement, 'loadedmetadata', 10000);

    try {
      await this.ffmpeg.deleteFile('fallback-input.mkv');
    } catch (_) { }

    try {
      await this.ffmpeg.deleteFile('fallback-output.mp4');
    } catch (_) { }

    this.emit('loading', { loading: false });
    this.emit('ready');
  }

  switchVideoTrack(index) {
    if (index === this.activeVideoTrackIndex) return;
    if (index < 0 || index >= this.videoTracks.length) return;

    this.activeVideoTrackIndex = index;
    this.videoTracks = this.videoTracks.map((track, trackIndex) => ({
      ...track,
      enabled: trackIndex === index,
    }));

    this.emit('videoTracks', {
      tracks: this.videoTracks,
      activeIndex: this.activeVideoTrackIndex,
    });

    if (this.currentSourceType !== 'mkv') return;

    const currentTime = this.videoElement?.currentTime || 0;
    const wasPaused = this.videoElement?.paused ?? true;

    const task = async () => {
      this.emit('loading', {
        loading: true,
        message: 'Switching video track...',
        progress: 35,
      });

      const support = this._evaluateMKVSupport();
      if (support.supported && this._demuxer) {
        await this._startMKVPipeline(currentTime);
      } else {
        await this._loadMKVFallback(this.currentSource, support.reason);
      }

      if (!wasPaused) {
        this.videoElement.play().catch(() => { });
      }

      this.emit('loading', { loading: false });
    };

    task().catch((err) => {
      this._log('warn', 'Video track switch failed', err);
      this.emit('loading', { loading: false });
      this.emit('error', { message: `Video track switch failed: ${err.message}` });
    });
  }

  async switchAudioTrack(index) {
    if (index === this.activeAudioTrackIndex) return;
    if (index < 0 || index >= this.audioTracks.length) return;

    // HLS path
    if (this.currentSourceType === 'hls' && this.hls) {
      this.hls.audioTrack = index;
      this.activeAudioTrackIndex = index;
      return;
    }

    // Native audioTracks path
    if (this.currentSourceType !== 'mkv') {
      if (this.videoElement?.audioTracks?.length) {
        for (let i = 0; i < this.videoElement.audioTracks.length; i += 1) {
          this.videoElement.audioTracks[i].enabled = i === index;
        }
      }

      this.activeAudioTrackIndex = index;
      this.audioTracks = this.audioTracks.map((track, trackIndex) => ({
        ...track,
        enabled: trackIndex === index,
      }));

      this.emit('audioTracks', {
        tracks: this.audioTracks,
        activeIndex: this.activeAudioTrackIndex,
      });
      return;
    }

    this.emit('loading', {
      loading: true,
      message: 'Switching audio track...',
      progress: 40,
    });

    try {
      if (this._streamController && this._audioTrackManager && !this._mkvFallbackMode) {
        await this._audioTrackManager.switchTo(index);
      } else {
        this.activeAudioTrackIndex = index;
        await this._remuxFullMKV(this.currentSource);
      }

      this.activeAudioTrackIndex = index;
      this.audioTracks = this.audioTracks.map((track, trackIndex) => ({
        ...track,
        enabled: trackIndex === index,
      }));

      this.emit('audioTracks', {
        tracks: this.audioTracks,
        activeIndex: this.activeAudioTrackIndex,
      });
    } catch (err) {
      this._log('warn', 'Audio track switch failed', err);
      this.emit('error', { message: `Audio switch failed: ${err.message}` });
    } finally {
      this.emit('loading', { loading: false });
    }
  }

  switchSubtitleTrack(index) {
    if (index === this.activeSubtitleTrackIndex) return;
    if (index < -1 || index >= this.subtitleTracks.length) return;

    this.activeSubtitleTrackIndex = index;

    if (this._subtitleManager) {
      this._subtitleManager.switchTrack(index);
    }

    this.emit('subtitleTracks', {
      tracks: this.subtitleTracks,
      activeIndex: this.activeSubtitleTrackIndex,
    });
  }

  switchQuality(levelIndex) {
    if (!this.hls) return;
    this.hls.currentLevel = levelIndex;
    this.activeQualityIndex = levelIndex;
    this.emit('qualityLevels', {
      levels: this.qualityLevels,
      activeIndex: this.activeQualityIndex,
    });
  }

  async _teardownCurrentPlayback({ resetVideoSrc }) {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (this._streamController) {
      await this._streamController.destroy();
      this._streamController = null;
    }

    this._audioTrackManager = null;

    if (this._subtitleManager) {
      this._subtitleManager.cleanup();
      this._subtitleManager = null;
    }

    if (this._dataSource) {
      this._dataSource.destroy();
      this._dataSource = null;
    }

    this._demuxer = null;
    this._mkvFallbackMode = false;

    if (this._currentVideoObjectUrl) {
      URL.revokeObjectURL(this._currentVideoObjectUrl);
      this._currentVideoObjectUrl = null;
    }

    if (resetVideoSrc && this.videoElement) {
      this.videoElement.removeAttribute('src');
      this.videoElement.load();
    }

    this.videoTracks = [];
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.qualityLevels = [];

    this.activeVideoTrackIndex = 0;
    this.activeAudioTrackIndex = 0;
    this.activeSubtitleTrackIndex = -1;
    this.activeQualityIndex = -1;

    this.fileMetadata = {};
  }

  async destroy() {
    await this._teardownCurrentPlayback({ resetVideoSrc: true });
    this.currentSource = null;
    this.currentSourceType = null;

    if (this._nativeAudioTracksList && this._nativeAudioSyncHandler) {
      this._nativeAudioTracksList.removeEventListener('addtrack', this._nativeAudioSyncHandler);
      this._nativeAudioTracksList.removeEventListener('removetrack', this._nativeAudioSyncHandler);
      this._nativeAudioTracksList.removeEventListener('change', this._nativeAudioSyncHandler);
    }
    this._nativeAudioTracksList = null;
    this._nativeAudioSyncHandler = null;
  }
}
