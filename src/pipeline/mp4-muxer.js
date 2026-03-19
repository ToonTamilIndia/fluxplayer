const TEXT_ENCODER = new TextEncoder();

// ─── Byte Utilities ─────────────────────────────────────────────

function concatUint8(...parts) {
  let total = 0;
  for (const part of parts) {
    total += part ? part.byteLength : 0;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    if (!part || part.byteLength === 0) continue;
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u8(...values) {
  return new Uint8Array(values);
}

function u16(value) {
  return u8((value >> 8) & 0xff, value & 0xff);
}

function u24(value) {
  return u8((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

function u32(value) {
  const v = value >>> 0;
  return u8((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function u64(value) {
  const hi = Math.floor(value / 0x100000000) >>> 0;
  const lo = value >>> 0;
  return concatUint8(u32(hi), u32(lo));
}

// FIX: Proper signed 32-bit encoding using DataView
// Original used `u32(value >>> 0)` which silently corrupted negative values
function i32(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, value, false);
  return new Uint8Array(buf);
}

function i16(value) {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, value, false);
  return new Uint8Array(buf);
}

function fixed16_16(value) {
  const scaled = Math.round(value * 65536);
  return u32(scaled >>> 0);
}

// FIX #10: Clamp to prevent overflow in fixed8.8 representation
function fixed8_8(value) {
  const clamped = Math.max(0, Math.min(value, 255.996));
  const scaled = Math.round(clamped * 256);
  return u16(scaled & 0xffff);
}

function ascii(text) {
  return TEXT_ENCODER.encode(text);
}

// FIX #13: Support 64-bit box sizes for large mdat payloads
function box(type, ...payload) {
  const body = concatUint8(...payload);
  const size = body.byteLength + 8;

  if (size > 0xffffffff) {
    const largeSize = body.byteLength + 16;
    return concatUint8(u32(1), ascii(type), u64(largeSize), body);
  }

  return concatUint8(u32(size), ascii(type), body);
}

// Returns just the header size for a given payload length
function boxHeaderSize(payloadLength) {
  return (payloadLength + 8 > 0xffffffff) ? 16 : 8;
}

function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version), u24(flags), ...payload);
}

// ─── FIX #5: ISO 14496-1 Variable-Length Descriptor Size ────────

function encodeDescriptorLength(length) {
  if (length < 0x80) {
    return u8(length);
  }
  if (length < 0x4000) {
    return u8(0x80 | ((length >> 7) & 0x7f), length & 0x7f);
  }
  if (length < 0x200000) {
    return u8(
      0x80 | ((length >> 14) & 0x7f),
      0x80 | ((length >> 7) & 0x7f),
      length & 0x7f
    );
  }
  return u8(
    0x80 | ((length >> 21) & 0x7f),
    0x80 | ((length >> 14) & 0x7f),
    0x80 | ((length >> 7) & 0x7f),
    length & 0x7f
  );
}

// ─── Constants ──────────────────────────────────────────────────

const MATRIX = concatUint8(
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000)
);

const DEFAULT_HANDLER_NAME = {
  video: 'VideoHandler',
  audio: 'SoundHandler',
};

const DEFAULT_FALLBACK_FPS = 30;

// ─── Top-Level Boxes ────────────────────────────────────────────

function makeFtyp() {
  return box(
    'ftyp',
    ascii('isom'),
    u32(0x200),
    ascii('isom'),
    ascii('iso6'),
    ascii('mp41')
  );
}

function makeMvhd(timescale, duration, nextTrackId) {
  return fullBox(
    'mvhd', 0, 0,
    u32(0),                  // creation_time
    u32(0),                  // modification_time
    u32(timescale),
    u32(duration),
    fixed16_16(1),           // rate
    fixed8_8(1),             // volume
    u16(0),                  // reserved
    u32(0), u32(0),          // reserved
    MATRIX,
    u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0),  // pre_defined
    u32(nextTrackId)
  );
}

function makeTkhd(trackId, duration, width, height, volume) {
  return fullBox(
    'tkhd', 0, 0x000007,    // track_enabled | track_in_movie | track_in_preview
    u32(0),                  // creation_time
    u32(0),                  // modification_time
    u32(trackId),
    u32(0),                  // reserved
    u32(duration),
    u32(0), u32(0),          // reserved
    u16(0),                  // layer
    u16(0),                  // alternate_group
    fixed8_8(volume),
    u16(0),                  // reserved
    MATRIX,
    fixed16_16(width),
    fixed16_16(height)
  );
}

function makeMdhd(timescale, duration, language = 'und') {
  const lang = toIso639Bits(language);
  return fullBox(
    'mdhd', 0, 0,
    u32(0), u32(0),
    u32(timescale),
    u32(duration),
    u16(lang),
    u16(0)
  );
}

function toIso639Bits(language) {
  const n = (language || 'und').toLowerCase().slice(0, 3);
  const c = [n[0] || 'u', n[1] || 'n', n[2] || 'd'];
  return (
    ((c[0].charCodeAt(0) - 0x60) << 10) |
    ((c[1].charCodeAt(0) - 0x60) << 5) |
    (c[2].charCodeAt(0) - 0x60)
  ) & 0x7fff;
}

// FIX #11: Proper null-terminated handler name
function makeHdlr(kind) {
  const handler = kind === 'audio' ? 'soun' : 'vide';
  const name = DEFAULT_HANDLER_NAME[kind] || 'Handler';
  const nameBytes = concatUint8(ascii(name), u8(0));
  return fullBox(
    'hdlr', 0, 0,
    u32(0),
    ascii(handler),
    u32(0), u32(0), u32(0),
    nameBytes
  );
}

function makeVmhd() {
  return fullBox('vmhd', 0, 0x000001, u16(0), u16(0), u16(0), u16(0));
}

function makeSmhd() {
  return fullBox('smhd', 0, 0, u16(0), u16(0));
}

function makeDinf() {
  const url = fullBox('url ', 0, 0x000001);
  const dref = fullBox('dref', 0, 0, u32(1), url);
  return box('dinf', dref);
}

function makeStts() { return fullBox('stts', 0, 0, u32(0)); }
function makeStsc() { return fullBox('stsc', 0, 0, u32(0)); }
function makeStsz() { return fullBox('stsz', 0, 0, u32(0), u32(0)); }
function makeStco() { return fullBox('stco', 0, 0, u32(0)); }

// ─── Codec Helpers ──────────────────────────────────────────────

function parseAvcCodecString(avcc) {
  if (!avcc || avcc.byteLength < 4) return 'avc1.640028';
  const profile = avcc[1].toString(16).padStart(2, '0');
  const compat = avcc[2].toString(16).padStart(2, '0');
  const level = avcc[3].toString(16).padStart(2, '0');
  return `avc1.${profile}${compat}${level}`;
}

// FIX #12: Return null instead of invalid fallback when codecPrivate missing
function extractAvcc(track) {
  const priv = track.codecPrivate;
  if (priv && priv.byteLength > 6 && priv[0] === 1) {
    return priv;
  }
  return null;
}

function extractAudioSpecificConfig(track) {
  const priv = track.codecPrivate;
  if (priv && priv.byteLength >= 2) {
    return priv;
  }

  const sampleRate = Math.round(track.audio?.sampleRate || 48000);
  const channelCount = track.audio?.channels || 2;

  const table = [
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  let idx = table.indexOf(sampleRate);
  if (idx < 0) idx = 3;

  const objectType = 2; // AAC-LC
  const b0 = (objectType << 3) | ((idx & 0x0e) >> 1);
  const b1 = ((idx & 0x01) << 7) | ((channelCount & 0x0f) << 3);
  return u8(b0, b1);
}

function parseAacObjectType(asc) {
  if (!asc || asc.byteLength < 2) return 2;
  return (asc[0] >> 3) & 0x1f;
}

// ─── Sample Entry Boxes ─────────────────────────────────────────

function makeAvc1(track, avcc) {
  if (!avcc) {
    throw new Error(
      'Missing AVC decoder configuration (codecPrivate). Cannot create valid stream.'
    );
  }

  const width = track.video?.width || 1920;
  const height = track.video?.height || 1080;

  return box(
    'avc1',
    u8(0, 0, 0, 0, 0, 0),   // reserved
    u16(1),                   // data_reference_index
    u16(0), u16(0),           // pre_defined, reserved
    u32(0), u32(0), u32(0),   // pre_defined
    u16(width),
    u16(height),
    fixed16_16(72),           // horizresolution
    fixed16_16(72),           // vertresolution
    u32(0),                   // reserved
    u16(1),                   // frame_count
    new Uint8Array(32),       // compressorname (all zeroes)
    u16(0x0018),              // depth
    i16(-1),                  // pre_defined
    box('avcC', avcc)
  );
}

function makeMp4a(track, audioSpecificConfig) {
  const channelCount = track.audio?.channels || 2;
  const sampleRate = Math.round(track.audio?.sampleRate || 48000);

  return box(
    'mp4a',
    u8(0, 0, 0, 0, 0, 0),   // reserved
    u16(1),                   // data_reference_index
    u32(0), u32(0),           // reserved
    u16(channelCount),
    u16(16),                  // sampleSize (bits per sample)
    u16(0),                   // compression_id
    u16(0),                   // packet_size
    fixed16_16(sampleRate),
    makeEsds(audioSpecificConfig)
  );
}

// FIX #5: Proper ESDS with variable-length descriptor sizes
function makeEsds(audioSpecificConfig) {
  const asc = audioSpecificConfig || u8(0x12, 0x10);

  // DecoderSpecificInfo (tag 0x05)
  const decSpecInfoPayload = asc;
  const decSpecInfo = concatUint8(
    u8(0x05),
    encodeDescriptorLength(decSpecInfoPayload.byteLength),
    decSpecInfoPayload
  );

  // DecoderConfigDescriptor (tag 0x04)
  //   objectTypeIndication(1) + streamType(1) + bufferSizeDB(3)
  //   + maxBitrate(4) + avgBitrate(4) + decSpecInfo
  const decConfigPayload = concatUint8(
    u8(0x40),               // objectTypeIndication: Audio ISO/IEC 14496-3
    u8(0x15),               // streamType(0x05=audio)<<2 | upStream(0)<<1 | 1
    u24(0),                 // bufferSizeDB
    u32(0),                 // maxBitrate (0 = unknown)
    u32(0),                 // avgBitrate (0 = unknown)
    decSpecInfo
  );
  const decConfig = concatUint8(
    u8(0x04),
    encodeDescriptorLength(decConfigPayload.byteLength),
    decConfigPayload
  );

  // SLConfigDescriptor (tag 0x06)
  const slConfig = concatUint8(
    u8(0x06),
    encodeDescriptorLength(1),
    u8(0x02)                // predefined: MP4
  );

  // ES_Descriptor (tag 0x03)
  const esDescPayload = concatUint8(
    u16(1),                 // ES_ID
    u8(0x00),               // flags byte (no stream deps, no URL, no OCR)
    decConfig,
    slConfig
  );
  const esDescriptor = concatUint8(
    u8(0x03),
    encodeDescriptorLength(esDescPayload.byteLength),
    esDescPayload
  );

  return fullBox('esds', 0, 0, esDescriptor);
}

// ─── FIX #6: Proper Opus-in-MP4 Support ─────────────────────────

function makeOpus(track) {
  const channelCount = track.audio?.channels || 2;
  const sampleRate = 48000; // Opus in MP4 always signals 48kHz

  return box(
    'Opus',
    u8(0, 0, 0, 0, 0, 0),   // reserved
    u16(1),                   // data_reference_index
    u32(0), u32(0),           // reserved
    u16(channelCount),
    u16(16),                  // sampleSize
    u16(0),                   // compression_id
    u16(0),                   // packet_size
    fixed16_16(sampleRate),
    makeDOps(track)
  );
}

function makeDOps(track) {
  const channelCount = track.audio?.channels || 2;
  const priv = track.codecPrivate;

  let preSkip = 0;
  let inputSampleRate = 48000;
  let outputGain = 0;
  let channelMappingFamily = 0;
  let channelMappingTable = null;

  if (priv && priv.byteLength >= 11) {
    const dv = new DataView(
      priv.buffer, priv.byteOffset, priv.byteLength
    );

    // Detect whether OpusHead magic is present
    let off = 0;
    if (
      priv.byteLength >= 19 &&
      priv[0] === 0x4f && priv[1] === 0x70 &&   // 'Op'
      priv[2] === 0x75 && priv[3] === 0x73 &&   // 'us'
      priv[4] === 0x48 && priv[5] === 0x65 &&   // 'He'
      priv[6] === 0x61 && priv[7] === 0x64       // 'ad'
    ) {
      off = 8; // skip magic
    }

    // version(1) + channels(1) + preSkip(2) + sampleRate(4) + gain(2) + mapping(1)
    if (priv.byteLength >= off + 11) {
      off += 1; // version
      off += 1; // channels (we already know)
      preSkip = dv.getUint16(off, true); off += 2;
      inputSampleRate = dv.getUint32(off, true); off += 4;
      outputGain = dv.getInt16(off, true); off += 2;
      channelMappingFamily = dv.getUint8(off); off += 1;

      if (channelMappingFamily > 0 && priv.byteLength >= off + 1 + channelCount) {
        // stream_count(1) + coupled_count(1) + channel_mapping(channelCount)
        channelMappingTable = priv.slice(off, off + 2 + channelCount);
      }
    }
  }

  // dOps uses big-endian (unlike OpusHead which is little-endian)
  const payload = concatUint8(
    u8(0),                          // Version
    u8(channelCount),               // OutputChannelCount
    u16(preSkip),                   // PreSkip (big-endian)
    u32(inputSampleRate),           // InputSampleRate (big-endian)
    i16(outputGain),                // OutputGain (big-endian, signed)
    u8(channelMappingFamily),       // ChannelMappingFamily
    ...(channelMappingTable ? [channelMappingTable] : [])
  );

  return box('dOps', payload);
}

// ─── Sample Description & Track Structure ───────────────────────

function makeStsd(track) {
  const codecId = (track.codecId || '').toUpperCase();

  if (track.typeName === 'video') {
    if (codecId.includes('V_MPEG4/ISO/AVC')) {
      const avcc = extractAvcc(track);
      return fullBox('stsd', 0, 0, u32(1), makeAvc1(track, avcc));
    }
    throw new Error(`Unsupported video codec for MP4 muxing: ${track.codecId}`);
  }

  if (codecId.includes('A_OPUS')) {
    return fullBox('stsd', 0, 0, u32(1), makeOpus(track));
  }

  const asc = extractAudioSpecificConfig(track);
  return fullBox('stsd', 0, 0, u32(1), makeMp4a(track, asc));
}

function makeStbl(track) {
  return box('stbl',
    makeStsd(track), makeStts(), makeStsc(), makeStsz(), makeStco()
  );
}

function makeMinf(track) {
  const mediaHeader = track.typeName === 'video' ? makeVmhd() : makeSmhd();
  return box('minf', mediaHeader, makeDinf(), makeStbl(track));
}

function makeMdia(track, timescale, duration) {
  return box('mdia',
    makeMdhd(timescale, duration, track.language),
    makeHdlr(track.typeName),
    makeMinf(track)
  );
}

function makeTrak(track, timescale, duration, trackId) {
  const isVideo = track.typeName === 'video';
  const width  = isVideo ? (track.video?.width  || 1920) : 0;
  const height = isVideo ? (track.video?.height || 1080) : 0;
  const volume = isVideo ? 0 : 1;

  return box('trak',
    makeTkhd(trackId, duration, width, height, volume),
    makeMdia(track, timescale, duration)
  );
}

// FIX #3: trex carries proper default sample duration & flags
function makeTrex(trackId, defaultDuration, defaultFlags) {
  return fullBox('trex', 0, 0,
    u32(trackId),
    u32(1),                     // default_sample_description_index
    u32(defaultDuration),
    u32(0),                     // default_sample_size
    u32(defaultFlags)
  );
}

function makeMoov(track, timescale, duration, trackId, defDuration, defFlags) {
  return box('moov',
    makeMvhd(timescale, duration, trackId + 1),
    makeTrak(track, timescale, duration, trackId),
    box('mvex', makeTrex(trackId, defDuration, defFlags))
  );
}

// ─── Fragment Boxes ─────────────────────────────────────────────

function makeMfhd(sequenceNumber) {
  return fullBox('mfhd', 0, 0, u32(sequenceNumber));
}

// FIX #3: tfhd now carries default-sample-duration and default-sample-flags
function makeTfhd(trackId, defaultDuration, defaultFlags) {
  const flags = 0x020000   // default-base-is-moof
              | 0x000008   // default-sample-duration-present
              | 0x000020;  // default-sample-flags-present
  return fullBox('tfhd', 0, flags,
    u32(trackId),
    u32(defaultDuration),
    u32(defaultFlags)
  );
}

function makeTfdt(baseDecodeTime) {
  return fullBox('tfdt', 1, 0, u64(baseDecodeTime));
}

// FIX #1: version-1 trun for negative composition time offsets (B-frames)
function makeTrun(samples, dataOffset, includeCompositionOffsets, useSignedCTO) {
  const version = useSignedCTO ? 1 : 0;

  let flags =
    0x000001 |   // data-offset-present
    0x000100 |   // sample-duration-present
    0x000200 |   // sample-size-present
    0x000400;    // sample-flags-present
  if (includeCompositionOffsets) {
    flags |= 0x000800; // sample-composition-time-offset-present
  }

  const entries = [];
  for (const s of samples) {
    entries.push(u32(s.duration));
    entries.push(u32(s.size));
    entries.push(u32(s.flags));
    if (includeCompositionOffsets) {
      entries.push(i32(s.compositionOffset || 0));
    }
  }

  return fullBox('trun', version, flags,
    u32(samples.length),
    i32(dataOffset),
    ...entries
  );
}

function makeTraf(trackId, baseDecodeTime, defDuration, defFlags, trun) {
  return box('traf',
    makeTfhd(trackId, defDuration, defFlags),
    makeTfdt(baseDecodeTime),
    trun
  );
}

function makeMoof(
  sequenceNumber, trackId, baseDecodeTime, samples,
  includeCompositionOffsets, useSignedCTO,
  defDuration, defFlags
) {
  // First pass with placeholder dataOffset to measure moof size
  const placeholderTrun = makeTrun(
    samples, 0, includeCompositionOffsets, useSignedCTO
  );
  const moofPlaceholder = box('moof',
    makeMfhd(sequenceNumber),
    makeTraf(trackId, baseDecodeTime, defDuration, defFlags, placeholderTrun)
  );

  // FIX #4 & #13: Account for large mdat header when payload > 4 GB
  const mdatPayloadSize = samples.reduce((sum, s) => sum + s.size, 0);
  const mdatHdrSize = boxHeaderSize(mdatPayloadSize);
  const dataOffset = moofPlaceholder.byteLength + mdatHdrSize;

  // Second pass with correct dataOffset
  const finalTrun = makeTrun(
    samples, dataOffset, includeCompositionOffsets, useSignedCTO
  );
  return box('moof',
    makeMfhd(sequenceNumber),
    makeTraf(trackId, baseDecodeTime, defDuration, defFlags, finalTrun)
  );
}

// ─── Codec & Timing Helpers ─────────────────────────────────────

function toTrackTimescale(track) {
  if (track.typeName === 'audio') {
    return Math.round(track.audio?.sampleRate || 48000);
  }
  return 90000;
}

// FIX #9: Timescale-aware default duration instead of hardcoded values
function computeDefaultDuration(track, timescale) {
  if (track.defaultDurationNs) {
    return Math.max(1, Math.round((track.defaultDurationNs / 1e9) * timescale));
  }
  if (track.typeName === 'audio') {
    return 1024;
  }
  return Math.round(timescale / DEFAULT_FALLBACK_FPS);
}

function guessCodec(track) {
  const codecId = (track.codecId || '').toUpperCase();

  if (track.typeName === 'video') {
    if (codecId.includes('V_MPEG4/ISO/AVC')) {
      const avcc = extractAvcc(track);
      return avcc ? parseAvcCodecString(avcc) : 'avc1.640028';
    }
    if (codecId.includes('V_MPEGH/ISO/HEVC')) return 'hvc1.1.6.L93.B0';
    if (codecId.includes('V_AV1'))            return 'av01.0.04M.08';
    return 'avc1.640028';
  }

  if (codecId.includes('A_AAC')) {
    const ot = parseAacObjectType(extractAudioSpecificConfig(track));
    return `mp4a.40.${ot || 2}`;
  }
  if (codecId.includes('A_OPUS')) return 'opus';

  return 'mp4a.40.2';
}

function createSampleFlags(trackType, keyframe) {
  // depends-on-nothing | is-sync for keyframes / audio
  // depends-on-others | is-non-sync for P/B frames
  if (trackType === 'audio')  return 0x02000000;
  return keyframe ? 0x02000000 : 0x01010000;
}

function nsToTimescale(ns, timescale) {
  return Math.max(0, Math.round((ns / 1e9) * timescale));
}

// ─── FIX #1 & #2: Proper PTS / DTS / CTO Computation ───────────
//
// MKV timestamps = PTS (presentation time).
// MKV block order = decode order.
//
// Strategy:
//   1. Keep frames in original (decode) order — NEVER sort.
//   2. Sort PTS copies to produce candidate DTS values.
//   3. If any candidate DTS > its frame's PTS, shift ALL DTS back
//      by the worst-case overshoot so that DTS[i] <= PTS[i] always.
//   4. Ensure DTS remains strictly monotonically non-decreasing.
//   5. compositionOffset = PTS − DTS.

function computeDtsValues(ptsValues) {
  const n = ptsValues.length;
  if (n === 0) return [];
  if (n === 1) return [ptsValues[0]];

  const sorted = ptsValues.slice().sort((a, b) => a - b);

  // Find maximum overshoot where sorted[i] > pts[i]
  let maxOvershoot = 0;
  for (let i = 0; i < n; i++) {
    const overshoot = sorted[i] - ptsValues[i];
    if (overshoot > maxOvershoot) maxOvershoot = overshoot;
  }

  // If no overshoot the simple mapping works (constant frame rate)
  if (maxOvershoot === 0) return sorted;

  // Shift all DTS back by the overshoot amount
  const dts = sorted.map((v) => v - maxOvershoot);

  // Ensure monotonically non-decreasing after shift
  for (let i = 1; i < n; i++) {
    if (dts[i] <= dts[i - 1]) {
      dts[i] = dts[i - 1] + 1;
    }
  }

  // Final safety: clamp so DTS never exceeds PTS
  for (let i = 0; i < n; i++) {
    if (dts[i] > ptsValues[i]) {
      dts[i] = ptsValues[i];
    }
  }

  return dts;
}

function normalizeFrames(frames, track, timescale) {
  if (!frames.length) return [];

  const defDuration = computeDefaultDuration(track, timescale);

  // ── Audio: PTS == DTS, keep original order ──
  if (track.typeName === 'audio') {
    return frames.map((frame, i) => {
      const pts = nsToTimescale(frame.timestampNs, timescale);
      const nextPts = i < frames.length - 1
        ? nsToTimescale(frames[i + 1].timestampNs, timescale)
        : null;

      let duration = nextPts != null ? nextPts - pts : 0;
      if (duration <= 0 && frame.durationNs) {
        duration = nsToTimescale(frame.durationNs, timescale);
      }
      if (duration <= 0) duration = defDuration;

      return {
        dts: pts,
        pts,
        duration,
        compositionOffset: 0,
        size: frame.data.byteLength,
        flags: createSampleFlags('audio', true),
        data: frame.data,
        keyframe: true,
      };
    });
  }

  // ── Video: full PTS / DTS reorder ──
  // Step 1: Convert PTS to timescale units (keep decode order)
  const ptsValues = frames.map((f) => nsToTimescale(f.timestampNs, timescale));

  // Step 2: Compute DTS with reorder-buffer algorithm
  const dtsValues = computeDtsValues(ptsValues);

  // Step 3: Build sample list in decode order
  return frames.map((frame, i) => {
    const pts = ptsValues[i];
    const dts = dtsValues[i];

    // Duration from DTS gap
    let duration = i < dtsValues.length - 1
      ? dtsValues[i + 1] - dts
      : 0;

    if (duration <= 0 && frame.durationNs) {
      duration = nsToTimescale(frame.durationNs, timescale);
    }
    if (duration <= 0) duration = defDuration;

    return {
      dts,
      pts,
      duration,
      compositionOffset: pts - dts,
      size: frame.data.byteLength,
      flags: createSampleFlags('video', !!frame.keyframe),
      data: frame.data,
      keyframe: !!frame.keyframe,
    };
  });
}

// ─── Public API ─────────────────────────────────────────────────

export class MP4Muxer {
  constructor(track, options = {}) {
    this.track = track;
    this.options = options;

    this.trackId        = options.trackId || track.number || 1;
    this.timescale      = options.timescale || toTrackTimescale(track);
    this.sequenceNumber = 1;
    this.codec          = guessCodec(track);
    this.mimeType       = `${track.typeName}/mp4; codecs="${this.codec}"`;

    this.defaultDuration = computeDefaultDuration(track, this.timescale);
    // For video: default flags = non-sync (individual keyframes flagged in trun)
    // For audio: default flags = sync
    this.defaultFlags = track.typeName === 'audio' ? 0x02000000 : 0x01010000;
  }

  // FIX #12: Validate codecPrivate before claiming support
  static canMuxTrack(track) {
    const codec = (track.codecId || '').toUpperCase();

    if (track.typeName === 'video') {
      if (codec.includes('V_MPEG4/ISO/AVC')) {
        const priv = track.codecPrivate;
        return !!(priv && priv.byteLength > 6 && priv[0] === 1);
      }
      // HEVC / AV1 stsd generation not yet implemented
      return false;
    }

    if (track.typeName === 'audio') {
      return codec.includes('A_AAC') || codec.includes('A_OPUS');
    }

    return false;
  }

  getMimeType() {
    return this.mimeType;
  }

  createInitSegment(durationSeconds = 0) {
    const duration = durationSeconds > 0
      ? Math.round(durationSeconds * this.timescale)
      : 0;

    return concatUint8(
      makeFtyp(),
      makeMoov(
        this.track,
        this.timescale,
        duration,
        this.trackId,
        this.defaultDuration,
        this.defaultFlags
      )
    );
  }

  createMediaSegment(frames) {
    let samples = normalizeFrames(frames, this.track, this.timescale);
    if (!samples.length) return null;

    // FIX #15: Trim to first keyframe for video so decoder can start cleanly
    if (this.track.typeName === 'video') {
      const firstKF = samples.findIndex((s) => s.keyframe);
      if (firstKF < 0) {
        // No keyframe at all — segment is undecodable, skip it
        return null;
      }
      if (firstKF > 0) {
        samples = samples.slice(firstKF);
      }
    }

    if (!samples.length) return null;

    const baseDecodeTime = samples[0].dts;

    // Detect whether composition time offsets are needed
    const hasCTO = this.track.typeName === 'video' &&
      samples.some((s) => s.compositionOffset !== 0);

    const hasNegativeCTO = hasCTO &&
      samples.some((s) => s.compositionOffset < 0);

    const mdatPayload = concatUint8(...samples.map((s) => s.data));

    const moof = makeMoof(
      this.sequenceNumber,
      this.trackId,
      baseDecodeTime,
      samples,
      hasCTO,
      hasNegativeCTO,
      this.defaultDuration,
      this.defaultFlags
    );
    const mdat = box('mdat', mdatPayload);

    this.sequenceNumber += 1;

    const last = samples[samples.length - 1];

    return {
      segment: concatUint8(moof, mdat),
      baseDecodeTime,
      startTime: baseDecodeTime / this.timescale,
      endTime: (last.dts + last.duration) / this.timescale,
      sampleCount: samples.length,
      keyframe: samples.some((s) => s.keyframe),
    };
  }
}