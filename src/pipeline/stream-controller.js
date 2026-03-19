import { MP4Muxer } from './mp4-muxer.js';

const DEFAULTS = {
  bufferAheadSeconds: 30,
  bufferBehindSeconds: 15,
  tickIntervalMs: 250,
  maxClustersPerTick: 4,
  maxCacheSizeBytes: 50 * 1024 * 1024, // 50 MB cluster cache limit
  evictSafetyMargin: 1.0,              // seconds of margin near playhead
  startupClusters: 3,                  // clusters to prime before playback
  maxRetries: 2,
  retryBaseMs: 150,
};

function once(target, eventName) {
  return new Promise((resolve) => {
    target.addEventListener(eventName, resolve, { once: true });
  });
}

function getBufferedAhead(sourceBuffer, time) {
  if (!sourceBuffer) return 0;
  try {
    const ranges = sourceBuffer.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (time >= ranges.start(i) && time <= ranges.end(i)) {
        return ranges.end(i) - time;
      }
    }
  } catch (_) {}
  return 0;
}

function getBufferedRangeEnd(sourceBuffer, time) {
  if (!sourceBuffer) return time;
  try {
    const ranges = sourceBuffer.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (time >= ranges.start(i) && time <= ranges.end(i)) {
        return ranges.end(i);
      }
    }
  } catch (_) {}
  return time;
}

