export const EBML_IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  SegmentInfo: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  TrackLanguage: 0x22b59c,
  TrackName: 0x536e,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  DefaultDuration: 0x23e383,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
  CueTrack: 0xf7,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
};

const TEXT_DECODER = new TextDecoder();

// ─── Buffer Normalization ───────────────────────────────────────

function normalizeBuffer(input) {
  if (input instanceof Uint8Array) {
    return {
      buffer: input.buffer,
      byteOffset: input.byteOffset,
      byteLength: input.byteLength,
    };
  }
  if (input instanceof ArrayBuffer) {
    return { buffer: input, byteOffset: 0, byteLength: input.byteLength };
  }
  // FIX: Handle DataView and all other ArrayBuffer views (Int16Array, etc.)
  if (ArrayBuffer.isView(input)) {
    return {
      buffer: input.buffer,
      byteOffset: input.byteOffset,
      byteLength: input.byteLength,
    };
  }
  throw new Error('Unsupported buffer type');
}

// ─── EBML Reader ────────────────────────────────────────────────

export class EBMLReader {
  constructor(input, offset = 0) {
    const normalized = normalizeBuffer(input);
    this.data = new DataView(
      normalized.buffer,
      normalized.byteOffset,
      normalized.byteLength
    );
    // Direct Uint8Array view for fast byte access and zero-copy slicing
    this._bytes = new Uint8Array(
      normalized.buffer,
      normalized.byteOffset,
      normalized.byteLength
    );
    this.length = normalized.byteLength;
    this.offset = offset;
  }

  // FIX: Never return negative remaining
  get remaining() {
    return Math.max(0, this.length - this.offset);
  }

  // ── VINT Reading ──────────────────────────────────────────────
  //
  // EBML uses Variable-Size Integers (VINT):
  //   - The leading 1-bit (marker) indicates width.
  //   - For Element IDs: marker IS part of the value → use `raw`.
  //   - For Data Sizes: marker is NOT part of the value → use `value`.
  //   - All data bits set to 1 → "unknown/infinite" size.
  //
  // The code builds both `raw` and `value` in a single pass and detects
  // "all ones" without relying on large-number precision (fixes overflow
  // for 8-byte VINTs where 2^56−1 > Number.MAX_SAFE_INTEGER).

  readVintRaw(maxWidth = 8) {
    if (this.offset >= this.length) return null;

    const first = this.data.getUint8(this.offset);
    let width = 1;
    let marker = 0x80;

    while (width <= maxWidth && (first & marker) === 0) {
      marker >>= 1;
      width += 1;
    }

    if (width > maxWidth || width > 8) return null;
    if (this.offset + width > this.length) return null;

    // Single-pass: build raw (full bytes) and value (marker stripped)
    const valueMask = marker - 1;
    let raw = first;
    let value = first & valueMask;

    // FIX: Detect unknown/infinite size by checking actual bits
    // instead of comparing against a possibly-imprecise maxValue.
    // "All ones" = first byte's data bits all 1, all subsequent bytes 0xFF.
    let isAllOnes = (first & valueMask) === valueMask;

    for (let i = 1; i < width; i += 1) {
      const byte = this.data.getUint8(this.offset + i);
      raw = raw * 256 + byte;
      value = value * 256 + byte;
      if (byte !== 0xff) isAllOnes = false;
    }

    this.offset += width;

    return {
      width,
      marker,
      raw,
      value,
      isAllOnes,
    };
  }

  readVint(maxWidth = 8) {
    return this.readVintRaw(maxWidth);
  }

  // Element IDs are max 4 bytes — well within safe integer range.
  readElementID() {
    return this.readVintRaw(4);
  }

  readElementHeader() {
    if (this.remaining < 2) return null;

    const elementOffset = this.offset;
    const idInfo = this.readElementID();
    if (!idInfo) return null;

    const sizeInfo = this.readVint();
    if (!sizeInfo) return null;

    const dataOffset = this.offset;

    return {
      id: idInfo.raw,       // raw includes marker bit → correct for EBML IDs
      idWidth: idInfo.width,
      sizeWidth: sizeInfo.width,
      dataOffset,
      dataSize: sizeInfo.isAllOnes ? -1 : sizeInfo.value,
      headerSize: idInfo.width + sizeInfo.width,
      elementOffset,
    };
  }

