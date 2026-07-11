import { describe, expect, it, vi } from 'vitest';
import {
  TreeHintIndex,
  TreeHintIndexLoader,
} from '../src/workers/tree-hint-index.js';

interface RecordData {
  x: number;
  y: number;
  count: number;
  conifer: number;
}

function createBuffer(version: 1 | 2, zoom: number, records: RecordData[]): ArrayBuffer {
  const headerSize = version === 1 ? 8 : 10;
  const buffer = new ArrayBuffer(headerSize + records.length * 7);
  const data = new DataView(buffer);
  for (const [index, byte] of [...'TREE'].entries()) {
    data.setUint8(index, byte.charCodeAt(0));
  }
  data.setUint8(4, version);
  data.setUint8(5, zoom);
  if (version === 1) data.setUint16(6, records.length, true);
  else data.setUint32(6, records.length, true);

  for (let index = 0; index < records.length; index++) {
    const offset = headerSize + index * 7;
    const record = records[index];
    data.setUint16(offset, record.x, true);
    data.setUint16(offset + 2, record.y, true);
    data.setUint16(offset + 4, record.count, true);
    data.setUint8(offset + 6, record.conifer);
  }
  return buffer;
}

function updateChecksum(checksum: number, value: number): number {
  return Math.imul(checksum ^ value, 0x01000193) >>> 0;
}

