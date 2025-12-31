import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { PLANE_MODEL_URL, PLANE_RENDER, DEFAULT_LOCATION } from './constants.js';

// Export for use in buildings.ts
export { BufferGeometryUtils };

// Scene components
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let planeModel: THREE.Group | null = null;
const planeMeshes = new Map<string, THREE.Object3D>(); // id -> mesh

// World origin (for geo to world conversion)
let originLng: number = DEFAULT_LOCATION.lng;
let originLat: number = DEFAULT_LOCATION.lat;

// Constants for geo conversion
const METERS_PER_DEGREE_LAT = 111320;
const metersPerDegreeLng = (lat: number): number => 111320 * Math.cos(lat * Math.PI / 180);

// Types
export interface WorldCoords {
  x: number;
  y: number;
  z: number;
}

export interface GeoCoords {
  lng: number;
  lat: number;
  alt: number;
}

export interface PlaneState {
  id: string;
  lat: number;
  lng: number;
  altitude: number;
  heading: number;
  pitch: number;
  roll: number;
  speed: number;
  color: string;
  name?: string;
}

/**
 * Convert geo coordinates to world coordinates
 */
export function geoToWorld(lng: number, lat: number, alt: number): WorldCoords {
  return {
    x: (lng - originLng) * metersPerDegreeLng(originLat),
    y: alt,
    z: -(lat - originLat) * METERS_PER_DEGREE_LAT
  };
}

/**
 * Convert world coordinates back to geo
 */
export function worldToGeo(x: number, y: number, z: number): GeoCoords {
  return {
    lng: originLng + x / metersPerDegreeLng(originLat),
    lat: originLat - z / METERS_PER_DEGREE_LAT,
    alt: y
  };
}

/**
 * Set the world origin for coordinate conversion
 */
export function setOrigin(lng: number, lat: number): void {
  originLng = lng;
  originLat = lat;
}

/**
 * Get current origin
 */
export function getOrigin(): { lng: number; lat: number } {
  return { lng: originLng, lat: originLat };
}

/**
 * Initialize the Three.js scene
 */
export async function initScene(): Promise<{
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
}> {
  // Create scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB); // Sky blue

  // Create camera
  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(60, aspect, 1, 100000);
  camera.position.set(0, 500, 500);
  camera.lookAt(0, 0, 0);

  // Create renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Replace map container content with Three.js canvas
  const container = document.getElementById('map');
  if (container) {
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
  }

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xffffff, 0.8);
  sunLight.position.set(1000, 2000, 1000);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 100;
  sunLight.shadow.camera.far = 10000;
  sunLight.shadow.camera.left = -5000;
  sunLight.shadow.camera.right = 5000;
  sunLight.shadow.camera.top = 5000;
  sunLight.shadow.camera.bottom = -5000;
  scene.add(sunLight);

  // Handle window resize
  window.addEventListener('resize', () => {
    if (camera && renderer) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
  });

  // Load plane model
  await loadPlaneModel();

  // Reference marker at origin
  const originMarker = new THREE.Mesh(
    new THREE.SphereGeometry(10, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff0000 })
  );
  originMarker.position.set(0, 10, 0);
  scene.add(originMarker);

  return { scene, camera, renderer };
}

/**
 * Load the plane GLTF model
 */
async function loadPlaneModel(): Promise<THREE.Group> {
  return new Promise((resolve) => {
    const loader = new GLTFLoader();
    loader.load(
      PLANE_MODEL_URL,
      (gltf) => {
        planeModel = gltf.scene;
        planeModel.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            // Override any existing texture with a neutral white base
            // This allows player colors to show properly
            mesh.material = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              roughness: 0.6,
              metalness: 0.3
            });
          }
        });
        console.log('Plane model loaded');
        resolve(planeModel);
      },
      undefined,
      (error) => {
        console.error('Error loading plane model:', error);
        // Create a fallback box geometry
        planeModel = createFallbackPlane();
        resolve(planeModel);
      }
    );
  });
}

/**
 * Create a fallback plane mesh if GLTF fails to load
 */