  // ── Integer Reading ───────────────────────────────────────────

  // FIX: Use DataView methods for common sizes (faster, avoids
  // manual byte assembly). General path uses multiplication
  // (avoids 32-bit truncation from bitwise shifts).
  readUint(size) {
    if (size <= 0 || this.offset + size > this.length) return 0;

    let value;
    switch (size) {
      case 1:
        value = this.data.getUint8(this.offset);
        break;
      case 2:
        value = this.data.getUint16(this.offset, false);
        break;
      case 3:
        value =
          (this.data.getUint8(this.offset) << 16) |
          (this.data.getUint8(this.offset + 1) << 8) |
          this.data.getUint8(this.offset + 2);
        break;
      case 4:
        value = this.data.getUint32(this.offset, false);
        break;
      default:
        // General path for 5–8 byte values.
        // Precision is safe up to 6 bytes (48 bits < 2^53).
        // 7–8 byte values above 2^53 will lose low bits.
        value = 0;
        for (let i = 0; i < size; i += 1) {
          value = value * 256 + this.data.getUint8(this.offset + i);
        }
        break;
    }

    this.offset += size;
    return value;
  }

  // FIX: Sign detection uses comparison instead of bitwise AND.
  // The original `if (value & signBit)` uses bitwise AND which
  // truncates both operands to 32-bit signed integers — this
  // silently breaks for sizes > 4 because the sign bit position
  // exceeds 2^31.
  readInt(size) {
    if (size <= 0 || this.offset + size > this.length) return 0;

    let value;
    switch (size) {
      case 1:
        value = this.data.getInt8(this.offset);
        break;
      case 2:
        value = this.data.getInt16(this.offset, false);
        break;
      case 4:
        value = this.data.getInt32(this.offset, false);
        break;
      default: {
        // General case: works correctly for sizes 3, 5, 6, 7, 8.
        value = 0;
        for (let i = 0; i < size; i += 1) {
          value = value * 256 + this.data.getUint8(this.offset + i);
        }
        // Two's complement sign extension via comparison (not bitwise).
        const halfRange = 2 ** (size * 8 - 1);
        if (value >= halfRange) {
          value -= 2 ** (size * 8);
        }
        break;
      }
    }

    this.offset += size;
    return value;
  }

  // FIX: Explicit big-endian parameter (EBML is always big-endian).
  // DataView defaults to big-endian, but being explicit prevents
  // accidental breakage and documents intent.
  readFloat(size) {
    if (this.offset + size > this.length) return 0;

    let value;
    if (size === 4) {
      value = this.data.getFloat32(this.offset, false);
    } else if (size === 8) {
      value = this.data.getFloat64(this.offset, false);
    } else {
      // EBML only defines 4-byte and 8-byte floats.
      // Skip unknown float sizes gracefully.
      this.offset += size;
      return 0;
    }

    this.offset += size;
    return value;
  }

  // ── String / Binary Reading ───────────────────────────────────

  // FIX: Use subarray (zero-copy view) for TextDecoder input.
  // TextDecoder.decode() is synchronous, so the view is safe.
  readString(size) {
    if (size <= 0 || this.offset + size > this.length) return '';
    const bytes = this._bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return TEXT_DECODER.decode(bytes).replace(/\0+$/, '');
  }

  // Returns an owned copy — safe to retain after the underlying buffer
  // is released or reused (e.g., frame data passed to muxer / MSE).
  // FIX: Use .slice() instead of `new Uint8Array(view)` — same
  // semantics but cleaner and avoids an intermediate view allocation.
  readBytes(size) {
    if (size <= 0 || this.offset + size > this.length) return new Uint8Array(0);
    const start = this.offset;
    this.offset += size;
    return this._bytes.slice(start, start + size);
  }