describe('TreeHintIndex', () => {
  it.each([1, 2] as const)('parses sorted v%s data with exact values', (version) => {
    const index = TreeHintIndex.parse(createBuffer(version, 15, [
      { x: 0x1234, y: 2, count: 0x4321, conifer: 0 },
      { x: 0xabcd, y: 2, count: 65535, conifer: 255 },
      { x: 4, y: 3, count: 7, conifer: 128 },
    ]));

    expect(index).toMatchObject({ version, zoom: 15, tileCount: 3, storageMode: 'binary' });
    expect(index.get(0x1234, 2)).toEqual({ count: 0x4321, coniferRatio: 0 });
    expect(index.get(0xabcd, 2)).toEqual({ count: 65535, coniferRatio: 1 });
    expect(index.get(4, 3)).toEqual({ count: 7, coniferRatio: 128 / 255 });
    expect(index.get(5, 3)).toBeNull();
    expect(index.get(-1, 2)).toBeNull();
    expect(index.get(65536, 2)).toBeNull();
    expect(index.get(4.5, 3)).toBeNull();
  });

  it('falls back for unsorted and duplicate records with last-write behavior', () => {
    const unsorted = TreeHintIndex.parse(createBuffer(2, 10, [
      { x: 5, y: 2, count: 10, conifer: 20 },
      { x: 1, y: 1, count: 30, conifer: 40 },
    ]));
    const duplicate = TreeHintIndex.parse(createBuffer(2, 10, [
      { x: 1, y: 1, count: 10, conifer: 20 },
      { x: 1, y: 1, count: 30, conifer: 40 },
    ]));

    expect(unsorted.storageMode).toBe('map');
    expect(unsorted.get(5, 2)).toEqual({ count: 10, coniferRatio: 20 / 255 });
    expect(duplicate.storageMode).toBe('map');
    expect(duplicate.get(1, 1)).toEqual({ count: 30, coniferRatio: 40 / 255 });
  });

  it('rejects malformed headers, versions, and record lengths', () => {
    expect(() => TreeHintIndex.parse(new ArrayBuffer(5))).toThrow('header is truncated');

    const badMagic = createBuffer(2, 10, []);
    new DataView(badMagic).setUint8(0, 0);
    expect(() => TreeHintIndex.parse(badMagic)).toThrow('magic bytes');

    const badVersion = createBuffer(2, 10, []);
    new DataView(badVersion).setUint8(4, 3);
    expect(() => TreeHintIndex.parse(badVersion)).toThrow('Unsupported');

    const valid = createBuffer(2, 10, [{ x: 1, y: 1, count: 1, conifer: 1 }]);
    expect(() => TreeHintIndex.parse(valid.slice(0, -1))).toThrow('length mismatch');
    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(new Uint8Array(valid));
    expect(() => TreeHintIndex.parse(trailing.buffer)).toThrow('length mismatch');
  });

  it('reloads on URL changes and retries the same URL after an error', async () => {
    const buffers = new Map([
      ['a', createBuffer(2, 10, [{ x: 1, y: 1, count: 10, conifer: 20 }])],
      ['b', createBuffer(2, 12, [{ x: 2, y: 2, count: 30, conifer: 40 }])],
    ]);
    const loadBuffer = vi.fn(async (url: string) => {
      const buffer = buffers.get(url);
      if (!buffer) throw new Error('network failure');
      return buffer;
    });
    const loader = new TreeHintIndexLoader();

    await loader.load('a', loadBuffer);
    await loader.load('a', loadBuffer);
    expect(loadBuffer).toHaveBeenCalledTimes(1);
    expect(loader.get(1, 1)?.count).toBe(10);

    await loader.load('b', loadBuffer);
    expect(loader.zoom).toBe(12);
    expect(loader.get(1, 1)).toBeNull();
    expect(loader.get(2, 2)?.count).toBe(30);

    await expect(loader.load('error', loadBuffer)).rejects.toThrow('network failure');
    expect(loader.get(2, 2)).toBeNull();
    buffers.set('error', createBuffer(2, 14, [
      { x: 3, y: 3, count: 50, conifer: 60 },
    ]));
    await loader.load('error', loadBuffer);
    expect(loadBuffer).toHaveBeenCalledTimes(4);
    expect(loader.zoom).toBe(14);
    expect(loader.get(3, 3)?.count).toBe(50);
  });

  it('ignores stale A1 success after a B to A2 interleave', async () => {
    const staleFirstBuffer = createBuffer(2, 10, [
      { x: 1, y: 1, count: 10, conifer: 20 },
    ]);
    const middleBuffer = createBuffer(2, 11, [
      { x: 2, y: 2, count: 30, conifer: 40 },
    ]);
    const latestFirstBuffer = createBuffer(2, 12, [
      { x: 3, y: 3, count: 50, conifer: 60 },
    ]);
    let resolveFirst!: (buffer: ArrayBuffer) => void;
    const delayedFirst = new Promise<ArrayBuffer>((resolve) => {
      resolveFirst = resolve;
    });
    const loader = new TreeHintIndexLoader();
    let firstCalls = 0;
    const loadBuffer = (url: string) => {
      if (url === 'first' && firstCalls++ === 0) return delayedFirst;
      return Promise.resolve(url === 'middle' ? middleBuffer : latestFirstBuffer);
    };

    const staleLoad = loader.load('first', loadBuffer);
    await loader.load('middle', loadBuffer);
    await loader.load('first', loadBuffer);
    resolveFirst(staleFirstBuffer);
    await staleLoad;

    expect(loader.zoom).toBe(12);
    expect(loader.get(1, 1)).toBeNull();
    expect(loader.get(2, 2)).toBeNull();
    expect(loader.get(3, 3)?.count).toBe(50);
  });

  it('ignores stale A1 failure after a B to A2 interleave', async () => {
    const middleBuffer = createBuffer(2, 11, [
      { x: 2, y: 2, count: 30, conifer: 40 },
    ]);
    const latestFirstBuffer = createBuffer(2, 12, [
      { x: 3, y: 3, count: 50, conifer: 60 },
    ]);
    let rejectFirst!: (error: Error) => void;
    const delayedFailure = new Promise<ArrayBuffer>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const loader = new TreeHintIndexLoader();
    let firstCalls = 0;
    const loadBuffer = (url: string) => {
      if (url === 'first' && firstCalls++ === 0) return delayedFailure;
      return Promise.resolve(url === 'middle' ? middleBuffer : latestFirstBuffer);
    };

    const staleLoad = loader.load('first', loadBuffer);
    await loader.load('middle', loadBuffer);
    await loader.load('first', loadBuffer);
    rejectFirst(new Error('stale failure'));
    await expect(staleLoad).rejects.toThrow('stale failure');

    expect(loader.zoom).toBe(12);
    expect(loader.get(2, 2)).toBeNull();
    expect(loader.get(3, 3)?.count).toBe(50);
  });

  it('coalesces same-URL loads within the current generation', async () => {
    const buffer = createBuffer(2, 10, [
      { x: 1, y: 1, count: 10, conifer: 20 },
    ]);
    let resolveLoad!: (buffer: ArrayBuffer) => void;
    const delayedBuffer = new Promise<ArrayBuffer>((resolve) => {
      resolveLoad = resolve;
    });
    const loadBuffer = vi.fn(() => delayedBuffer);
    const loader = new TreeHintIndexLoader();

    const first = loader.load('same', loadBuffer);
    const second = loader.load('same', loadBuffer);
    expect(loadBuffer).toHaveBeenCalledTimes(1);
    resolveLoad(buffer);
    await Promise.all([first, second]);

    expect(loader.get(1, 1)?.count).toBe(10);
  });

  it('matches every record in the public v2 asset', async () => {
    // Node types are intentionally absent from the browser-focused project.
    const nodeFsModule = 'node:fs';
    const { readFileSync } = await import(nodeFsModule) as {
      readFileSync(path: URL): Uint8Array;
    };
    const file = readFileSync(new URL('../public/tree-tiles.bin', import.meta.url));
    const buffer = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength
    ) as ArrayBuffer;
    const data = new DataView(buffer);
    const index = TreeHintIndex.parse(buffer);
    let expectedChecksum = 0x811c9dc5;
    let actualChecksum = 0x811c9dc5;
    let mismatches = 0;

    expect(index).toMatchObject({
      version: 2,
      zoom: 15,
      tileCount: 801_193,
      storageMode: 'binary',
    });

    for (let recordIndex = 0; recordIndex < index.tileCount; recordIndex++) {
      const offset = 10 + recordIndex * 7;
      const x = data.getUint16(offset, true);
      const y = data.getUint16(offset + 2, true);
      const count = data.getUint16(offset + 4, true);
      const conifer = data.getUint8(offset + 6);
      const hint = index.get(x, y);
      const actualCount = hint?.count ?? -1;
      const actualConifer = hint ? Math.round(hint.coniferRatio * 255) : -1;
      if (actualCount !== count || actualConifer !== conifer) mismatches++;

      for (const value of [x, y, count, conifer]) {
        expectedChecksum = updateChecksum(expectedChecksum, value);
      }
      for (const value of [x, y, actualCount, actualConifer]) {
        actualChecksum = updateChecksum(actualChecksum, value);
      }
    }

    expect(mismatches).toBe(0);
    expect(actualChecksum).toBe(expectedChecksum);
  });
});