function createFallbackPlane(): THREE.Group {
  const group = new THREE.Group();

  // White/silver aircraft materials
  const fuselageMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0.3
  });
  const wingMaterial = new THREE.MeshStandardMaterial({
    color: 0xeeeeee,
    roughness: 0.7,
    metalness: 0.2
  });

  // Fuselage
  const fuselageGeometry = new THREE.CylinderGeometry(2, 2, 20, 8);
  fuselageGeometry.rotateZ(Math.PI / 2);
  const fuselage = new THREE.Mesh(fuselageGeometry, fuselageMaterial);
  group.add(fuselage);

  // Wings
  const wingGeometry = new THREE.BoxGeometry(30, 0.5, 5);
  const wings = new THREE.Mesh(wingGeometry, wingMaterial);
  wings.position.z = 2;
  group.add(wings);

  // Tail
  const tailGeometry = new THREE.BoxGeometry(8, 0.5, 3);
  const tail = new THREE.Mesh(tailGeometry, wingMaterial);
  tail.position.set(-8, 0, 0);
  group.add(tail);

  // Vertical stabilizer
  const stabilizerGeometry = new THREE.BoxGeometry(5, 4, 0.5);
  const stabilizer = new THREE.Mesh(stabilizerGeometry, wingMaterial);
  stabilizer.position.set(-8, 2, 0);
  group.add(stabilizer);

  return group;
}

/**
 * Get or create a plane mesh for a player
 */
function getOrCreatePlaneMesh(id: string, color: string): THREE.Object3D | null {
  if (planeMeshes.has(id)) {
    return planeMeshes.get(id)!;
  }

  if (!planeModel) {
    console.warn('Plane model not loaded yet');
    return null;
  }

  const mesh = planeModel.clone();
  mesh.scale.set(PLANE_RENDER.SCALE, PLANE_RENDER.SCALE, PLANE_RENDER.SCALE);

  // Apply color to the plane
  mesh.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const meshChild = child as THREE.Mesh;
      meshChild.material = (meshChild.material as THREE.MeshStandardMaterial).clone();
      (meshChild.material as THREE.MeshStandardMaterial).color.set(color || '#3b82f6');
    }
  });

  if (scene) {
    scene.add(mesh);
  }
  planeMeshes.set(id, mesh);
  return mesh;
}

/**
 * Update a plane's position and rotation
 */
export function updatePlaneMesh(planeState: PlaneState, id: string, color: string): void {
  const mesh = getOrCreatePlaneMesh(id, color);
  if (!mesh) return;

  // Convert geo to world coordinates
  const worldPos = geoToWorld(planeState.lng, planeState.lat, planeState.altitude);
  mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

  // Apply rotation (heading, pitch, roll)
  // Reset rotation first
  mesh.rotation.set(0, 0, 0);

  // Apply rotations in order: yaw (heading), pitch, roll
  // Three.js uses Y-up, so:
  // - Heading (yaw) rotates around Y axis
  // - Pitch rotates around X axis (nose up/down)
  // - Roll rotates around Z axis (banking)

  const headingRad = THREE.MathUtils.degToRad(-planeState.heading + 90 + 90); // +90 to rotate model CCW
  const pitchRad = THREE.MathUtils.degToRad(-planeState.pitch); // Negated - positive pitch = nose up visually
  const rollRad = THREE.MathUtils.degToRad(planeState.roll);

  // Use Euler with YXZ order for flight sim rotations
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = headingRad;
  mesh.rotation.x = pitchRad;
  mesh.rotation.z = rollRad;
}

/**
 * Remove a plane mesh
 */
export function removePlaneMesh(id: string): void {
  const mesh = planeMeshes.get(id);
  if (mesh && scene) {
    scene.remove(mesh);
    planeMeshes.delete(id);
  }
}

/**
 * Get the Three.js scene
 */
export function getScene(): THREE.Scene | null {
  return scene;
}

/**
 * Get the Three.js camera
 */
export function getCamera(): THREE.PerspectiveCamera | null {
  return camera;
}

/**
 * Get the Three.js renderer
 */
export function getRenderer(): THREE.WebGLRenderer | null {
  return renderer;
}

/**
 * Render the scene
 */
export function render(): void {
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}
