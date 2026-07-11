import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeocoderHttpError,
  GeocoderNetworkError,
  GeocoderResponseError,
  GeocoderTimeoutError,
  searchGeocoder,
} from '../src/geocoder.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('direct geocoder search', () => {
  it('preserves endpoint/query semantics and parses a results envelope', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      results: [
        { lat: 43.77, lon: 11.25 },
        { lat: Number.NaN, lon: 0 },
        { lat: 1, lon: Number.POSITIVE_INFINITY },
        { lat: 90.01, lon: 0 },
        { lat: -90.01, lon: 0 },
        { lat: 0, lon: 180.01 },
        { lat: 0, lon: -180.01 },
      ],
    }), { status: 200 }));

    await expect(searchGeocoder('New York', { limit: 1, fetchImpl })).resolves.toEqual([
      { lat: 43.77, lon: 11.25 },
    ]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://geocoder.bradr.dev/search?q=New+York&format=jsonv2&limit=1'
    );
    expect(init).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts an array response and finite numeric strings', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([
      { lat: '42.36', lon: '-71.06' },
      { lat: '-90', lon: '180' },
      { lat: '', lon: '1' },
      { lat: 'not-a-number', lon: '1' },
      null,
    ])));

    await expect(searchGeocoder('Boston', { fetchImpl })).resolves.toEqual([
      { lat: 42.36, lon: -71.06 },
      { lat: -90, lon: 180 },
    ]);
  });

  it('returns no results for an unexpected but valid JSON shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    await expect(searchGeocoder('Nowhere', { fetchImpl })).resolves.toEqual([]);
  });

  it('distinguishes HTTP failures and retains the status', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', {
      status: 503,
      statusText: 'Service Unavailable',
    }));

    try {
      await searchGeocoder('Florence', { fetchImpl });
      throw new Error('Expected geocoder search to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GeocoderHttpError);
      expect(error).toMatchObject({
        status: 503,
        statusText: 'Service Unavailable',
      });
    }
  });

  it('distinguishes network failures and preserves their cause', async () => {
    const cause = new TypeError('fetch failed');
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw cause; });

    try {
      await searchGeocoder('Florence', { fetchImpl });
      throw new Error('Expected geocoder search to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GeocoderNetworkError);
      expect((error as Error).cause).toBe(cause);
    }
  });

  it('aborts and distinguishes requests that exceed the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

    const request = searchGeocoder('Florence', { fetchImpl, timeoutMs: 25 });
    const rejection = expect(request).rejects.toBeInstanceOf(GeocoderTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while consuming a stalled response body', async () => {
    vi.useFakeTimers();
    const observed: { signal?: AbortSignal } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) observed.signal = init.signal;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => new Promise<unknown>(() => {}),
      } as Response;
    };

    const request = searchGeocoder('Florence', { fetchImpl, timeoutMs: 25 });
    const rejection = expect(request).rejects.toBeInstanceOf(GeocoderTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(observed.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes invalid JSON responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('not JSON'));
    await expect(searchGeocoder('Florence', { fetchImpl }))
      .rejects.toBeInstanceOf(GeocoderResponseError);
  });
});
