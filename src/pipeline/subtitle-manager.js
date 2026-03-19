const TEXT_DECODER = new TextDecoder();
const DEFAULT_SUBTITLE_DURATION = 4;

function stripAssOverrides(text) {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();
}

function decodeSubtitleText(data) {
  if (!data || data.byteLength === 0) return '';
  return TEXT_DECODER.decode(data).replace(/\0+$/, '').trim();
}

function decodeAssText(payload) {
  const raw = decodeSubtitleText(payload);
  const parts = raw.split(',');
  if (parts.length >= 10) {
    return stripAssOverrides(parts.slice(9).join(','));
  }
  return stripAssOverrides(raw);
}

function buildCue(start, end, text) {
  if (typeof window.VTTCue !== 'undefined') {
    return new window.VTTCue(start, end, text);
  }
  if (typeof window.TextTrackCue !== 'undefined') {
    return new window.TextTrackCue(start, end, text);
  }
  return null;
}

export class SubtitleManager {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.trackEntries = [];
    this.trackByNumber = new Map();
    this.activeIndex = -1;
  }

  setTracks(subtitleTracks) {
    this.cleanup();

    subtitleTracks.forEach((track, index) => {
      const trackElement = document.createElement('track');
      trackElement.kind = 'subtitles';
      trackElement.label =
        track.name ||
        `Subtitle ${index + 1}${track.language ? ` (${track.language})` : ''}`;
      trackElement.srclang = track.language || 'und';
      trackElement.default = false;
      this.videoElement.appendChild(trackElement);

      const textTrack = trackElement.track;
      textTrack.mode = 'disabled';

      const entry = {
        index,
        trackNumber: track.number,
        codecId: track.codecId || '',
        metadata: track,
        element: trackElement,
        textTrack,
        lastCue: null,
      };

      this.trackEntries.push(entry);
      this.trackByNumber.set(track.number, entry);
    });
  }

  ingestFrames(frames) {
    for (const frame of frames) {
      const entry = this.trackByNumber.get(frame.trackNumber);
      if (!entry) continue;

      const codec = (entry.codecId || '').toUpperCase();
      let text = '';

      if (codec.includes('S_TEXT/ASS') || codec.includes('S_ASS')) {
        text = decodeAssText(frame.data);
      } else {
        text = decodeSubtitleText(frame.data);
      }

      if (!text) continue;

      const start = Math.max(0, frame.timestampSeconds || 0);
      const durationSeconds = frame.durationNs
        ? Math.max(frame.durationNs / 1e9, 0.5)
        : DEFAULT_SUBTITLE_DURATION;
      const end = Math.max(start + 0.25, start + durationSeconds);

      if (entry.lastCue && start >= entry.lastCue.startTime) {
        entry.lastCue.endTime = Math.max(entry.lastCue.startTime + 0.25, start);
      }

      const cue = buildCue(start, end, text);
      if (!cue) continue;

      try {
        entry.textTrack.addCue(cue);
        entry.lastCue = cue;
      } catch (_) {
        // Ignore malformed cue time windows.
      }
    }
  }

  switchTrack(index) {
    this.activeIndex = index;
    this.trackEntries.forEach((entry) => {
      entry.textTrack.mode = entry.index === index ? 'showing' : 'disabled';
    });
  }

  cleanup() {
    this.trackEntries.forEach((entry) => {
      try {
        const cues = entry.textTrack.cues;
        if (cues) {
          const toRemove = [];
          for (let i = 0; i < cues.length; i += 1) {
            toRemove.push(cues[i]);
          }
          toRemove.forEach((cue) => entry.textTrack.removeCue(cue));
        }
      } catch (_) {
        // ignore
      }

      entry.element.remove();
    });

    this.trackEntries = [];
    this.trackByNumber.clear();
    this.activeIndex = -1;
  }
}
