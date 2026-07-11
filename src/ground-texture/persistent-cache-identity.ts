/**
 * Version of the rendered ground-texture pixels and their persisted encoding.
 *
 * Bump this whenever styling, layer composition, rendering, or encoding changes
 * can make an existing persisted ground texture visually stale.
 */
export const GROUND_TEXTURE_RENDER_VERSION = 1;

export interface GroundTextureCacheIdentity {
  baseSource: string;
  transportationSource: string;
  textureSize: number;
  includeNeighbors: boolean;
  includeTransportation: boolean;
  renderVersion: number;
}

/**
 * Build a deployment-stable namespace from only the inputs that affect the
 * rendered ground texture. The length prefix keeps source boundaries explicit.
 */
export function createGroundTextureCacheNamespace(
  identity: GroundTextureCacheIdentity
): string {
  const sourceIdentity = [
    `${identity.baseSource.length}:${identity.baseSource}`,
    `${identity.transportationSource.length}:${identity.transportationSource}`,
  ].join('|');

  return [
    `ground-render-${identity.renderVersion}`,
    `sources-${sourceIdentity}`,
    `size-${identity.textureSize}`,
    `neighbors-${identity.includeNeighbors ? 1 : 0}`,
    `transportation-${identity.includeTransportation ? 1 : 0}`,
  ].join(':');
}
