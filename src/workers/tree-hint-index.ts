export interface TileHint {
  count: number;
  coniferRatio: number;
}

const MAGIC = 'TREE';
const RECORD_SIZE = 7;
const DEFAULT_ZOOM = 10;

function packKey(x: number, y: number): number {
  return (x << 16) | y;
}

function packValue(count: number, coniferRatioUint8: number): number {
  return (count << 8) | coniferRatioUint8;
}

function unpackValue(packed: number): TileHint {
  return {
    count: packed >>> 8,
    coniferRatio: (packed & 0xff) / 255,
  };
}

/**
 * Read-only index over tree hint records. Sorted files stay in their compact
 * binary representation; legacy unsorted/duplicate files use a compatibility
 * Map that preserves the previous last-record-wins behavior.
 */
export class TreeHintIndex {
  readonly version: 1 | 2;
  readonly zoom: number;
  readonly tileCount: number;
  readonly storageMode: 'binary' | 'map' | 'empty';

  private constructor(
    private readonly data: DataView | null,
    private readonly recordsOffset: number,
    version: 1 | 2,
    zoom: number,
    tileCount: number,
    storageMode: 'binary' | 'map' | 'empty',
    private readonly compatibilityMap: Map<number, number> | null
  ) {
    this.version = version;
    this.zoom = zoom;
    this.tileCount = tileCount;
    this.storageMode = storageMode;
  }

  static empty(zoom: number = DEFAULT_ZOOM): TreeHintIndex {
    return new TreeHintIndex(null, 0, 2, zoom, 0, 'empty', null);
  }

  static parse(buffer: ArrayBuffer): TreeHintIndex {
    if (buffer.byteLength < 6) {
      throw new Error('tree-tiles.bin header is truncated');
    }

    const data = new DataView(buffer);
    const magic = String.fromCharCode(
      data.getUint8(0),
      data.getUint8(1),
      data.getUint8(2),
      data.getUint8(3)
    );
    if (magic !== MAGIC) {
      throw new Error('Invalid tree-tiles.bin magic bytes');
    }

    const rawVersion = data.getUint8(4);
    if (rawVersion !== 1 && rawVersion !== 2) {
      throw new Error(`Unsupported tree-tiles.bin version: ${rawVersion}`);
    }
    const version = rawVersion as 1 | 2;
    const zoom = data.getUint8(5);
    const recordsOffset = version === 1 ? 8 : 10;
    if (buffer.byteLength < recordsOffset) {
      throw new Error(`tree-tiles.bin v${version} header is truncated`);
    }

    const tileCount = version === 1
      ? data.getUint16(6, true)
      : data.getUint32(6, true);
    const expectedLength = recordsOffset + tileCount * RECORD_SIZE;
    if (buffer.byteLength !== expectedLength) {
      throw new Error(
        `tree-tiles.bin length mismatch: expected ${expectedLength}, got ${buffer.byteLength}`
      );
    }

    let previousX = -1;
    let previousY = -1;
    let sortedUnique = true;
    for (let index = 0; index < tileCount; index++) {
      const offset = recordsOffset + index * RECORD_SIZE;
      const x = data.getUint16(offset, true);
      const y = data.getUint16(offset + 2, true);
      if (y < previousY || (y === previousY && x <= previousX)) {
        sortedUnique = false;
        break;
      }
      previousX = x;
      previousY = y;
    }

    if (sortedUnique) {
      return new TreeHintIndex(
        data,
        recordsOffset,
        version,
        zoom,
        tileCount,
        'binary',
        null
      );
    }

    const compatibilityMap = new Map<number, number>();
    for (let index = 0; index < tileCount; index++) {
      const offset = recordsOffset + index * RECORD_SIZE;
      compatibilityMap.set(
        packKey(data.getUint16(offset, true), data.getUint16(offset + 2, true)),
        packValue(data.getUint16(offset + 4, true), data.getUint8(offset + 6))
      );
    }
    return new TreeHintIndex(
      null,
      0,
      version,
      zoom,
      tileCount,
      'map',
      compatibilityMap
    );
  }

  get(x: number, y: number): TileHint | null {
    if (
      !Number.isInteger(x)
      || !Number.isInteger(y)
      || x < 0
      || x > 0xffff
      || y < 0
      || y > 0xffff
    ) {
      return null;
    }

    if (this.compatibilityMap) {
      const packed = this.compatibilityMap.get(packKey(x, y));
      return packed === undefined ? null : unpackValue(packed);
    }
    if (!this.data) return null;

    let low = 0;
    let high = this.tileCount - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const offset = this.recordsOffset + middle * RECORD_SIZE;
      const recordX = this.data.getUint16(offset, true);
      const recordY = this.data.getUint16(offset + 2, true);

      if (recordY === y && recordX === x) {
        return {
          count: this.data.getUint16(offset + 4, true),
          coniferRatio: this.data.getUint8(offset + 6) / 255,
        };
      }
      if (recordY < y || (recordY === y && recordX < x)) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return null;
  }
}

export type TreeHintBufferLoader = (url: string) => Promise<ArrayBuffer>;

/** URL-aware loader with last-request-wins replacement and graceful empty state. */
export class TreeHintIndexLoader {
  private index: TreeHintIndex | null = null;
  private successfulUrl: string | null = null;
  private requestGeneration = 0;
  private pending: {
    url: string;
    generation: number;
    promise: Promise<void>;
  } | null = null;

  get zoom(): number {
    return this.index?.zoom ?? DEFAULT_ZOOM;
  }

  get(x: number, y: number): TileHint | null {
    return this.index?.get(x, y) ?? null;
  }

  async load(url: string, loadBuffer: TreeHintBufferLoader): Promise<void> {
    if (this.index && this.successfulUrl === url) return;
    if (this.pending?.url === url) return this.pending.promise;

    const generation = ++this.requestGeneration;
    this.index = null;
    this.successfulUrl = null;
    const promise = (async () => {
      try {
        const nextIndex = TreeHintIndex.parse(await loadBuffer(url));
        if (this.requestGeneration === generation) {
          this.index = nextIndex;
          this.successfulUrl = url;
        }
      } catch (error) {
        if (this.requestGeneration === generation) {
          // Consumers degrade gracefully, but the URL remains retryable.
          this.index = TreeHintIndex.empty();
          this.successfulUrl = null;
        }
        throw error;
      }
    })();
    this.pending = { url, generation, promise };

    try {
      await promise;
    } finally {
      if (this.pending?.generation === generation) this.pending = null;
    }
  }
}
