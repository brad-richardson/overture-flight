import { describe, expect, it } from 'vitest';
import {
  renderTileTextureToCanvas,
  getAirportLineStyle,
} from '../src/workers/offscreen-renderer.js';
import type { ParsedFeature, TileBounds } from '../src/workers/types.js';

interface DrawOp {
  type: 'fill' | 'stroke';
  style: string;
  lineWidth?: number;
}

function recordingContext() {
  const ops: DrawOp[] = [];
  const ctx = {
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fillRect() {},
    fill() { ops.push({ type: 'fill', style: this.fillStyle }); },
    stroke() { ops.push({ type: 'stroke', style: this.strokeStyle, lineWidth: this.lineWidth }); },
  };
  return { ctx, ops };
}

const BOUNDS: TileBounds = { west: -71.02, south: 42.36, east: -71.0, north: 42.38 };

function line(layer: string, properties: Record<string, unknown>): ParsedFeature {
  return {
    type: 'LineString',
    layer,
    properties,
    coordinates: [[-71.015, 42.365], [-71.005, 42.372]],
  } as ParsedFeature;
}
function poly(layer: string, properties: Record<string, unknown>): ParsedFeature {
  return {
    type: 'Polygon',
    layer,
    properties,
    coordinates: [[[-71.013, 42.366], [-71.011, 42.366], [-71.011, 42.368], [-71.013, 42.368], [-71.013, 42.366]]],
  } as ParsedFeature;
}

describe('offscreen renderer — airport features', () => {
  it('draws runways, taxiways, and apron pavement', () => {
    const { ctx, ops } = recordingContext();
    const base: ParsedFeature[] = [
      line('infrastructure', { subtype: 'airport', class: 'runway' }),
      line('infrastructure', { subtype: 'airport', class: 'taxiway' }),
      poly('infrastructure', { subtype: 'airport', class: 'apron' }),
      // Non-airport infrastructure must be ignored by the renderer.
      line('infrastructure', { subtype: 'power', class: 'minor_line' }),
    ];
    renderTileTextureToCanvas(
      { width: 512, height: 512, getContext: () => ctx } as unknown as OffscreenCanvas,
      base,
      [],
      BOUNDS
    );

    const strokes = ops.filter(o => o.type === 'stroke');
    const runway = strokes.find(o => o.style === '#c4c8d0'); // light concrete
    const taxiway = strokes.find(o => o.style === '#74777e'); // mid grey
    expect(runway).toBeDefined();
    expect(taxiway).toBeDefined();
    // Runways read lighter than taxiways so the landing strips stand out.
    const luminance = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(luminance(runway!.style)).toBeGreaterThan(luminance(taxiway!.style));
    // Runways are drawn wider than taxiways.
    expect(runway!.lineWidth!).toBeGreaterThan(taxiway!.lineWidth!);
    // Apron pavement filled with dark tarmac grey.
    expect(ops.some(o => o.type === 'fill' && o.style === '#54565c')).toBe(true);
    // Only the runway and taxiway lines were stroked (power line ignored).
    expect(strokes.length).toBe(2);
  });

  it('colours managed/golf land_use as vegetation rather than bare land', () => {
    const { ctx, ops } = recordingContext();
    const base: ParsedFeature[] = [
      poly('land_use', { subtype: 'managed', class: 'grass' }),
      poly('land_use', { subtype: 'golf', class: 'fairway' }),
      poly('land_use', { subtype: 'horticulture', class: 'garden' }),
    ];
    renderTileTextureToCanvas(
      { width: 256, height: 256, getContext: () => ctx } as unknown as OffscreenCanvas,
      base,
      [],
      BOUNDS
    );
    const fills = ops.filter(o => o.type === 'fill').map(o => o.style);
    expect(fills).toContain('#5a8f4a'); // COLORS.grass — managed/grass and garden
    expect(fills).toContain('#4a8050'); // COLORS.park — golf/fairway
    expect(fills).not.toContain('#8fa880'); // never falls through to COLORS.land
  });

  it('does not misclassify lookalike classes via substring matching', () => {
    const { ctx, ops } = recordingContext();
    const base: ParsedFeature[] = [
      // "parking" contains "park", "gravel" contains "grave" — must NOT go green.
      poly('land_use', { subtype: 'transportation', class: 'parking' }),
      poly('land_use', { subtype: 'construction', class: 'gravel' }),
    ];
    renderTileTextureToCanvas(
      { width: 256, height: 256, getContext: () => ctx } as unknown as OffscreenCanvas,
      base,
      [],
      BOUNDS
    );
    const fills = ops.filter(o => o.type === 'fill').map(o => o.style);
    expect(fills).not.toContain('#4a8050'); // not park green
    expect(fills).not.toContain('#5a8f4a'); // not grass green
    expect(fills.every(f => f === '#8fa880')).toBe(true); // both neutral land
  });
});

describe('getAirportLineStyle', () => {
  it('maps airport line classes to widths, widest for runways', () => {
    expect(getAirportLineStyle('runway')?.widthMeters).toBe(45);
    expect(getAirportLineStyle('taxiway')?.widthMeters).toBe(22);
    expect(getAirportLineStyle('taxilane')!.widthMeters)
      .toBeLessThan(getAirportLineStyle('taxiway')!.widthMeters);
    expect(getAirportLineStyle('apron')).toBeNull();
    expect(getAirportLineStyle('nonexistent')).toBeNull();
  });
});
