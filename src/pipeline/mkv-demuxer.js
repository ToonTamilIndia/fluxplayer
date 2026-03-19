import { EBMLReader, EBML_IDS, parseBlockPayload } from './ebml.js';

const HEADER_PROBE_SIZE = 3 * 1024 * 1024;
const CUES_PROBE_SIZE = 2 * 1024 * 1024;
const CLUSTER_SCAN_SIZE = 16 * 1024 * 1024;
const DEFAULT_FALLBACK_FPS = 30;

function trackTypeName(type) {
  if (type === 1) return 'video';
  if (type === 2) return 'audio';
  if (type === 17) return 'subtitle';
  return 'unknown';
}

function sortByTimeThenOffset(a, b) {
  if (a.timeSeconds !== b.timeSeconds) {
    return a.timeSeconds - b.timeSeconds;
  }
  return a.clusterOffset - b.clusterOffset;
}

// FIX #5: Include track in dedup key so multi-track cues aren't collapsed
function dedupeClusterCues(cues) {
  const deduped = [];
  const seen = new Set();
  for (const cue of cues) {
    const key = `${cue.clusterOffset}_${cue.track}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cue);
  }
  deduped.sort(sortByTimeThenOffset);
  return deduped;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function binarySearchFloor(array, target, accessor) {
  if (!array.length) return -1;
  let left = 0;
  let right = array.length - 1;
  let best = -1;

  while (left <= right) {
    const mid = (left + right) >> 1;
    const value = accessor(array[mid]);
    if (value <= target) {
      best = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return best;
}

export class MKVDemuxer {
  constructor(dataSource, options = {}) {
    this.dataSource = dataSource;
    this.options = options;

    this.timecodeScale = 1000000;
    this.duration = 0;
    this.durationSeconds = 0;

    this.segmentOffset = 0;
    this.segmentDataOffset = 0;
    this.segmentSize = -1;

    this.tracks = [];
    this.trackMap = new Map();

    this.seekHead = {};
    this.cues = [];
    this.clusterIndex = [];
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    await this.dataSource.init();

    const initialRead = this.dataSource.totalSize
      ? Math.min(this.dataSource.totalSize, HEADER_PROBE_SIZE)
      : HEADER_PROBE_SIZE;

    const headerBytes = await this.dataSource.readRange(0, initialRead);
    this._parseInitialHeader(headerBytes);

    if (!this.cues.length) {
      await this._loadCuesFromSeekHead();
    }

    if (!this.cues.length) {
      await this._scanClustersForCues();
    }

    this._buildClusterIndex();
    this._initialized = true;
  }

  getInfo() {
    return {
      duration: this.duration,
      durationSeconds: this.durationSeconds,
      timecodeScale: this.timecodeScale,
      segmentOffset: this.segmentOffset,
      segmentDataOffset: this.segmentDataOffset,
      totalSize: this.dataSource.totalSize,
    };
  }

  getTracks() {
    return this.tracks.slice();
  }

  getTrackByNumber(trackNumber) {
    return this.trackMap.get(trackNumber) || null;
  }

  getTracksByType(type) {
    return this.tracks.filter(
      (track) => track.typeName === type || track.type === type
    );
  }

  getCues() {
    return this.cues.slice();
  }

  getClusterIndex() {
    return this.clusterIndex.slice();
  }

  // FIX #6: Sort the filtered list so binary search works correctly
  getNearestClusterForTime(seconds, preferredTrackNumber = null) {
    const list = preferredTrackNumber
      ? this.clusterIndex
          .filter((cue) => cue.track === preferredTrackNumber)
          .sort(sortByTimeThenOffset)
      : this.clusterIndex;

    const index = binarySearchFloor(list, seconds, (entry) => entry.timeSeconds);
    if (index >= 0) return list[index];
    return list[0] || null;
  }

  getClusterIndexForTime(seconds, preferredTrackNumber = null) {
    const cue = this.getNearestClusterForTime(seconds, preferredTrackNumber);
    if (!cue) return 0;

    const index = this.clusterIndex.findIndex(
      (entry) => entry.clusterOffset === cue.clusterOffset
    );
    return index >= 0 ? index : 0;
  }

  // FIX #7: Handle undefined totalSize for streaming
  getClusterRange(index) {
    const clamped = clamp(index, 0, Math.max(this.clusterIndex.length - 1, 0));
    const current = this.clusterIndex[clamped];
    if (!current) {
      throw new Error('Cluster index unavailable');
    }

    const next = this.clusterIndex[clamped + 1];
    const start = current.clusterOffset;
    const end = next
      ? next.clusterOffset
      : this.dataSource.totalSize || start + CLUSTER_SCAN_SIZE;

    return {
      index: clamped,
      start,
      end,
      timeSeconds: current.timeSeconds,
      cueTime: current.cueTime,
      track: current.track,
    };
  }

  async readCluster(index) {
    const range = this.getClusterRange(index);
    const bytes = await this.dataSource.readRange(range.start, range.end);
    return this._parseCluster(bytes, range.start);
  }

  async readClusterByTime(seconds, preferredTrackNumber = null) {
    const index = this.getClusterIndexForTime(seconds, preferredTrackNumber);
    return this.readCluster(index);
  }

  // FIX #11: Don't break on unknown-size elements — skip them gracefully
  _parseInitialHeader(buffer) {
    const reader = new EBMLReader(buffer);

    const ebml = reader.readElementHeader();
    if (!ebml || ebml.id !== EBML_IDS.EBML) {
      throw new Error('Invalid EBML header');
    }
    if (ebml.dataSize > 0) {
      reader.skip(ebml.dataSize);
    }

    const segment = reader.readElementHeader();
    if (!segment || segment.id !== EBML_IDS.Segment) {
      throw new Error('Segment element missing');
    }

    this.segmentOffset = segment.elementOffset;
    this.segmentDataOffset = segment.dataOffset;
    this.segmentSize = segment.dataSize;

    const segmentEnd =
      segment.dataSize === -1
        ? reader.length
        : Math.min(reader.length, segment.dataOffset + segment.dataSize);

    while (reader.offset < segmentEnd) {
      const header = reader.readElementHeader();
      if (!header) break;

      const knownEnd =
        header.dataSize > 0
          ? header.dataOffset + header.dataSize
          : reader.length;

      if (header.id === EBML_IDS.SeekHead) {
        this._parseSeekHead(reader, header);
      } else if (header.id === EBML_IDS.SegmentInfo) {
        this._parseSegmentInfo(reader, header);
      } else if (header.id === EBML_IDS.Tracks) {
        this._parseTracks(reader, header);
      } else if (header.id === EBML_IDS.Cues) {
        this._parseCues(reader, header);
      } else if (header.id === EBML_IDS.Cluster) {
        const cluster = this._parseClusterHeader(reader, header, 0);
        if (cluster) {
          this.cues.push(cluster);
        }
        // Once we hit a Cluster, all metadata elements are behind us
        // in a well-formed file — skip remaining clusters to save time.
        if (header.dataSize > 0) {
          reader.offset = knownEnd;
        }
        // Don't break: there could be more clusters in the probe window
        continue;
      } else {
        // FIX #11: Skip known-size elements; for unknown-size,
        // continue scanning instead of aborting.
        if (header.dataSize > 0) {
          reader.offset = knownEnd;
        }
        // No break — keep scanning
        continue;
      }

      if (header.dataSize > 0 && reader.offset < knownEnd) {
        reader.offset = knownEnd;
      }
    }

    if (this.duration > 0) {
      this.durationSeconds = (this.duration * this.timecodeScale) / 1e9;
    }
  }

  _parseSeekHead(reader, header) {
    const end = header.dataOffset + header.dataSize;
    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;

      const elementEnd =
        element.dataSize > 0
          ? element.dataOffset + element.dataSize
          : reader.length;

      if (element.id !== EBML_IDS.Seek || element.dataSize <= 0) {
        if (element.dataSize > 0) reader.offset = elementEnd;
        continue;
      }

      let seekId = 0;
      let seekPos = 0;

      while (reader.offset < elementEnd) {
        const child = reader.readElementHeader();
        if (!child) break;
        if (child.id === EBML_IDS.SeekID) {
          seekId = reader.readUint(child.dataSize);
        } else if (child.id === EBML_IDS.SeekPosition) {
          seekPos = reader.readUint(child.dataSize);
        } else {
          reader.skip(child.dataSize);
        }
      }

      if (seekId) {
        this.seekHead[seekId] = seekPos;
      }
    }
  }

  _parseSegmentInfo(reader, header) {
    const end = header.dataOffset + header.dataSize;
    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;

      if (element.id === EBML_IDS.TimecodeScale) {
        this.timecodeScale =
          reader.readUint(element.dataSize) || this.timecodeScale;
      } else if (element.id === EBML_IDS.Duration) {
        this.duration =
          reader.readFloat(element.dataSize) || this.duration;
      } else {
        reader.skip(element.dataSize);
      }
    }
  }

  _parseTracks(reader, header) {
    const end = header.dataOffset + header.dataSize;
    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;
      if (element.id === EBML_IDS.TrackEntry) {
        const track = this._parseTrackEntry(reader, element);
        this.tracks.push(track);
        this.trackMap.set(track.number, track);
      } else {
        reader.skip(element.dataSize);
      }
    }
  }

  _parseTrackEntry(reader, header) {
    const end = header.dataOffset + header.dataSize;
    const track = {
      number: 0,
      uid: 0,
      type: 0,
      typeName: 'unknown',
      codecId: '',
      codecPrivate: null,
      language: 'und',
      name: '',
      defaultDurationNs: 0,
      video: null,
      audio: null,
    };

    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;

      if (element.id === EBML_IDS.TrackNumber) {
        track.number = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.TrackUID) {
        track.uid = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.TrackType) {
        track.type = reader.readUint(element.dataSize);
        track.typeName = trackTypeName(track.type);
      } else if (element.id === EBML_IDS.CodecID) {
        track.codecId = reader.readString(element.dataSize);
      } else if (element.id === EBML_IDS.CodecPrivate) {
        track.codecPrivate = reader.readBytes(element.dataSize);
      } else if (element.id === EBML_IDS.TrackLanguage) {
        track.language = reader.readString(element.dataSize) || 'und';
      } else if (element.id === EBML_IDS.TrackName) {
        track.name = reader.readString(element.dataSize);
      } else if (element.id === EBML_IDS.DefaultDuration) {
        track.defaultDurationNs = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.Video) {
        track.video = this._parseVideoInfo(reader, element);
      } else if (element.id === EBML_IDS.Audio) {
        track.audio = this._parseAudioInfo(reader, element);
      } else {
        reader.skip(element.dataSize);
      }
    }

    return track;
  }

  _parseVideoInfo(reader, header) {
    const end = header.dataOffset + header.dataSize;
    const video = {
      width: 0,
      height: 0,
    };

    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;
      if (element.id === EBML_IDS.PixelWidth) {
        video.width = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.PixelHeight) {
        video.height = reader.readUint(element.dataSize);
      } else {
        reader.skip(element.dataSize);
      }
    }

    return video;
  }

  _parseAudioInfo(reader, header) {
    const end = header.dataOffset + header.dataSize;
    const audio = {
      sampleRate: 0,
      channels: 2,
    };

    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;
      if (element.id === EBML_IDS.SamplingFrequency) {
        audio.sampleRate = reader.readFloat(element.dataSize);
      } else if (element.id === EBML_IDS.Channels) {
        audio.channels = reader.readUint(element.dataSize);
      } else {
        reader.skip(element.dataSize);
      }
    }

    return audio;
  }

  _parseCues(reader, header) {
    if (header.dataSize <= 0) return;
    const end = header.dataOffset + header.dataSize;

    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;
      if (element.id === EBML_IDS.CuePoint) {
        const cue = this._parseCuePoint(reader, element);
        if (cue) {
          this.cues.push(cue);
        }
      } else {
        reader.skip(element.dataSize);
      }
    }

    this._normalizeCues();
  }

  _parseCuePoint(reader, header) {
    const end = header.dataOffset + header.dataSize;
    let cueTime = 0;
    let track = 0;
    let clusterPosition = 0;

    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;

      if (element.id === EBML_IDS.CueTime) {
        cueTime = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.CueTrackPositions) {
        const cueTrackEnd = element.dataOffset + element.dataSize;
        while (reader.offset < cueTrackEnd) {
          const child = reader.readElementHeader();
          if (!child) break;
          if (child.id === EBML_IDS.CueTrack) {
            track = reader.readUint(child.dataSize);
          } else if (child.id === EBML_IDS.CueClusterPosition) {
            clusterPosition = reader.readUint(child.dataSize);
          } else {
            reader.skip(child.dataSize);
          }
        }
      } else {
        reader.skip(element.dataSize);
      }
    }

    const clusterOffset = this.segmentDataOffset + clusterPosition;
    return {
      cueTime,
      timeSeconds: (cueTime * this.timecodeScale) / 1e9,
      track,
      clusterPosition,
      clusterOffset,
    };
  }

  _normalizeCues() {
    this.cues = this.cues
      .filter(
        (cue) =>
          Number.isFinite(cue.clusterOffset) && cue.clusterOffset > 0
      )
      .sort(sortByTimeThenOffset);
  }

  // FIX #3: Scan all children for Timecode instead of assuming first element
  _parseClusterHeader(reader, header, dataOffsetBase = 0) {
    if (header.dataSize <= 0) return null;

    const clusterEnd = header.dataOffset + header.dataSize;
    let clusterTime = 0;

    while (reader.offset < clusterEnd) {
      const el = reader.readElementHeader();
      if (!el) break;

      if (el.id === EBML_IDS.Timecode) {
        clusterTime = reader.readUint(el.dataSize);
        break;
      } else if (el.id === EBML_IDS.SimpleBlock || el.id === EBML_IDS.BlockGroup) {
        // Reached block data — timecode should have appeared before this
        break;
      } else if (el.dataSize > 0) {
        reader.skip(el.dataSize);
      } else {
        break;
      }
    }

    const absoluteOffset = dataOffsetBase + header.elementOffset;
    const clusterPosition = absoluteOffset - this.segmentDataOffset;

    return {
      cueTime: clusterTime,
      timeSeconds: (clusterTime * this.timecodeScale) / 1e9,
      track: 0,
      clusterPosition,
      clusterOffset: absoluteOffset,
    };
  }

  // FIX #12: Scan forward to find Cues element instead of assuming first
  async _loadCuesFromSeekHead() {
    const relativeOffset = this.seekHead[EBML_IDS.Cues];
    if (!Number.isFinite(relativeOffset)) return;

    const absolute = this.segmentDataOffset + relativeOffset;
    if (absolute <= 0 || absolute >= this.dataSource.totalSize) return;

    const end = Math.min(
      this.dataSource.totalSize,
      absolute + CUES_PROBE_SIZE
    );
    const bytes = await this.dataSource.readRange(absolute, end);

    const reader = new EBMLReader(bytes);

    // Scan forward up to 64 bytes looking for the Cues element
    const maxScan = Math.min(64, bytes.length - 4);
    let header = null;

    for (let i = 0; i <= maxScan; i++) {
      reader.offset = i;
      const candidate = reader.readElementHeader();
      if (candidate && candidate.id === EBML_IDS.Cues) {
        header = candidate;
        break;
      }
    }

    if (!header) return;

    this._parseCues(reader, header);
  }

  // FIX #4: Use correct segmentDataOffset base for cluster positions
  async _scanClustersForCues() {
    const scanStart = this.segmentDataOffset;
    const scanEnd = Math.min(
      this.dataSource.totalSize || Infinity,
      scanStart + CLUSTER_SCAN_SIZE
    );
    if (scanEnd <= scanStart) return;

    const bytes = await this.dataSource.readRange(scanStart, scanEnd);
    const reader = new EBMLReader(bytes);

    while (reader.remaining > 12) {
      const header = reader.readElementHeader();
      if (!header) break;

      if (header.id === EBML_IDS.Cluster) {
        const clusterCue = this._parseClusterHeader(reader, header, scanStart);
        if (clusterCue) {
          this.cues.push(clusterCue);
        }

        if (header.dataSize > 0) {
          reader.offset = header.dataOffset + header.dataSize;
        } else {
          break;
        }
      } else if (header.dataSize > 0) {
        reader.offset = header.dataOffset + header.dataSize;
      } else {
        break;
      }
    }

    this._normalizeCues();
  }

  _buildClusterIndex() {
    if (!this.cues.length) {
      // Last-resort pseudo-cue so playback can still start
      this.clusterIndex = [
        {
          cueTime: 0,
          timeSeconds: 0,
          track: 0,
          clusterPosition: 0,
          clusterOffset: this.segmentDataOffset,
        },
      ];
      return;
    }

    this.clusterIndex = dedupeClusterCues(this.cues);
  }

  // FIX #8: Use max timestamp across all frames, not just last
  _ensureDurationFromFrames(frames) {
    if (this.durationSeconds > 0) return;
    if (!frames.length) return;

    let maxTs = 0;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].timestampSeconds > maxTs) {
        maxTs = frames[i].timestampSeconds;
      }
    }

    if (maxTs > this.durationSeconds) {
      this.durationSeconds = maxTs;
    }
  }

  // FIX #1 & #2: Return statement is now correctly inside the method body
  _parseCluster(bytes, absoluteOffset) {
    const reader = new EBMLReader(bytes);
    let clusterHeader = reader.readElementHeader();

    if (!clusterHeader || clusterHeader.id !== EBML_IDS.Cluster) {
      // Attempt to recover if read range has small preamble before cluster.
      // Some files may contain padding or other elements before the first cluster.
      const maxScan = Math.min(4096, bytes.length - 4);
      let found = false;
      for (let i = 1; i < maxScan; i += 1) {
        // Fast path: match the Cluster element ID bytes before parsing a full element.
        if (
          bytes[i] !== 0x1f ||
          bytes[i + 1] !== 0x43 ||
          bytes[i + 2] !== 0xb6 ||
          bytes[i + 3] !== 0x75
        ) {
          continue;
        }

        reader.offset = i;
        const header = reader.readElementHeader();
        if (header && header.id === EBML_IDS.Cluster) {
          clusterHeader = header;
          found = true;
          break;
        }
      }
      if (!found || !clusterHeader) {
        throw new Error('Cluster boundary not found');
      }
    }

    const clusterEnd =
      clusterHeader.dataSize > 0
        ? clusterHeader.dataOffset + clusterHeader.dataSize
        : reader.length;

    let clusterTimecode = 0;
    const frames = [];

    while (reader.offset < clusterEnd) {
      const element = reader.readElementHeader();
      if (!element) break;

      const elementEnd =
        element.dataSize > 0
          ? element.dataOffset + element.dataSize
          : reader.length;

      if (element.id === EBML_IDS.Timecode) {
        clusterTimecode = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.SimpleBlock) {
        const payload = reader.readBytes(element.dataSize);
        const block = parseBlockPayload(payload);
        if (block) {
          this._pushBlockFrames(frames, block, clusterTimecode, {
            blockDuration: 0,
            referenceCount: block.keyframe ? 0 : 1,
            references: [],
          });
        }
      } else if (element.id === EBML_IDS.BlockGroup) {
        const group = this._parseBlockGroup(reader, element);
        if (group.block) {
          this._pushBlockFrames(
            frames,
            group.block,
            clusterTimecode,
            group
          );
        }
      } else {
        if (element.dataSize > 0) {
          reader.offset = elementEnd;
        } else {
          break;
        }
      }

      reader.offset = elementEnd;
    }

    // Note: Do NOT sort by timestamp here — preserve bitstream (decode) order.
    // MKV clusters store blocks in decode order.
    // Sorting by timestampNs (PTS) would break B-frame dependencies.

    this._ensureDurationFromFrames(frames);

    return {
      absoluteOffset,
      clusterTimecode,
      timeSeconds: (clusterTimecode * this.timecodeScale) / 1e9,
      frames,
    };
  }

  // FIX #9: Store actual ReferenceBlock values, not just count
  _parseBlockGroup(reader, header) {
    const end = header.dataOffset + header.dataSize;
    const result = {
      block: null,
      blockDuration: 0,
      referenceCount: 0,
      references: [],
    };

    while (reader.offset < end) {
      const element = reader.readElementHeader();
      if (!element) break;

      if (element.id === EBML_IDS.Block) {
        const payload = reader.readBytes(element.dataSize);
        result.block = parseBlockPayload(payload);
      } else if (element.id === EBML_IDS.BlockDuration) {
        result.blockDuration = reader.readUint(element.dataSize);
      } else if (element.id === EBML_IDS.ReferenceBlock) {
        const refValue = reader.readInt
          ? reader.readInt(element.dataSize)
          : reader.readUint(element.dataSize);
        result.referenceCount += 1;
        result.references.push(refValue);
      } else {
        reader.skip(element.dataSize);
      }
    }

    return result;
  }

  // FIX #10: Use sensible fallback duration instead of hardcoded 1ms
  _pushBlockFrames(output, block, clusterTimecode, groupMeta) {
    const track = this.trackMap.get(block.trackNumber);
    const trackStep = track?.defaultDurationNs || 0;

    // FIX #10: Fallback to ~30fps for video, ~1ms for audio
    const fallbackStepNs =
      track?.typeName === 'video'
        ? Math.round(1e9 / DEFAULT_FALLBACK_FPS)
        : 1000000; // 1ms for audio

    const baseTimecode = clusterTimecode + block.relativeTimecode;
    const baseTimestampNs = baseTimecode * this.timecodeScale;

    const isReferenceFrame = (groupMeta.referenceCount || 0) > 0;
    const baseKeyframe = block.keyframe && !isReferenceFrame;

    const blockDurationNs = groupMeta.blockDuration
      ? groupMeta.blockDuration * this.timecodeScale
      : 0;

    block.frames.forEach((frame, frameIndex) => {
      const stepNs = trackStep > 0 ? trackStep : fallbackStepNs;
      const deltaNs = frameIndex === 0 ? 0 : stepNs * frameIndex;

      const timestampNs = baseTimestampNs + deltaNs;

      output.push({
        trackNumber: block.trackNumber,
        trackType: track?.typeName || 'unknown',
        codecId: track?.codecId || '',
        timestampNs,
        timestampSeconds: timestampNs / 1e9,
        durationNs: blockDurationNs || stepNs,
        keyframe: frameIndex === 0 ? baseKeyframe : false,
        frameIndex,
        data: frame.data,
      });
    });
  }
}