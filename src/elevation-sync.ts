/**
 * Elevation synchronization module
 * Tracks trees that need repositioning when elevation tiles load
 *
 * When trees are created before their elevation data is available,
 * they get positioned at Y=0. This module re-positions them once elevation loads.
 *
 * Note: Buildings use merged geometry with terrain height baked in, so they
 * cannot be repositioned after creation. Buildings rely on elevation data
 * being loaded before they are created.
 */

import * as THREE from 'three';
import {
  getTerrainHeight,
  onElevationTileLoad,
  getElevationTileKey,
  isElevationTileLoaded,
} from './elevation.js';
import { ELEVATION } from './constants.js';

// ============================================================================
// TYPES
// ============================================================================

interface PendingTreeUpdate {
  objectTileKey: string;
  group: THREE.Group;
  treeData: {
    lng: number;
    lat: number;
    meshName: string; // 'conifers' or 'deciduous'
    instanceIndex: number;
  }[];
}

// Pending tree updates per elevation tile
const pendingUpdates = new Map<string, PendingTreeUpdate[]>();

// Track active unsubscribe functions to prevent memory leaks
const activeSubscriptions = new Map<string, () => void>();

// ============================================================================
// REGISTRATION
// ============================================================================

/**
 * Register trees to be repositioned when elevation data loads
 */
export function registerTreesForElevationUpdate(
  objectTileKey: string,
  group: THREE.Group,
  treeData: {
    lng: number;
    lat: number;
    meshName: string;
    instanceIndex: number;
  }[]
): void {
  if (!ELEVATION.TERRAIN_ENABLED || treeData.length === 0) {
    return;
  }

  // Group trees by elevation tile
  const byElevationTile = new Map<string, typeof treeData>();
  for (const tree of treeData) {
    const elevationKey = getElevationTileKey(tree.lng, tree.lat);
    if (!isElevationTileLoaded(elevationKey)) {
      if (!byElevationTile.has(elevationKey)) {
        byElevationTile.set(elevationKey, []);
      }
      byElevationTile.get(elevationKey)!.push(tree);
    }
  }

  // Register for each missing elevation tile
  for (const [elevationKey, trees] of byElevationTile) {
    registerPendingUpdate(elevationKey, {
      objectTileKey,
      group,
      treeData: trees,
    });
  }
}

/**
 * Internal function to register a pending update and set up the listener
 */
function registerPendingUpdate(elevationKey: string, update: PendingTreeUpdate): void {
  if (!pendingUpdates.has(elevationKey)) {
    pendingUpdates.set(elevationKey, []);

    // Subscribe to elevation tile load
    const unsubscribe = onElevationTileLoad(elevationKey, () => {
      processPendingUpdates(elevationKey);
    });
    activeSubscriptions.set(elevationKey, unsubscribe);
  }

  pendingUpdates.get(elevationKey)!.push(update);
}

// ============================================================================
// PROCESSING
// ============================================================================

/**
 * Process pending updates when an elevation tile loads
 */
function processPendingUpdates(elevationKey: string): void {
  const pending = pendingUpdates.get(elevationKey);
  if (!pending || pending.length === 0) {
    return;
  }

  for (const update of pending) {
    try {
      // Skip if the group has been removed from the scene
      if (!update.group.parent) {
        continue;
      }

      repositionTreeGroup(update);
    } catch (e) {
      console.warn(`Failed to reposition trees for ${update.objectTileKey}:`, e);
    }
  }

  // Clean up
  pendingUpdates.delete(elevationKey);
  const unsubscribe = activeSubscriptions.get(elevationKey);
  if (unsubscribe) {
    unsubscribe();
    activeSubscriptions.delete(elevationKey);
  }
}

/**
 * Reposition trees based on new elevation data
 * Trees use instanced meshes, so we update individual instance matrices
 */
function repositionTreeGroup(update: PendingTreeUpdate): void {
  const { group, treeData } = update;

  // Group updates by mesh name for efficiency
  const updatesByMesh = new Map<string, typeof treeData>();
  for (const tree of treeData) {
    if (!updatesByMesh.has(tree.meshName)) {
      updatesByMesh.set(tree.meshName, []);
    }
    updatesByMesh.get(tree.meshName)!.push(tree);
  }

  // Find the instanced meshes and update them
  group.traverse((child) => {
    if ((child as THREE.InstancedMesh).isInstancedMesh) {
      const instancedMesh = child as THREE.InstancedMesh;
      const parentName = child.parent?.name || child.name;

      // Check if this mesh has updates
      const updates = updatesByMesh.get(parentName);
      if (!updates) return;

      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();

      for (const tree of updates) {
        // Get current matrix
        instancedMesh.getMatrixAt(tree.instanceIndex, matrix);
        matrix.decompose(position, quaternion, scale);

        // Get new terrain height (elevation tile is now loaded)
        const newHeight = getTerrainHeight(tree.lng, tree.lat) * ELEVATION.VERTICAL_EXAGGERATION;

        // Update Y position: add new terrain height to existing position
        // Trees are positioned at terrainHeight + (trunk/crown offset)
        // Since original terrainHeight was 0, position.y is just the trunk/crown offset
        // Adding newHeight gives us: newTerrainHeight + offset (correct!)
        // Note: Even if newHeight is 0 (sea level), we apply it for consistency
        position.y += newHeight;

        // Recompose and set
        matrix.compose(position, quaternion, scale);
        instancedMesh.setMatrixAt(tree.instanceIndex, matrix);
      }

      instancedMesh.instanceMatrix.needsUpdate = true;
    }
  });
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up pending updates for a tile being removed
 * Call this when removing tree groups
 */
export function clearPendingUpdatesForTile(objectTileKey: string): void {
  for (const [elevationKey, pending] of pendingUpdates) {
    const filtered = pending.filter(p => p.objectTileKey !== objectTileKey);
    if (filtered.length === 0) {
      pendingUpdates.delete(elevationKey);
      const unsubscribe = activeSubscriptions.get(elevationKey);
      if (unsubscribe) {
        unsubscribe();
        activeSubscriptions.delete(elevationKey);
      }
    } else {
      pendingUpdates.set(elevationKey, filtered);
    }
  }
}

/**
 * Get statistics about pending updates (for debugging)
 */
export function getElevationSyncStats(): {
  pendingTiles: number;
  pendingTrees: number;
} {
  let pendingTrees = 0;
  for (const updates of pendingUpdates.values()) {
    for (const update of updates) {
      pendingTrees += update.treeData.length;
    }
  }
  return {
    pendingTiles: pendingUpdates.size,
    pendingTrees,
  };
}