function canUseMSE() {
  return typeof window !== 'undefined' && 'MediaSource' in window;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function filterTrackFrames(clusterFrames, trackNumber) {
  return clusterFrames.filter((f) => f.trackNumber === trackNumber);
}

// ─── Estimate byte size of a cluster for cache memory tracking ──
function estimateClusterBytes(cluster) {
  if (!cluster || !cluster.frames) return 0;
  let total = 64; // overhead for metadata
  for (const frame of cluster.frames) {
    total += frame.data ? frame.data.byteLength : 0;
    total += 48; // per-frame object overhead
  }
  return total;
}

export class StreamController {
  constructor({
    videoElement,
    demuxer,
    videoTrack,
    audioTrack,
    subtitleManager,
    logger,
    onState,
    options = {},
  }) {
    this.videoElement = videoElement;
    this.demuxer = demuxer;
    this.videoTrack = videoTrack;
    this.audioTrack = audioTrack;
    this.subtitleManager = subtitleManager;
    this.logger = logger || (() => {});
    this.onState = onState || (() => {});

    this.options = { ...DEFAULTS, ...options };

    this.mediaSource = null;
    this.objectUrl = null;

    this.videoSourceBuffer = null;
    this.audioSourceBuffer = null;

    this.videoMuxer = null;
    this.audioMuxer = null;

    this.appendQueues = { video: [], audio: [] };
    this.queueBusy = { video: false, audio: false };

    this.running = false;
    this.destroyed = false;
    this._tickTimer = null;
    this._tickPromise = null;

    this.nextVideoClusterIndex = 0;
    this.nextAudioClusterIndex = 0;
    this.streamGeneration = 0;

    this._clusterCache = new Map();
    this._clusterCacheBytes = 0;
    this._prefetchPromises = new Map();
    this._videoHasKeyframe = false;

    // FIX #2: DTS continuity tracking per track
    this._timeline = {
      video: { lastDts: -1, lastEndDts: -1 },
      audio: { lastDts: -1, lastEndDts: -1 },
    };

    this._onSeeking = () => {
      if (!this.running) return;
      const target = this.videoElement.currentTime || 0;
      this.seek(target).catch((err) => {
        this.logger('warn', 'Seek pipeline failed', err);
      });
    };
  }

  static canAttachTrack(track) {
    if (!MP4Muxer.canMuxTrack(track)) return false;
    const muxer = new MP4Muxer(track);
    const mime = muxer.getMimeType();
    return canUseMSE() && MediaSource.isTypeSupported(mime);
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  async start(startTime = 0) {
    if (this.running) return;
    if (!canUseMSE()) {
      throw new Error('MediaSource not available in this browser');
    }

    this.videoMuxer = new MP4Muxer(this.videoTrack);
    this.audioMuxer = this.audioTrack ? new MP4Muxer(this.audioTrack) : null;

    if (!MediaSource.isTypeSupported(this.videoMuxer.getMimeType())) {
      throw new Error(
        `Unsupported video codec for MSE: ${this.videoMuxer.getMimeType()}`
      );
    }
    if (
      this.audioMuxer &&
      !MediaSource.isTypeSupported(this.audioMuxer.getMimeType())
    ) {
      throw new Error(
        `Unsupported audio codec for MSE: ${this.audioMuxer.getMimeType()}`
      );
    }

    await this._openMediaSource();
    await this._createSourceBuffers();

    const durationSeconds = this.demuxer.getInfo().durationSeconds || 0;
    await this._appendInitSegments(durationSeconds);

    // FIX #1: Separate cluster start index per track type
    this.nextVideoClusterIndex = this.demuxer.getClusterIndexForTime(
      startTime,
      this.videoTrack.number
    );
    this.nextAudioClusterIndex = this.audioTrack
      ? this.demuxer.getClusterIndexForTime(startTime, this.audioTrack.number)
      : 0;
    this._videoHasKeyframe = false;
    this._resetTimeline();

    this.videoElement.addEventListener('seeking', this._onSeeking);

    this.running = true;
    this.streamGeneration += 1;

    // FIX #9 (startup): Prime initial buffer before starting tick loop
    await this._primeInitialBuffer();

    await this._tick();
    this._tickTimer = setInterval(() => {
      this._tick().catch((err) => {
        this.logger('warn', 'Streaming tick failed', err);
      });
    }, this.options.tickIntervalMs);
  }

  async switchAudioTrack(trackNumber) {
    if (!this.audioTrack || this.audioTrack.number === trackNumber) return;

    const track = this.demuxer.getTrackByNumber(trackNumber);
    if (!track) throw new Error(`Audio track ${trackNumber} not found`);
    if (!MP4Muxer.canMuxTrack(track)) {
      throw new Error(`Audio track codec not remuxable: ${track.codecId}`);
    }

    const nextMuxer = new MP4Muxer(track);
    const nextMime = nextMuxer.getMimeType();
    if (!MediaSource.isTypeSupported(nextMime)) {
      throw new Error(`Audio codec unsupported by MSE: ${nextMime}`);
    }

    this.audioTrack = track;
    this.audioMuxer = nextMuxer;

    if (!this.audioSourceBuffer) return;

    try {
      if (typeof this.audioSourceBuffer.changeType === 'function') {
        this.audioSourceBuffer.changeType(nextMime);
      }
    } catch (_) {}

    await this._flushSourceBuffer(this.audioSourceBuffer);

    this._timeline.audio = { lastDts: -1, lastEndDts: -1 };

    const durationSeconds = this.demuxer.getInfo().durationSeconds || 0;
    const init = this.audioMuxer.createInitSegment(durationSeconds);
    await this._enqueueAppend('audio', init);

    const currentTime = this.videoElement.currentTime || 0;
    this.nextAudioClusterIndex = this.demuxer.getClusterIndexForTime(
      currentTime,
      this.audioTrack.number
    );

    await this._tick();
  }

  async seek(targetTime) {
    if (!this.running) return;

    this.streamGeneration += 1;
    const generation = this.streamGeneration;
    this._videoHasKeyframe = false;
    this._resetTimeline();

    // FIX #1: Separate seek targets per track
    this.nextVideoClusterIndex = this.demuxer.getClusterIndexForTime(
      targetTime,
      this.videoTrack.number
    );
    this.nextAudioClusterIndex = this.audioTrack
      ? this.demuxer.getClusterIndexForTime(targetTime, this.audioTrack.number)
      : 0;

    // FIX #6: Clear cache + prefetch — generation guard prevents stale re-insertion
    this._clusterCache.clear();
    this._clusterCacheBytes = 0;
    this._prefetchPromises.clear();

    await this._flushSourceBuffer(this.videoSourceBuffer);
    if (this.audioSourceBuffer) {
      await this._flushSourceBuffer(this.audioSourceBuffer);
    }

    if (generation !== this.streamGeneration) return;

    const durationSeconds = this.demuxer.getInfo().durationSeconds || 0;
    await this._appendInitSegments(durationSeconds);

    if (generation !== this.streamGeneration) return;

    await this._tick();
  }

  getState() {
    const currentTime = this.videoElement.currentTime || 0;
    return {
      bufferedAheadVideo: getBufferedAhead(this.videoSourceBuffer, currentTime),
      bufferedAheadAudio: getBufferedAhead(this.audioSourceBuffer, currentTime),
      nextVideoClusterIndex: this.nextVideoClusterIndex,
      nextAudioClusterIndex: this.nextAudioClusterIndex,
      currentTime,
      cacheEntries: this._clusterCache.size,
      cacheSizeBytes: this._clusterCacheBytes,
    };
  }

  async destroy() {
    this.destroyed = true;
    this.running = false;

    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }

    this.videoElement.removeEventListener('seeking', this._onSeeking);

    // Reject all pending appends
    for (const type of ['video', 'audio']) {
      this.appendQueues[type].forEach((entry) => {
        entry.reject(new Error('Destroyed'));
      });
      this.appendQueues[type] = [];
    }

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch (_) {}
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    this.mediaSource = null;
    this.videoSourceBuffer = null;
    this.audioSourceBuffer = null;
    this.videoMuxer = null;
    this.audioMuxer = null;
    this._clusterCache.clear();
    this._clusterCacheBytes = 0;
    this._prefetchPromises.clear();
  }

  // ─── MediaSource Setup ──────────────────────────────────────

  async _openMediaSource() {
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.videoElement.src = this.objectUrl;

    await once(this.mediaSource, 'sourceopen');

    // FIX #13: Set initial duration; will be updated as frames arrive
    const durationSeconds = this.demuxer.getInfo().durationSeconds;
    if (durationSeconds > 0) {
      try {
        this.mediaSource.duration = durationSeconds;
      } catch (_) {}
    }
  }

  async _createSourceBuffers() {
    this.videoSourceBuffer = this.mediaSource.addSourceBuffer(
      this.videoMuxer.getMimeType()
    );
    this.videoSourceBuffer.mode = 'segments';

    // FIX #3: Permanent updateend listener so queue never stalls
    this.videoSourceBuffer.addEventListener('updateend', () => {
      this._pumpQueue('video');
    });

    if (this.audioMuxer) {
      this.audioSourceBuffer = this.mediaSource.addSourceBuffer(
        this.audioMuxer.getMimeType()
      );
      this.audioSourceBuffer.mode = 'segments';

      this.audioSourceBuffer.addEventListener('updateend', () => {
        this._pumpQueue('audio');
      });
    }
  }

  async _appendInitSegments(durationSeconds) {
    const videoInit = this.videoMuxer.createInitSegment(durationSeconds);
    await this._enqueueAppend('video', videoInit);

    if (this.audioMuxer) {
      const audioInit = this.audioMuxer.createInitSegment(durationSeconds);
      await this._enqueueAppend('audio', audioInit);
    }
  }

  // ─── Append Queue (with quota handling) ─────────────────────

  // FIX #5: Generation guard on every append
  async _enqueueAppend(type, data) {
    const generation = this.streamGeneration;

    return new Promise((resolve, reject) => {
      this.appendQueues[type].push({ data, resolve, reject, generation });
      this._pumpQueue(type);
    });
  }

  // FIX #3 + #14: Robust pump with QuotaExceededError handling
  _pumpQueue(type) {
    const sourceBuffer =
      type === 'video' ? this.videoSourceBuffer : this.audioSourceBuffer;
    if (!sourceBuffer) return;
    if (this.queueBusy[type]) return;
    if (!this.appendQueues[type].length) return;
    if (sourceBuffer.updating) return;

    const entry = this.appendQueues[type].shift();
    if (!entry) return;

    // FIX #5: Drop stale appends from previous generations
    if (entry.generation !== undefined && entry.generation !== this.streamGeneration) {
      entry.resolve(); // silently discard
      this._pumpQueue(type);
      return;
    }

    this.queueBusy[type] = true;

    const cleanup = () => {
      this.queueBusy[type] = false;
      // Don't call _pumpQueue here — the permanent updateend listener handles it
    };

    const onUpdateEnd = () => {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onError);
      cleanup();
      entry.resolve();
    };

    const onError = (err) => {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onError);
      cleanup();
      entry.reject(err);
    };

    sourceBuffer.addEventListener('updateend', onUpdateEnd);
    sourceBuffer.addEventListener('error', onError);

    try {
      sourceBuffer.appendBuffer(entry.data);
    } catch (err) {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onError);
      cleanup();

      // FIX #14: Handle QuotaExceededError
      if (err.name === 'QuotaExceededError') {
        this.logger('warn', `QuotaExceededError on ${type}, evicting and retrying`);

        // Re-queue at front and trigger eviction
        this.appendQueues[type].unshift(entry);
        this._handleQuotaExceeded(type).catch(() => {
          entry.reject(err);
        });
      } else {
        entry.reject(err);
      }
    }
  }

  async _handleQuotaExceeded(type) {
    const currentTime = this.videoElement.currentTime || 0;
    await this._evictOldRanges(currentTime);
    await sleep(100);
    this._pumpQueue(type);
  }

  // ─── Tick Loop ──────────────────────────────────────────────

  async _tick() {
    if (!this.running) return;

    if (this._tickPromise) {
      await this._tickPromise;
      return;
    }

    this._tickPromise = this._doTick().finally(() => {
      this._tickPromise = null;
    });

    await this._tickPromise;
  }

  async _doTick() {
    if (!this.running || this.destroyed) return;

    const currentTime = this.videoElement.currentTime || 0;
    const generation = this.streamGeneration;
    const clusterCount = this.demuxer.getClusterIndex().length;

    await this._evictOldRanges(currentTime);
    if (generation !== this.streamGeneration) return;

    const videoAhead = getBufferedAhead(this.videoSourceBuffer, currentTime);
    const audioAhead = this.audioSourceBuffer
      ? getBufferedAhead(this.audioSourceBuffer, currentTime)
      : this.options.bufferAheadSeconds;

    // Buffer is full — just prefetch and return
    if (
      videoAhead >= this.options.bufferAheadSeconds &&
      audioAhead >= this.options.bufferAheadSeconds
    ) {
      this._emitState();
      this._prefetchAhead(clusterCount);
      return;
    }

    // ── Video fill loop ──
    let appendedVideo = 0;
    while (
      appendedVideo < this.options.maxClustersPerTick &&
      getBufferedAhead(this.videoSourceBuffer, currentTime) <
        this.options.bufferAheadSeconds &&
      this.nextVideoClusterIndex < clusterCount &&
      generation === this.streamGeneration
    ) {
      const cluster = await this._loadCluster(
        this.nextVideoClusterIndex,
        generation
      );
      this.nextVideoClusterIndex += 1;

      // FIX #9 + #10: Break on null instead of infinite loop
      if (!cluster || !cluster.frames || !cluster.frames.length) {
        continue; // try next cluster, but don't loop forever
      }

      await this._appendVideoCluster(cluster, generation);
      if (generation !== this.streamGeneration) return;
      appendedVideo += 1;
    }

    // ── Audio fill loop ──
    // FIX #7 + #8: Only start audio after video has its first keyframe
    if (
      this.audioMuxer &&
      this.audioSourceBuffer &&
      this._videoHasKeyframe
    ) {
      let appendedAudio = 0;
      while (
        appendedAudio < this.options.maxClustersPerTick &&
        getBufferedAhead(this.audioSourceBuffer, currentTime) <
          this.options.bufferAheadSeconds &&
        this.nextAudioClusterIndex < clusterCount &&
        generation === this.streamGeneration
      ) {
        const cluster = await this._loadCluster(
          this.nextAudioClusterIndex,
          generation
        );
        this.nextAudioClusterIndex += 1;

        if (!cluster || !cluster.frames || !cluster.frames.length) {
          continue;
        }

        await this._appendAudioCluster(cluster, generation);
        if (generation !== this.streamGeneration) return;
        appendedAudio += 1;
      }
    }

    if (generation !== this.streamGeneration) return;

    // ── End of stream detection ──
    // FIX #12: Only signal EOS when all queues are drained AND buffers idle
    this._tryEndOfStream(clusterCount);

    // FIX #13: Update duration dynamically from muxer state
    this._updateDuration();

    this._prefetchAhead(clusterCount);
    this._emitState();
  }

  // FIX #12: Robust EOS that waits for queues + buffer idle
  _tryEndOfStream(clusterCount) {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;

    const videoComplete = this.nextVideoClusterIndex >= clusterCount;
    const audioComplete =
      !this.audioMuxer || this.nextAudioClusterIndex >= clusterCount;

    if (!videoComplete || !audioComplete) return;

    // Don't signal EOS while appends are still in flight
    if (this.appendQueues.video.length > 0 || this.appendQueues.audio.length > 0) {
      return;
    }
    if (this.videoSourceBuffer?.updating) return;
    if (this.audioSourceBuffer?.updating) return;

    try {
      this.mediaSource.endOfStream();
    } catch (_) {}
  }

  // ─── Cluster Loading (generation-safe + cache-bounded) ──────

  // FIX #4 + #6: Generation guard prevents stale data from entering cache
  async _loadCluster(index, generation) {
    const clusterCount = this.demuxer.getClusterIndex().length;
    if (index < 0 || index >= clusterCount) return null;

    if (this._clusterCache.has(index)) {
      return this._clusterCache.get(index);
    }

    // Check in-flight prefetch
    if (this._prefetchPromises.has(index)) {
      try {
        const cluster = await this._prefetchPromises.get(index);
        this._prefetchPromises.delete(index);
        // Stale generation check
        if (generation !== undefined && generation !== this.streamGeneration) {
          return null;
        }
        return cluster;
      } catch (_) {
        this._prefetchPromises.delete(index);
      }
    }

    let cluster = null;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        cluster = await this.demuxer.readCluster(index);
        break;
      } catch (err) {
        if (attempt === this.options.maxRetries) {
          this.logger('warn', `Failed to load cluster ${index} after retries`, err);
          return null;
        }
        await sleep(this.options.retryBaseMs * (attempt + 1));
        // Bail if generation changed during retry wait
        if (generation !== undefined && generation !== this.streamGeneration) {
          return null;
        }
      }
    }

    // FIX #6: Don't cache if generation has changed
    if (generation !== undefined && generation !== this.streamGeneration) {
      return null;
    }

    if (cluster) {
      this._cacheInsert(index, cluster);
    }

    return cluster;
  }

  // FIX #15: Byte-bounded cache instead of count-bounded
  _cacheInsert(index, cluster) {
    if (this._clusterCache.has(index)) return;

    const bytes = estimateClusterBytes(cluster);
    this._clusterCache.set(index, cluster);
    this._clusterCacheBytes += bytes;

    // Evict oldest entries if over budget
    if (this._clusterCacheBytes > this.options.maxCacheSizeBytes) {
      const keys = [...this._clusterCache.keys()].sort((a, b) => a - b);
      while (
        this._clusterCacheBytes > this.options.maxCacheSizeBytes * 0.7 &&
        keys.length > 1
      ) {
        const evictKey = keys.shift();
        const evicted = this._clusterCache.get(evictKey);
        this._clusterCacheBytes -= estimateClusterBytes(evicted);
        this._clusterCache.delete(evictKey);
      }
    }
  }

  // FIX #4: Generation-safe prefetch
  _prefetchAhead(clusterCount) {
    const generation = this.streamGeneration;

    // Adaptive prefetch count based on buffer health
    const currentTime = this.videoElement.currentTime || 0;
    const ahead = getBufferedAhead(this.videoSourceBuffer, currentTime);
    const prefetchCount = ahead < 5 ? 5 : 2;

    const maxIndex = Math.min(
      Math.max(this.nextVideoClusterIndex, this.nextAudioClusterIndex) +
        prefetchCount,
      clusterCount
    );

    for (
      let i = Math.min(this.nextVideoClusterIndex, this.nextAudioClusterIndex);
      i < maxIndex;
      i += 1
    ) {
      if (this._clusterCache.has(i) || this._prefetchPromises.has(i)) continue;

      const promise = this.demuxer
        .readCluster(i)
        .then((cluster) => {
          this._prefetchPromises.delete(i);
          // FIX #4: Discard if generation changed
          if (generation !== this.streamGeneration) return null;
          if (cluster) {
            this._cacheInsert(i, cluster);
          }
          return cluster;
        })
        .catch(() => {
          this._prefetchPromises.delete(i);
          return null;
        });

      this._prefetchPromises.set(i, promise);
    }
  }

  // ─── Startup Buffer Priming ─────────────────────────────────

  async _primeInitialBuffer() {
    const generation = this.streamGeneration;
    const clusterCount = this.demuxer.getClusterIndex().length;

    for (
      let i = 0;
      i < this.options.startupClusters &&
      this.nextVideoClusterIndex < clusterCount &&
      generation === this.streamGeneration;
      i += 1
    ) {
      const cluster = await this._loadCluster(
        this.nextVideoClusterIndex,
        generation
      );
      this.nextVideoClusterIndex += 1;

      if (!cluster || !cluster.frames || !cluster.frames.length) continue;

      await this._appendVideoCluster(cluster, generation);
      if (generation !== this.streamGeneration) return;

      // Also append corresponding audio
      if (
        this.audioMuxer &&
        this.audioSourceBuffer &&
        this._videoHasKeyframe &&
        this.nextAudioClusterIndex < clusterCount
      ) {
        const audioCluster = await this._loadCluster(
          this.nextAudioClusterIndex,
          generation
        );
        this.nextAudioClusterIndex += 1;

        if (audioCluster?.frames?.length) {
          await this._appendAudioCluster(audioCluster, generation);
        }
      }
    }
  }

  // ─── Track Append Logic ─────────────────────────────────────

  // FIX #2: Validate DTS continuity before appending
  _validateSegmentTiming(type, segment) {
    if (!segment) return false;

    const timeline = this._timeline[type];

    // First segment — accept anything
    if (timeline.lastDts < 0) {
      timeline.lastDts = segment.baseDecodeTime;
      return true;
    }

    // Reject segments that go backwards in decode time
    if (segment.baseDecodeTime < timeline.lastDts) {
      this.logger(
        'debug',
        `Dropping ${type} segment: DTS ${segment.baseDecodeTime} < last ${timeline.lastDts}`
      );
      return false;
    }

    timeline.lastDts = segment.baseDecodeTime;
    return true;
  }

  async _appendVideoCluster(cluster, generation) {
    const allFrames = cluster.frames;
    if (!allFrames || !allFrames.length) return;

    let videoFrames = filterTrackFrames(allFrames, this.videoTrack.number);

    // ── Keyframe gating: trim to first keyframe ──
    if (videoFrames.length && !this._videoHasKeyframe) {
      const firstKeyIdx = videoFrames.findIndex((f) => f.keyframe);
      if (firstKeyIdx < 0) {
        this.logger('debug', 'Skipping video cluster — no keyframe found');
        // FIX #7: Don't process subtitles either when video isn't ready
        return;
      }
      if (firstKeyIdx > 0) {
        videoFrames = videoFrames.slice(firstKeyIdx);
      }
      this._videoHasKeyframe = true;
    }

    if (videoFrames.length) {
      const videoSegment = this.videoMuxer.createMediaSegment(videoFrames);

      // FIX #2: DTS continuity check
      if (videoSegment && this._validateSegmentTiming('video', videoSegment)) {
        if (generation !== this.streamGeneration) return;
        await this._enqueueAppend('video', videoSegment.segment);
      }
    }

    // Process subtitles only after video is flowing
    if (this.subtitleManager && this._videoHasKeyframe) {
      const subtitleFrames = allFrames.filter(
        (f) => f.trackType === 'subtitle'
      );
      if (subtitleFrames.length) {
        this.subtitleManager.ingestFrames(subtitleFrames);
      }
    }
  }

  async _appendAudioCluster(cluster, generation) {
    if (!this.audioMuxer || !this.audioSourceBuffer) return;

    const allFrames = cluster.frames;
    if (!allFrames || !allFrames.length) return;

    const audioFrames = filterTrackFrames(allFrames, this.audioTrack.number);
    if (!audioFrames.length) return;

    const audioSegment = this.audioMuxer.createMediaSegment(audioFrames);

    // FIX #2: DTS continuity check
    if (audioSegment && this._validateSegmentTiming('audio', audioSegment)) {
      if (generation !== this.streamGeneration) return;
      await this._enqueueAppend('audio', audioSegment.segment);
    }
  }

  // ─── Buffer Management ──────────────────────────────────────

  async _flushSourceBuffer(sourceBuffer) {
    if (!sourceBuffer) return;

    const type =
      sourceBuffer === this.videoSourceBuffer ? 'video' : 'audio';

    // Reject all pending appends for this buffer
    this.appendQueues[type].forEach((entry) => {
      entry.reject(new Error('Append cancelled by stream reset'));
    });
    this.appendQueues[type] = [];

    // Wait for any in-progress update to finish
    while (sourceBuffer.updating) {
      await sleep(10);
    }

    try {
      sourceBuffer.abort();
    } catch (_) {}

    // Remove all buffered ranges
    const ranges = [];
    try {
      for (let i = 0; i < sourceBuffer.buffered.length; i += 1) {
        ranges.push([
          sourceBuffer.buffered.start(i),
          sourceBuffer.buffered.end(i),
        ]);
      }
    } catch (_) {
      return;
    }

    for (const [start, end] of ranges) {
      await new Promise((resolve) => {
        const onUpdate = () => {
          sourceBuffer.removeEventListener('updateend', onUpdate);
          resolve();
        };
        sourceBuffer.addEventListener('updateend', onUpdate);
        try {
          sourceBuffer.remove(start, end);
        } catch (_) {
          sourceBuffer.removeEventListener('updateend', onUpdate);
          resolve();
        }
      });
    }
  }

  async _evictOldRanges(currentTime) {
    await this._evictBuffer(this.videoSourceBuffer, currentTime);
    if (this.audioSourceBuffer) {
      await this._evictBuffer(this.audioSourceBuffer, currentTime);
    }
  }

  // FIX #11: Safety margin prevents removing data near playhead
  async _evictBuffer(sourceBuffer, currentTime) {
    if (!sourceBuffer || sourceBuffer.updating) return;

    const removeRanges = [];
    const margin = this.options.evictSafetyMargin;
    const behindLimit = currentTime - this.options.bufferBehindSeconds;
    const aheadLimit =
      currentTime + this.options.bufferAheadSeconds + 5;

    try {
      for (let i = 0; i < sourceBuffer.buffered.length; i += 1) {
        const start = sourceBuffer.buffered.start(i);
        const end = sourceBuffer.buffered.end(i);

        // Entire range is well behind playhead
        if (end < behindLimit - margin) {
          removeRanges.push([start, end]);
          continue;
        }

        // Partially behind — trim safely
        if (start < behindLimit - margin && end >= behindLimit) {
          removeRanges.push([start, behindLimit - margin]);
          continue;
        }

        // Far-future range (orphaned from seek)
        if (start > aheadLimit + margin) {
          removeRanges.push([start, end]);
        }
      }
    } catch (_) {
      return;
    }

    for (const [start, end] of removeRanges) {
      if (sourceBuffer.updating) return;

      await new Promise((resolve) => {
        const onUpdate = () => {
          sourceBuffer.removeEventListener('updateend', onUpdate);
          resolve();
        };
        sourceBuffer.addEventListener('updateend', onUpdate);
        try {
          sourceBuffer.remove(start, end);
        } catch (_) {
          sourceBuffer.removeEventListener('updateend', onUpdate);
          resolve();
        }
      });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  _resetTimeline() {
    this._timeline.video = { lastDts: -1, lastEndDts: -1 };
    this._timeline.audio = { lastDts: -1, lastEndDts: -1 };
  }

  // FIX #13: Dynamically update MediaSource duration as we discover more content
  _updateDuration() {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;

    const info = this.demuxer.getInfo();
    if (info.durationSeconds <= 0) return;

    try {
      if (
        !this.videoSourceBuffer?.updating &&
        !this.audioSourceBuffer?.updating &&
        Math.abs(this.mediaSource.duration - info.durationSeconds) > 0.5
      ) {
        this.mediaSource.duration = info.durationSeconds;
      }
    } catch (_) {}
  }

  _emitState() {
    const currentTime = this.videoElement.currentTime || 0;
    this.onState({
      ...this.getState(),
      videoBufferedEnd: getBufferedRangeEnd(
        this.videoSourceBuffer,
        currentTime
      ),
      audioBufferedEnd: getBufferedRangeEnd(
        this.audioSourceBuffer,
        currentTime
      ),
    });
  }
}