  // Returns a zero-copy view into the underlying buffer.
  // Faster, but caller MUST NOT retain the view if the buffer can be
  // reused (e.g., network fetch buffers). Safe for transient reads
  // within a single parse pass.
  readBytesView(size) {
    if (size <= 0 || this.offset + size > this.length) return new Uint8Array(0);
    const view = this._bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return view;
  }

  skip(size) {
    if (size <= 0) return;
    this.offset = Math.min(this.length, this.offset + size);
  }

  // ── Inspection / Recovery Utilities ───────────────────────────

  // Peek at a byte at `ahead` offset from current position.
  // Returns -1 if out of bounds.
  peekUint8(ahead = 0) {
    const pos = this.offset + ahead;
    if (pos < 0 || pos >= this.length) return -1;
    return this.data.getUint8(pos);
  }

  // Scan forward for a known element ID byte pattern (for error recovery).
  // Returns absolute offset within the reader, or -1 if not found.
  // Does NOT advance the reader position.
  scanForElementId(targetId, maxScanBytes) {
    // Decompose the ID into its byte sequence
    const idBytes = [];
    let tmp = targetId;
    while (tmp > 0) {
      idBytes.unshift(tmp & 0xff);
      tmp = Math.floor(tmp / 256);
    }
    if (!idBytes.length) return -1;

    const patLen = idBytes.length;
    const limit = Math.min(
      this.length - patLen + 1,
      this.offset + maxScanBytes
    );

    for (let pos = this.offset; pos < limit; pos += 1) {
      let match = true;
      for (let j = 0; j < patLen; j += 1) {
        if (this._bytes[pos + j] !== idBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) return pos;
    }

    return -1;
  }
}

// ─── Signed EBML VINT (for EBML lacing size deltas) ─────────────

function readSignedEbmlVint(reader) {
  const vint = reader.readVint();
  if (!vint) return null;

  // Signed EBML VINT: value is biased by 2^(7*width − 1) − 1
  //   width=1 → bias=63,   range [−63 … +64]
  //   width=2 → bias=8191, range [−8191 … +8192]
  const bias = 2 ** (7 * vint.width - 1) - 1;
  return vint.value - bias;
}

// ─── Lacing Size Parsers ────────────────────────────────────────
//
// After block header bytes (track + timecode + flags + frame count),
// the reader is positioned at the lacing size data. The lacing
// parsers consume the size descriptors and leave the reader at
// the start of frame data.
//
// The LAST frame's size is always "whatever data remains after
// accounting for all preceding frame sizes."

function parseXiphLaceSizes(reader, frameCount) {
  const sizes = [];
  let totalPrecedingSizes = 0;

  for (let i = 0; i < frameCount - 1; i += 1) {
    let frameSize = 0;
    // Xiph encoding: sum consecutive bytes until one is < 0xFF
    while (reader.remaining > 0) {
      const byte = reader.readUint(1);
      frameSize += byte;
      if (byte !== 0xff) break;
    }
    sizes.push(frameSize);
    totalPrecedingSizes += frameSize;
  }

  // FIX: Check for corrupt data where preceding sizes exceed available data
  const lastSize = reader.remaining - totalPrecedingSizes;
  if (lastSize < 0) {
    // Return what we have — parseBlockPayload will handle truncation
    return sizes;
  }
  sizes.push(lastSize);
  return sizes;
}

function parseFixedLaceSizes(reader, frameCount) {
  if (frameCount <= 0 || reader.remaining <= 0) return [];
  const frameSize = Math.floor(reader.remaining / frameCount);
  if (frameSize <= 0) return [];
  return new Array(frameCount).fill(frameSize);
}

function parseEbmlLaceSizes(reader, frameCount) {
  const sizes = [];

  // First frame size: unsigned VINT
  const first = reader.readVint();
  if (!first) return [];
  sizes.push(first.value);
  let lastSize = first.value;

  // Intermediate frame sizes: signed deltas from previous
  for (let i = 1; i < frameCount - 1; i += 1) {
    const diff = readSignedEbmlVint(reader);
    if (diff == null) break; // corrupt — return what we have
    lastSize += diff;
    sizes.push(Math.max(0, lastSize));
  }

  // Last frame: remaining data minus all preceding frame sizes
  const consumed = sizes.reduce((acc, val) => acc + val, 0);
  const lastFrameSize = reader.remaining - consumed;
  if (lastFrameSize < 0) {
    return sizes; // corrupt — return partial
  }
  sizes.push(lastFrameSize);
  return sizes;
}

// ─── Block Payload Parser ───────────────────────────────────────
//
// Parses the payload of a SimpleBlock or Block element.
//
// Layout: trackNumber(VINT) + relativeTimecode(int16) + flags(uint8)
//         + [frameCount(uint8)] + [laceSizes] + frameData
//
// For SimpleBlock: flags byte bit 7 = keyframe, bit 0 = discardable.
// For Block (in BlockGroup): those bits are reserved / zero; keyframe
// status is determined by the absence of ReferenceBlock children
// in the parent BlockGroup (handled by the demuxer, not here).

export function parseBlockPayload(payload) {
  if (!payload || payload.byteLength < 4) return null;

  const reader = new EBMLReader(payload);

  // Track number (VINT-encoded, unsigned)
  const track = reader.readVint();
  if (!track || track.value === 0) return null;

  // Need at least 3 more bytes: timecode (2) + flags (1)
  if (reader.remaining < 3) return null;

  const timecode = reader.readInt(2); // signed relative timecode
  const flags = reader.readUint(1);

  const keyframe = (flags & 0x80) !== 0;
  const invisible = (flags & 0x08) !== 0;
  const lacingType = (flags & 0x06) >> 1;
  const discardable = (flags & 0x01) !== 0;

  let frameSizes;

  if (lacingType === 0) {
    // No lacing — single frame, all remaining data
    frameSizes = [reader.remaining];
  } else {
    if (reader.remaining < 1) return null;
    const frameCount = reader.readUint(1) + 1;

    // Sanity check: MKV spec doesn't restrict count, but >256 is suspicious
    if (frameCount <= 0 || frameCount > 256) return null;

    switch (lacingType) {
      case 1:
        frameSizes = parseXiphLaceSizes(reader, frameCount);
        break;
      case 2:
        frameSizes = parseFixedLaceSizes(reader, frameCount);
        break;
      case 3:
        frameSizes = parseEbmlLaceSizes(reader, frameCount);
        break;
      default:
        frameSizes = [reader.remaining];
    }

    // Fallback if lace parse failed completely
    if (!frameSizes || !frameSizes.length) {
      frameSizes = [reader.remaining];
    }
  }

  // ── Read frame data ──
  const frames = [];
  for (let i = 0; i < frameSizes.length; i += 1) {
    const frameSize = frameSizes[i];
    if (frameSize <= 0) continue;           // skip zero-size frames
    if (reader.remaining < frameSize) break; // insufficient data — stop

    const data = reader.readBytes(frameSize);
    frames.push({
      trackNumber: track.value,
      relativeTimecode: timecode,
      // Keyframe flag from block header applies uniformly to all frames
      // in the block. For BlockGroup blocks, the demuxer overrides this
      // based on ReferenceBlock presence.
      keyframe,
      invisible,
      discardable,
      frameIndex: i,
      data,
    });
  }

  if (!frames.length) return null;

  return {
    trackNumber: track.value,
    relativeTimecode: timecode,
    keyframe,
    invisible,
    discardable,
    lacingType,
    frames,
  };
}

// ─── Utility ────────────────────────────────────────────────────

export function toArrayBufferView(buffer, byteOffset = 0, byteLength) {
  const normalized = normalizeBuffer(buffer);
  const length =
    byteLength == null
      ? normalized.byteLength - byteOffset
      : byteLength;
  return new Uint8Array(
    normalized.buffer,
    normalized.byteOffset + byteOffset,
    length
  );
}