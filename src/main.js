// FluxPlayer — Main Application v2
// Modern, premium MKV/MP4/HLS player with multi-audio support
// Event-driven architecture inspired by audio_x

import './style.css';
import { icons } from './icons.js';
import { FluxPlayerEngine, formatTime, detectSourceType } from './engine.js';

// ========================================
// App State
// ========================================
const state = {
  isPlayerActive: false,
  isPlaying: false,
  isFullscreen: false,
  isMuted: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  showAudioPanel: false,
  showVideoPanel: false,
  showSubtitlePanel: false,
  showSpeedMenu: false,
  playbackRate: 1,
  fileName: '',
  isLoading: false,
  loadingMessage: '',
  loadingProgress: 0,
  videoTracks: [],
  activeVideoTrack: 0,
  audioTracks: [],
  activeAudioTrack: 0,
  subtitleTracks: [],
  activeSubtitleTrack: -1,
  qualityLevels: [],
  activeQuality: -1,
  ffmpegAvailable: null, // null = unknown, true/false
};

const engine = new FluxPlayerEngine();
window.engine = engine;

// ========================================
// Render App
// ========================================
function renderApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <!-- Ambient Background -->
    <div class="flux-bg">
      <div class="flux-bg__orb flux-bg__orb--1"></div>
      <div class="flux-bg__orb flux-bg__orb--2"></div>
      <div class="flux-bg__orb flux-bg__orb--3"></div>
      <div class="flux-bg__grid"></div>
    </div>

    <!-- Header -->
    <header class="flux-header" id="flux-header">
      <a class="flux-logo" href="#" id="flux-logo">
        <div class="flux-logo__icon">${icons.film}</div>
        <span class="flux-logo__text">FluxPlayer</span>
        <span class="flux-logo__badge">PRO</span>
      </a>
      <div class="flux-header__center" id="header-status"></div>
      <div class="flux-header__actions">
        <button class="flux-btn flux-btn--ghost" id="btn-open-file" title="Open File">
          ${icons.upload}
          <span>Open File</span>
        </button>
        <button class="flux-btn flux-btn--ghost" id="btn-open-url" title="Stream URL">
          ${icons.link}
          <span>Stream</span>
        </button>
      </div>
    </header>

    <!-- Main Content -->
    <main class="flux-main" id="flux-main">
      <!-- Landing Screen -->
      <div class="flux-landing" id="flux-landing">
        <div class="flux-hero">
          <div class="flux-hero__badge">
            <span class="flux-hero__badge-dot"></span>
            MKV Multi-Audio Support
          </div>
          <h1 class="flux-hero__title">
            Play <span class="flux-gradient-text">anything</span>,<br/>beautifully.
          </h1>
          <p class="flux-hero__subtitle">Drop a video or paste a stream URL. MKV, MP4, HLS — with multiple audio track switching.</p>
        </div>

        <div class="flux-dropzone" id="flux-dropzone">
          <div class="flux-dropzone__glow"></div>
          <div class="flux-dropzone__content">
            <div class="flux-dropzone__icon">
              ${icons.fileVideo}
            </div>
            <div class="flux-dropzone__text">
              <span class="flux-dropzone__primary">Drop video file here</span>
              <span class="flux-dropzone__secondary">or click to browse</span>
            </div>
          </div>
          <div class="flux-dropzone__formats">
            <span class="flux-format-badge flux-format-badge--mkv">MKV</span>
            <span class="flux-format-badge flux-format-badge--mp4">MP4</span>
            <span class="flux-format-badge flux-format-badge--hls">HLS</span>
            <span class="flux-format-badge flux-format-badge--webm">WebM</span>
            <span class="flux-format-badge flux-format-badge--avi">AVI</span>
          </div>
        </div>

        <div class="flux-url-section">
          <div class="flux-url-divider"><span>or stream from URL</span></div>
          <div class="flux-url-input-group">
            <div class="flux-url-input-wrapper">
              ${icons.globe}
              <input 
                type="text" 
                class="flux-url-input" 
                id="flux-url-input" 
                placeholder="https://example.com/stream.m3u8"
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <button class="flux-btn flux-btn--primary flux-btn--glow" id="btn-load-url">
              ${icons.play}
              <span>Play</span>
            </button>
          </div>
        </div>

        <div class="flux-features">
          <div class="flux-feature">
            <div class="flux-feature__icon">${icons.audioTrack}</div>
            <div class="flux-feature__text">Multi-Audio</div>
          </div>
          <div class="flux-feature">
            <div class="flux-feature__icon">${icons.settings}</div>
            <div class="flux-feature__text">Smart Remux</div>
          </div>
          <div class="flux-feature">
            <div class="flux-feature__icon">${icons.pip}</div>
            <div class="flux-feature__text">PiP Mode</div>
          </div>
          <div class="flux-feature">
            <div class="flux-feature__icon">${icons.speed}</div>
            <div class="flux-feature__text">Speed Control</div>
          </div>
        </div>
      </div>

      <!-- Player Screen -->
      <div class="flux-player" id="flux-player" style="display: none;">
        <div class="flux-player__video-wrapper" id="video-wrapper">
          <video class="flux-player__video" id="flux-video" preload="metadata" playsinline></video>

          <!-- Big Play Overlay -->
          <div class="flux-player__play-overlay flux-player__play-overlay--visible" id="play-overlay">
            <button class="flux-player__play-btn-big" id="btn-play-big" title="Play">
              ${icons.play}
            </button>
          </div>

          <!-- Loading Overlay -->
          <div class="flux-loading-overlay" id="loading-overlay" style="display: none;">
            <div class="flux-spinner"></div>
            <div class="flux-loading-text" id="loading-text">Loading...</div>
            <div class="flux-loading-progress">
              <div class="flux-loading-progress__bar" id="loading-progress-bar" style="width: 0%"></div>
            </div>
          </div>
        </div>

        <!-- Controls -->
        <div class="flux-controls flux-controls--always-show" id="flux-controls">
          <!-- Progress Bar -->
          <div class="flux-progress" id="progress-bar">
            <div class="flux-progress__buffered" id="progress-buffered"></div>
            <div class="flux-progress__filled" id="progress-filled"></div>
            <div class="flux-progress__thumb" id="progress-thumb"></div>
            <div class="flux-progress__tooltip" id="progress-tooltip">0:00</div>
          </div>

          <!-- Controls Row -->
          <div class="flux-controls__row">
            <div class="flux-controls__left">
              <button class="flux-ctrl-btn flux-ctrl-btn--play" id="btn-playpause" title="Play / Pause">
                ${icons.play}
              </button>
              <button class="flux-ctrl-btn" id="btn-rewind" title="Rewind 10s">
                ${icons.rewind10}
              </button>
              <button class="flux-ctrl-btn" id="btn-forward" title="Forward 10s">
                ${icons.forward10}
              </button>
              <div class="flux-volume-group">
                <button class="flux-ctrl-btn" id="btn-volume" title="Mute / Unmute">
                  ${icons.volumeHigh}
                </button>
                <div class="flux-volume-slider-wrapper">
                  <input type="range" class="flux-volume-slider" id="volume-slider" min="0" max="1" step="0.01" value="1" />
                </div>
              </div>
              <span class="flux-time" id="time-display">0:00 / 0:00</span>
            </div>

            <div class="flux-controls__center">
              <div class="flux-file-info">
                <span class="flux-file-info__name" id="file-name"></span>
              </div>
            </div>

            <div class="flux-controls__right">
              <button class="flux-ctrl-btn flux-ctrl-btn--audio" id="btn-audio-tracks" title="Audio Tracks" style="display: none;">
                ${icons.audioTrack}
                <span class="flux-ctrl-btn__badge" id="audio-badge">0</span>
              </button>
              <button class="flux-ctrl-btn flux-ctrl-btn--video" id="btn-video-tracks" title="Video Tracks" style="display: none;">
                ${icons.film}
                <span class="flux-ctrl-btn__badge" id="video-badge">0</span>
              </button>
              <button class="flux-ctrl-btn flux-ctrl-btn--subtitles" id="btn-subtitle-tracks" title="Subtitles" style="display: none;">
                ${icons.settings}
                <span class="flux-ctrl-btn__badge" id="subtitle-badge">0</span>
              </button>
              <button class="flux-ctrl-btn" id="btn-speed" title="Playback Speed">
                ${icons.speed}
              </button>
              <button class="flux-ctrl-btn" id="btn-pip" title="Picture in Picture">
                ${icons.pip}
              </button>
              <button class="flux-ctrl-btn" id="btn-fullscreen" title="Fullscreen">
                ${icons.fullscreen}
              </button>
            </div>
          </div>
        </div>

        <!-- Audio Track Panel -->
        <div class="flux-track-panel" id="audio-panel">
          <div class="flux-track-panel__header">
            ${icons.audioTrack}
            <span>Audio Tracks</span>
          </div>
          <div class="flux-track-panel__list" id="audio-track-list"></div>
        </div>

        <!-- Video Track Panel -->
        <div class="flux-track-panel" id="video-panel">
          <div class="flux-track-panel__header">
            ${icons.film}
            <span>Video Tracks</span>
          </div>
          <div class="flux-track-panel__list" id="video-track-list"></div>
        </div>

        <!-- Subtitle Track Panel -->
        <div class="flux-track-panel" id="subtitle-panel">
          <div class="flux-track-panel__header">
            ${icons.settings}
            <span>Subtitles</span>
          </div>
          <div class="flux-track-panel__list" id="subtitle-track-list"></div>
        </div>

        <!-- Speed Menu -->
        <div class="flux-speed-menu" id="speed-menu"></div>
      </div>
    </main>

    <!-- Hidden File Input -->
    <input type="file" class="flux-file-input" id="file-input" accept="video/*,.mkv,.mp4,.webm,.avi,.m4v,.ts,.m3u8" />

    <!-- Toast -->
    <div class="flux-toast" id="flux-toast"></div>
  `;
}

// ========================================
// DOM Helpers
// ========================================
function getEl(id) { return document.getElementById(id); }

let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = getEl('flux-toast');
  toast.textContent = message;
  toast.className = 'flux-toast flux-toast--show';
  if (type === 'error') toast.classList.add('flux-toast--error');
  if (type === 'success') toast.classList.add('flux-toast--success');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('flux-toast--show'), 3500);
}

// ========================================
// Player UI Updates
// ========================================
function showPlayer() {
  getEl('flux-landing').style.display = 'none';
  getEl('flux-player').style.display = 'flex';
  state.isPlayerActive = true;
}

function showLanding() {
  getEl('flux-landing').style.display = '';
  getEl('flux-player').style.display = 'none';
  state.isPlayerActive = false;
}

function updatePlayPauseUI() {
  const btn = getEl('btn-playpause');
  const overlay = getEl('play-overlay');
  if (state.isPlaying) {
    btn.innerHTML = icons.pause;
    btn.title = 'Pause';
    overlay.classList.remove('flux-player__play-overlay--visible');
  } else {
    btn.innerHTML = icons.play;
    btn.title = 'Play';
    if (state.duration > 0) overlay.classList.add('flux-player__play-overlay--visible');
  }
}

function updateVolumeUI() {
  const btn = getEl('btn-volume');
  const slider = getEl('volume-slider');
  if (state.isMuted || state.volume === 0) {
    btn.innerHTML = icons.volumeMute;
  } else if (state.volume < 0.5) {
    btn.innerHTML = icons.volumeLow;
  } else {
    btn.innerHTML = icons.volumeHigh;
  }
  slider.value = state.isMuted ? 0 : state.volume;
}

function updateProgressUI() {
  const filled = getEl('progress-filled');
  const thumb = getEl('progress-thumb');
  const buffered = getEl('progress-buffered');
  const timeDisplay = getEl('time-display');
  const pct = state.duration ? (state.currentTime / state.duration) * 100 : 0;
  filled.style.width = `${pct}%`;
  thumb.style.left = `${pct}%`;
  buffered.style.width = `${state.buffered}%`;
  timeDisplay.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
}

function updateFullscreenUI() {
  const btn = getEl('btn-fullscreen');
  const player = getEl('flux-player');
  if (state.isFullscreen) {
    btn.innerHTML = icons.exitFullscreen;
    btn.title = 'Exit Fullscreen';
    player.classList.add('flux-player--fullscreen');
    getEl('flux-header').style.display = 'none';
  } else {
    btn.innerHTML = icons.fullscreen;
    btn.title = 'Fullscreen';
    player.classList.remove('flux-player--fullscreen');
    getEl('flux-header').style.display = '';
  }
}

function updateLoadingUI() {
  const overlay = getEl('loading-overlay');
  const text = getEl('loading-text');
  const bar = getEl('loading-progress-bar');
  if (state.isLoading) {
    overlay.style.display = 'flex';
    text.textContent = state.loadingMessage || 'Loading...';
    bar.style.width = `${state.loadingProgress || 0}%`;
  } else {
    overlay.style.display = 'none';
  }
}

function renderAudioTracks() {
  const list = getEl('audio-track-list');
  const btn = getEl('btn-audio-tracks');
  const badge = getEl('audio-badge');

  if (state.audioTracks.length <= 0) {
    btn.style.display = 'none';
    return;
  }

  btn.style.display = '';
  badge.textContent = state.audioTracks.length;

  list.innerHTML = state.audioTracks.map((track, i) => `
    <div class="flux-track-item ${i === state.activeAudioTrack ? 'flux-track-item--active' : ''}" data-track-idx="${i}">
      <div class="flux-track-item__indicator"></div>
      <div class="flux-track-item__info">
        <div class="flux-track-item__name">${track.label}</div>
        <div class="flux-track-item__meta">${track.language !== 'und' ? track.language.toUpperCase() : 'Unknown'}${track.codec ? ' • ' + track.codec : ''}</div>
      </div>
      ${i === state.activeAudioTrack ? `<div class="flux-track-item__check">${icons.check}</div>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.flux-track-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.trackIdx);
      engine.switchAudioTrack(idx);
      state.showAudioPanel = false;
      getEl('audio-panel').classList.remove('flux-track-panel--open');
      showToast(`Switched to: ${state.audioTracks[idx]?.label || 'Audio Track ' + (idx + 1)}`, 'success');
    });
  });
}

function renderVideoTracks() {
  const list = getEl('video-track-list');
  const btn = getEl('btn-video-tracks');
  const badge = getEl('video-badge');

  if (state.videoTracks.length <= 0) {
    btn.style.display = 'none';
    return;
  }

  btn.style.display = '';
  badge.textContent = state.videoTracks.length;

  list.innerHTML = state.videoTracks.map((track, i) => `
    <div class="flux-track-item ${i === state.activeVideoTrack ? 'flux-track-item--active' : ''}" data-track-idx="${i}">
      <div class="flux-track-item__indicator"></div>
      <div class="flux-track-item__info">
        <div class="flux-track-item__name">${track.label}</div>
        <div class="flux-track-item__meta">${track.language !== 'und' ? track.language.toUpperCase() : 'Unknown'}${track.codec ? ' • ' + track.codec : ''}</div>
      </div>
      ${i === state.activeVideoTrack ? `<div class="flux-track-item__check">${icons.check}</div>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.flux-track-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.trackIdx);
      engine.switchVideoTrack(idx);
      state.showVideoPanel = false;
      getEl('video-panel').classList.remove('flux-track-panel--open');
      showToast(`Switched to: ${state.videoTracks[idx]?.label || 'Video Track ' + (idx + 1)}`, 'success');
    });
  });
}

function renderSubtitleTracks() {
  const list = getEl('subtitle-track-list');
  const btn = getEl('btn-subtitle-tracks');
  const badge = getEl('subtitle-badge');

  if (state.subtitleTracks.length <= 0) {
    btn.style.display = 'none';
    return;
  }

  btn.style.display = '';
  badge.textContent = state.subtitleTracks.length;

  const tracks = [{ label: 'Off', id: -1 }].concat(state.subtitleTracks);

  list.innerHTML = tracks.map((track, i) => {
    const idx = track.id === -1 ? -1 : i - 1;
    const active = idx === state.activeSubtitleTrack;
    return `
    <div class="flux-track-item ${active ? 'flux-track-item--active' : ''}" data-track-idx="${idx}">
      <div class="flux-track-item__indicator"></div>
      <div class="flux-track-item__info">
        <div class="flux-track-item__name">${track.label}</div>
        ${track.language ? `<div class="flux-track-item__meta">${track.language.toUpperCase()}</div>` : ''}
      </div>
      ${active ? `<div class="flux-track-item__check">${icons.check}</div>` : ''}
    </div>
  `;
  }).join('');

  list.querySelectorAll('.flux-track-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.trackIdx);
      engine.switchSubtitleTrack(idx);
      state.showSubtitlePanel = false;
      getEl('subtitle-panel').classList.remove('flux-track-panel--open');
      showToast(`Subtitles: ${idx === -1 ? 'Off' : state.subtitleTracks[idx]?.label || 'Track ' + (idx + 1)}`, 'success');
    });
  });
}

function renderSpeedMenu() {
  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const menu = getEl('speed-menu');

  menu.innerHTML = speeds.map(s => `
    <div class="flux-speed-menu__item ${state.playbackRate === s ? 'flux-speed-menu__item--active' : ''}" data-speed="${s}">
      <span>${s === 1 ? 'Normal' : s + '×'}</span>
      ${state.playbackRate === s ? icons.check : ''}
    </div>
  `).join('');

  menu.querySelectorAll('.flux-speed-menu__item').forEach(item => {
    item.addEventListener('click', () => {
      const speed = parseFloat(item.dataset.speed);
      state.playbackRate = speed;
      getEl('flux-video').playbackRate = speed;
      state.showSpeedMenu = false;
      menu.classList.remove('flux-speed-menu--open');
      renderSpeedMenu();
      showToast(`Speed: ${speed === 1 ? 'Normal' : speed + '×'}`);
    });
  });
}

// ========================================
// Player Actions
// ========================================
function togglePlayPause() {
  const video = getEl('flux-video');
  if (video.paused || video.ended) video.play().catch(() => { });
  else video.pause();
}

function seekTo(fraction) {
  const video = getEl('flux-video');
  if (video.duration) video.currentTime = fraction * video.duration;
}

function seekRelative(seconds) {
  const video = getEl('flux-video');
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
  const wrapper = getEl('video-wrapper');
  const indicator = document.createElement('div');
  indicator.className = `flux-seek-indicator flux-seek-indicator--${seconds > 0 ? 'right' : 'left'}`;
  indicator.innerHTML = seconds > 0 ? icons.forward10 : icons.rewind10;
  wrapper.appendChild(indicator);
  setTimeout(() => indicator.remove(), 500);
}

function toggleMute() {
  const video = getEl('flux-video');
  state.isMuted = !state.isMuted;
  video.muted = state.isMuted;
  updateVolumeUI();
}

function setVolume(value) {
  const video = getEl('flux-video');
  state.volume = value;
  video.volume = value;
  state.isMuted = value === 0;
  video.muted = state.isMuted;
  updateVolumeUI();
}

function toggleFullscreen() {
  const player = getEl('flux-player');
  if (!document.fullscreenElement) {
    player.requestFullscreen().then(() => { state.isFullscreen = true; updateFullscreenUI(); }).catch(() => { });
  } else {
    document.exitFullscreen().then(() => { state.isFullscreen = false; updateFullscreenUI(); }).catch(() => { });
  }
}

function togglePiP() {
  const video = getEl('flux-video');
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => { });
  } else {
    video.requestPictureInPicture().catch(() => showToast('PiP not available', 'error'));
  }
}

// ========================================
// Load Media
// ========================================
async function loadFile(file) {
  state.fileName = file.name;
  getEl('file-name').textContent = file.name;
  showPlayer();
  engine.init(getEl('flux-video'));
  await engine.loadSource(file);
}

async function loadURL(url) {
  if (!url || !url.trim()) { showToast('Please enter a valid URL', 'error'); return; }
  state.fileName = url.split('/').pop() || 'Stream';
  getEl('file-name').textContent = state.fileName;
  showPlayer();
  engine.init(getEl('flux-video'));
  await engine.loadSource(url.trim());
}

// ========================================
// Wire Engine Events (audio_x style)
// ========================================
engine.on('fileInfo', ({ metadata }) => {
  if (metadata && metadata.title) {
    state.fileName = metadata.title;
    getEl('file-name').textContent = state.fileName;
  }
});

engine.on('videoTracks', ({ tracks, activeIndex }) => {
  state.videoTracks = tracks;
  state.activeVideoTrack = activeIndex;
  renderVideoTracks();
});

engine.on('audioTracks', ({ tracks, activeIndex }) => {
  state.audioTracks = tracks;
  state.activeAudioTrack = activeIndex;
  renderAudioTracks();
});

engine.on('subtitleTracks', ({ tracks, activeIndex }) => {
  state.subtitleTracks = tracks;
  state.activeSubtitleTrack = activeIndex;
  renderSubtitleTracks();
});

engine.on('qualityLevels', ({ levels, activeIndex }) => {
  state.qualityLevels = levels;
  state.activeQuality = activeIndex;
});

engine.on('loading', ({ loading, message, progress }) => {
  state.isLoading = loading;
  state.loadingMessage = message || '';
  state.loadingProgress = progress || 0;
  updateLoadingUI();
});

engine.on('error', ({ message }) => {
  showToast(message, 'error');
});

engine.on('ready', () => {
  updatePlayPauseUI();
  showToast('Media loaded!', 'success');
  setTimeout(() => getEl('flux-controls')?.classList.remove('flux-controls--always-show'), 2000);
});

engine.on('ffmpegStatus', ({ available, message }) => {
  state.ffmpegAvailable = available;
  const statusEl = getEl('header-status');
  if (available === false && message) {
    statusEl.innerHTML = `<span class="flux-status-pill flux-status-pill--warn">${message}</span>`;
  } else if (available === true) {
    statusEl.innerHTML = `<span class="flux-status-pill flux-status-pill--ok">FFmpeg Ready</span>`;
    setTimeout(() => { statusEl.innerHTML = ''; }, 3000);
  }
});

// ========================================
// Event Bindings
// ========================================
function bindEvents() {
  const video = getEl('flux-video');
  const fileInput = getEl('file-input');
  const dropzone = getEl('flux-dropzone');

  // Video events
  video.addEventListener('play', () => { state.isPlaying = true; updatePlayPauseUI(); });
  video.addEventListener('pause', () => { state.isPlaying = false; updatePlayPauseUI(); });
  video.addEventListener('ended', () => { state.isPlaying = false; updatePlayPauseUI(); });

  video.addEventListener('timeupdate', () => {
    state.currentTime = video.currentTime;
    state.duration = video.duration || 0;
    updateProgressUI();
  });

  video.addEventListener('loadedmetadata', () => {
    state.duration = video.duration || 0;
    updateProgressUI();
  });

  video.addEventListener('progress', () => {
    if (video.buffered.length > 0) {
      state.buffered = (video.buffered.end(video.buffered.length - 1) / (video.duration || 1)) * 100;
      updateProgressUI();
    }
  });

  video.addEventListener('waiting', () => {
    state.isLoading = true;
    state.loadingMessage = 'Buffering...';
    updateLoadingUI();
  });

  video.addEventListener('canplay', () => {
    if (state.isLoading) {
      state.isLoading = false;
      updateLoadingUI();
    }
  });

  // Click video to play/pause (with double-click guard)
  let clickTimer = null;
  getEl('video-wrapper').addEventListener('click', (e) => {
    if (e.target.closest('.flux-player__play-btn-big') || e.target.closest('.flux-loading-overlay') || e.target.closest('.flux-controls')) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(() => { clickTimer = null; togglePlayPause(); }, 250);
  });

  // Double-click to fullscreen
  getEl('video-wrapper').addEventListener('dblclick', (e) => {
    if (e.target.closest('.flux-player__play-btn-big') || e.target.closest('.flux-controls')) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    toggleFullscreen();
  });

  // Big play button
  getEl('btn-play-big').addEventListener('click', togglePlayPause);

  // Control buttons
  getEl('btn-playpause').addEventListener('click', togglePlayPause);
  getEl('btn-rewind').addEventListener('click', () => seekRelative(-10));
  getEl('btn-forward').addEventListener('click', () => seekRelative(10));
  getEl('btn-volume').addEventListener('click', toggleMute);
  getEl('btn-fullscreen').addEventListener('click', toggleFullscreen);
  getEl('btn-pip').addEventListener('click', togglePiP);

  // Volume slider
  getEl('volume-slider').addEventListener('input', (e) => setVolume(parseFloat(e.target.value)));

  // Progress bar seeking
  const progressBar = getEl('progress-bar');
  let isSeeking = false;

  progressBar.addEventListener('mousedown', (e) => {
    isSeeking = true;
    const rect = progressBar.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  });

  document.addEventListener('mousemove', (e) => {
    if (isSeeking) {
      const rect = progressBar.getBoundingClientRect();
      seekTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    }
    if (progressBar.matches(':hover') || isSeeking) {
      const rect = progressBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const tooltip = getEl('progress-tooltip');
      tooltip.textContent = formatTime(fraction * (state.duration || 0));
      tooltip.style.left = `${fraction * 100}%`;
    }
  });

  document.addEventListener('mouseup', () => { isSeeking = false; });

  // Audio Tracks button
  getEl('btn-audio-tracks').addEventListener('click', () => {
    state.showAudioPanel = !state.showAudioPanel;
    state.showVideoPanel = false;
    state.showSubtitlePanel = false;
    state.showSpeedMenu = false;
    getEl('video-panel').classList.remove('flux-track-panel--open');
    getEl('subtitle-panel').classList.remove('flux-track-panel--open');
    getEl('speed-menu').classList.remove('flux-speed-menu--open');
    getEl('audio-panel').classList.toggle('flux-track-panel--open', state.showAudioPanel);
  });

  // Video Tracks button
  getEl('btn-video-tracks').addEventListener('click', () => {
    state.showVideoPanel = !state.showVideoPanel;
    state.showAudioPanel = false;
    state.showSubtitlePanel = false;
    state.showSpeedMenu = false;
    getEl('audio-panel').classList.remove('flux-track-panel--open');
    getEl('subtitle-panel').classList.remove('flux-track-panel--open');
    getEl('speed-menu').classList.remove('flux-speed-menu--open');
    getEl('video-panel').classList.toggle('flux-track-panel--open', state.showVideoPanel);
  });

  // Subtitle Tracks button
  getEl('btn-subtitle-tracks').addEventListener('click', () => {
    state.showSubtitlePanel = !state.showSubtitlePanel;
    state.showAudioPanel = false;
    state.showVideoPanel = false;
    state.showSpeedMenu = false;
    getEl('audio-panel').classList.remove('flux-track-panel--open');
    getEl('video-panel').classList.remove('flux-track-panel--open');
    getEl('speed-menu').classList.remove('flux-speed-menu--open');
    getEl('subtitle-panel').classList.toggle('flux-track-panel--open', state.showSubtitlePanel);
  });

  // Speed button
  getEl('btn-speed').addEventListener('click', () => {
    state.showSpeedMenu = !state.showSpeedMenu;
    state.showAudioPanel = false;
    state.showVideoPanel = false;
    state.showSubtitlePanel = false;
    getEl('audio-panel').classList.remove('flux-track-panel--open');
    getEl('video-panel').classList.remove('flux-track-panel--open');
    getEl('subtitle-panel').classList.remove('flux-track-panel--open');
    getEl('speed-menu').classList.toggle('flux-speed-menu--open', state.showSpeedMenu);
  });

  // Close menus on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#btn-audio-tracks') && !e.target.closest('#audio-panel')) {
      state.showAudioPanel = false;
      getEl('audio-panel')?.classList.remove('flux-track-panel--open');
    }
    if (!e.target.closest('#btn-video-tracks') && !e.target.closest('#video-panel')) {
      state.showVideoPanel = false;
      getEl('video-panel')?.classList.remove('flux-track-panel--open');
    }
    if (!e.target.closest('#btn-subtitle-tracks') && !e.target.closest('#subtitle-panel')) {
      state.showSubtitlePanel = false;
      getEl('subtitle-panel')?.classList.remove('flux-track-panel--open');
    }
    if (!e.target.closest('#btn-speed') && !e.target.closest('#speed-menu')) {
      state.showSpeedMenu = false;
      getEl('speed-menu')?.classList.remove('flux-speed-menu--open');
    }
  });

  // File input
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    fileInput.value = '';
  });

  getEl('btn-open-file').addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('click', () => fileInput.click());

  // Drag & Drop
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('flux-dropzone--active'); });
  dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('flux-dropzone--active'); });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('flux-dropzone--active');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // URL input
  getEl('btn-load-url').addEventListener('click', () => loadURL(getEl('flux-url-input').value));
  getEl('btn-open-url').addEventListener('click', () => {
    const url = prompt('Enter stream URL (HLS .m3u8, MP4, etc.):');
    if (url) loadURL(url);
  });
  getEl('flux-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadURL(getEl('flux-url-input').value);
  });

  // Logo click = back to landing
  getEl('flux-logo').addEventListener('click', (e) => {
    e.preventDefault();
    if (state.isPlayerActive) {
      engine.destroy();
      state.isPlaying = false;
      state.currentTime = 0;
      state.duration = 0;
      state.videoTracks = [];
      state.audioTracks = [];
      state.subtitleTracks = [];
      state.qualityLevels = [];
      state.activeVideoTrack = 0;
      state.activeAudioTrack = 0;
      state.activeSubtitleTrack = -1;
      state.activeQuality = -1;
      showLanding();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!state.isPlayerActive) return;
    if (e.target.tagName === 'INPUT') return;

    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlayPause(); break;
      case 'f': e.preventDefault(); toggleFullscreen(); break;
      case 'm': e.preventDefault(); toggleMute(); break;
      case 'ArrowLeft': e.preventDefault(); seekRelative(-10); break;
      case 'ArrowRight': e.preventDefault(); seekRelative(10); break;
      case 'ArrowUp': e.preventDefault(); setVolume(Math.min(1, state.volume + 0.1)); break;
      case 'ArrowDown': e.preventDefault(); setVolume(Math.max(0, state.volume - 0.1)); break;
      case 'Escape': if (state.isFullscreen) document.exitFullscreen().catch(() => { }); break;
      case 'p': e.preventDefault(); togglePiP(); break;
    }
  });

  // Fullscreen change listener
  document.addEventListener('fullscreenchange', () => {
    state.isFullscreen = !!document.fullscreenElement;
    updateFullscreenUI();
  });

  // Controls auto-hide
  const player = getEl('flux-player');
  let hideControlsTimer = null;

  function showControls() {
    const controls = getEl('flux-controls');
    if (controls) { controls.style.opacity = '1'; player.style.cursor = ''; }
    clearTimeout(hideControlsTimer);
    hideControlsTimer = setTimeout(() => {
      if (state.isPlaying) {
        const controls = getEl('flux-controls');
        if (controls && !controls.classList.contains('flux-controls--always-show')) {
          controls.style.opacity = '0';
          player.style.cursor = 'none';
        }
      }
    }, 3000);
  }

  player.addEventListener('mousemove', showControls);
  player.addEventListener('mouseenter', showControls);
}

// ========================================
// Initialize
// ========================================
function init() {
  renderApp();
  bindEvents();
  renderSpeedMenu();
}

init();
