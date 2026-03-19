const DEFAULT_RANGE_CHUNK = 2 * 1024 * 1024;

export class DataSource {
  constructor(source) {
    this.source = source;
    this.isLocal = source instanceof File;
    this.isRemote = typeof source === 'string';
    this.totalSize = 0;
    this.supportsRanges = true;
    this._initialized = false;
    this._cache = new Map();
  }

  async init() {
    if (this._initialized) return;

    if (this.isLocal) {
      this.totalSize = this.source.size;
      this.supportsRanges = true;
      this._initialized = true;
      return;
    }

    if (!this.isRemote) {
      throw new Error('Unsupported source type');
    }

    await this._initRemoteMetadata();
    this._initialized = true;
  }

  async _initRemoteMetadata() {
    try {
      const res = await fetch(this.source, {
        method: 'HEAD',
        cache: 'no-store',
      });
      if (res.ok) {
        const len = Number(res.headers.get('content-length') || 0);
        const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase();
        if (len > 0) this.totalSize = len;
        this.supportsRanges = acceptRanges.includes('bytes');
      }
    } catch (_) {
      // Fallback to probe via range GET
    }

    if (this.totalSize > 0 && this.supportsRanges) return;

    const probeRes = await fetch(this.source, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });

    if (probeRes.status === 206) {
      const contentRange = probeRes.headers.get('content-range') || '';
      const match = contentRange.match(/\/([0-9]+)$/);
      if (match) {
        this.totalSize = Number(match[1]);
      }
      this.supportsRanges = true;
      return;
    }

    if (probeRes.status === 200) {
      const buffer = await probeRes.arrayBuffer();
      this.totalSize = buffer.byteLength;
      this.supportsRanges = false;
      this._cache.set('full', new Uint8Array(buffer));
      return;
    }

    throw new Error(`Unable to probe source metadata (${probeRes.status})`);
  }

  _clampRange(start, endExclusive) {
    if (!Number.isFinite(start) || !Number.isFinite(endExclusive)) {
      throw new Error('Invalid range');
    }
    if (start < 0) start = 0;
    if (endExclusive < start) endExclusive = start;
    if (this.totalSize > 0) {
      start = Math.min(start, this.totalSize);
      endExclusive = Math.min(endExclusive, this.totalSize);
    }
    return { start: Math.floor(start), endExclusive: Math.floor(endExclusive) };
  }

  async readRange(start, endExclusive) {
    if (!this._initialized) {
      await this.init();
    }

    const clamped = this._clampRange(start, endExclusive);
    if (clamped.endExclusive <= clamped.start) {
      return new Uint8Array(0);
    }

    if (this.isLocal) {
      const slice = this.source.slice(clamped.start, clamped.endExclusive);
      return new Uint8Array(await slice.arrayBuffer());
    }

    if (!this.supportsRanges) {
      let full = this._cache.get('full');
      if (!full) {
        const res = await fetch(this.source, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to download source (${res.status})`);
        }
        full = new Uint8Array(await res.arrayBuffer());
        this._cache.set('full', full);
        if (!this.totalSize) this.totalSize = full.byteLength;
      }
      return full.subarray(clamped.start, clamped.endExclusive);
    }

    // Retry with exponential backoff for network resilience
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const res = await fetch(this.source, {
          headers: { Range: `bytes=${clamped.start}-${clamped.endExclusive - 1}` },
          cache: 'no-store',
        });

        if (res.status === 206) {
          return new Uint8Array(await res.arrayBuffer());
        }

        if (res.status === 200) {
          // Server ignored range. Cache full response once and slice from it.
          const full = new Uint8Array(await res.arrayBuffer());
          this._cache.set('full', full);
          this.supportsRanges = false;
          this.totalSize = full.byteLength;
          return full.subarray(clamped.start, clamped.endExclusive);
        }

        throw new Error(`Range request failed (${res.status})`);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error('Range request failed after retries');
  }

  async readChunk(offset, size = DEFAULT_RANGE_CHUNK) {
    return this.readRange(offset, offset + size);
  }

  destroy() {
    this._cache.clear();
  }
}
