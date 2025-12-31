import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { PLANE_MODEL_URL, PLANE_RENDER, DEFAULT_LOCATION } from './constants.js';
import { isMobileDevice } from './mobile-controls.js';
import { initSkySystem, updateSky } from './sky.js';

// Export for use in buildings.ts
export { BufferGeometryUtils };

// Cache for plane textures by color
const planeTextureCache = new Map<string, THREE.CanvasTexture>();

/**
 * Create a procedural aircraft skin texture with panel lines and weathering
 */
function createAircraftSkinTexture(playerColor: string): THREE.CanvasTexture {
  // Check cache first
  if (planeTextureCache.has(playerColor)) {
    return planeTextureCache.get(playerColor)!;
  }

  const canvas = document.createElement('canvas');
  const size = 512;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base metallic silver/white color
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#e8e8e8');
  gradient.addColorStop(0.3, '#f5f5f5');
  gradient.addColorStop(0.5, '#ffffff');
  gradient.addColorStop(0.7, '#f0f0f0');
  gradient.addColorStop(1, '#e0e0e0');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Add subtle noise/grain for metallic texture
  ctx.globalAlpha = 0.03;
  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const brightness = Math.random() > 0.5 ? '#000000' : '#ffffff';
    ctx.fillStyle = brightness;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.globalAlpha = 1;

  // Panel lines - horizontal
  ctx.strokeStyle = '#b0b0b0';
  ctx.lineWidth = 1;
  const panelSpacing = 64;
  for (let y = panelSpacing; y < size; y += panelSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y + (Math.random() - 0.5) * 4);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }

  // Panel lines - vertical
  for (let x = panelSpacing; x < size; x += panelSpacing) {
    ctx.beginPath();
    ctx.moveTo(x + (Math.random() - 0.5) * 4, 0);
    ctx.lineTo(x + (Math.random() - 0.5) * 4, size);
    ctx.stroke();
  }

  // Rivet dots along panel lines
  ctx.fillStyle = '#a0a0a0';
  const rivetSpacing = 16;
  for (let y = panelSpacing; y < size; y += panelSpacing) {
    for (let x = rivetSpacing; x < size; x += rivetSpacing) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Player color stripe accents (wing markings)
  ctx.fillStyle = playerColor;
  ctx.globalAlpha = 0.9;

  // Main wing stripe (horizontal band in middle)
  ctx.fillRect(0, size * 0.45, size, size * 0.06);

  // Secondary accent stripes
  ctx.globalAlpha = 0.7;
  ctx.fillRect(0, size * 0.38, size, size * 0.02);
  ctx.fillRect(0, size * 0.56, size, size * 0.02);

  // Subtle edge highlights on stripes
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, size * 0.45, size, 2);
  ctx.fillRect(0, size * 0.51 - 2, size, 2);

  ctx.globalAlpha = 1;

  // Add some weathering/dirt spots
  ctx.globalAlpha = 0.02;
  ctx.fillStyle = '#4a4a4a';
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const radius = 5 + Math.random() * 20;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);

  planeTextureCache.set(playerColor, texture);
  return texture;
}

/**
 * Create enhanced aircraft materials with realistic texturing
 * Uses polygon offset to prevent z-fighting between overlapping surfaces
 */
function createAircraftMaterials(playerColor: string): {
  fuselage: THREE.MeshStandardMaterial;
  wings: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
} {
  const skinTexture = createAircraftSkinTexture(playerColor);

  // Main fuselage material - metallic with panel lines
  // Polygon offset pushes fuselage slightly back in depth buffer
  const fuselage = new THREE.MeshStandardMaterial({
    map: skinTexture,
    roughness: 0.4,
    metalness: 0.6,
    envMapIntensity: 0.8,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  // Wing material - similar but with more visible color stripes
  // No polygon offset - wings render in front of fuselage at intersections
  const wingTexture = createAircraftSkinTexture(playerColor);
  wingTexture.repeat.set(1, 3); // Stretch stripes across wing span
  const wings = new THREE.MeshStandardMaterial({
    map: wingTexture,
    roughness: 0.45,
    metalness: 0.5,
  });

  // Accent material for trim pieces - solid player color
  const accent = new THREE.MeshStandardMaterial({
    color: playerColor,
    roughness: 0.3,
    metalness: 0.7,
  });

  return { fuselage, wings, accent };
}

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
  // Note: Sky dome replaces solid color background (set to null by initSkySystem)

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

  // Initialize procedural sky system with atmospheric effects
  initSkySystem(scene, {
    sunPosition: sunLight.position.clone(),
    turbidity: 2,
    cloudDensity: 0.35,
    cloudAltitude: 3000,
    fogDensity: 0.00006
  });

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
            // Use polygon offset to help prevent z-fighting in model geometry
            mesh.material = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              roughness: 0.6,
              metalness: 0.3,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
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
 * Uses merged geometry to prevent z-fighting between overlapping parts
 */
function createFallbackPlane(): THREE.Group {
  const group = new THREE.Group();

  // Default white/silver materials (will be replaced when cloned for player)
  const fuselageMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.6
  });
  const wingMaterial = new THREE.MeshStandardMaterial({
    color: 0xf0f0f0,
    roughness: 0.45,
    metalness: 0.5
  });

  // Collect geometries for merging to prevent z-fighting
  const fuselageGeometries: THREE.BufferGeometry[] = [];
  const wingGeometries: THREE.BufferGeometry[] = [];

  // Fuselage - higher resolution cylinder for smoother appearance
  const fuselageGeometry = new THREE.CylinderGeometry(2, 1.5, 20, 16);
  fuselageGeometry.rotateZ(Math.PI / 2);
  fuselageGeometries.push(fuselageGeometry);

  // Nose cone
  const noseGeometry = new THREE.ConeGeometry(1.5, 4, 16);
  noseGeometry.rotateZ(-Math.PI / 2);
  noseGeometry.translate(12, 0, 0);
  fuselageGeometries.push(noseGeometry);

  // Wings - split into left and right to avoid passing through fuselage
  // Fuselage radius is ~2, so wings start at z=±2.5 to avoid overlap
  const wingSpan = 11.5; // Each wing segment length (from fuselage edge to tip)
  const wingOffset = 2.5; // Start wings outside fuselage radius

  // Left wing segment
  const leftWingGeometry = new THREE.BoxGeometry(4, 0.3, wingSpan);
  leftWingGeometry.translate(0, 0, wingOffset + wingSpan / 2);
  wingGeometries.push(leftWingGeometry);

  // Right wing segment
  const rightWingGeometry = new THREE.BoxGeometry(4, 0.3, wingSpan);
  rightWingGeometry.translate(0, 0, -(wingOffset + wingSpan / 2));
  wingGeometries.push(rightWingGeometry);

  // Wing root fairings (smooth transition from fuselage to wing)
  const leftFairingGeometry = new THREE.BoxGeometry(3, 0.8, 3);
  leftFairingGeometry.translate(0, 0.3, 2);
  fuselageGeometries.push(leftFairingGeometry);

  const rightFairingGeometry = new THREE.BoxGeometry(3, 0.8, 3);
  rightFairingGeometry.translate(0, 0.3, -2);
  fuselageGeometries.push(rightFairingGeometry);

  // Wing tips (angled)
  const leftWingTipGeo = new THREE.BoxGeometry(2, 0.2, 4);
  leftWingTipGeo.rotateX(Math.PI / 6);
  leftWingTipGeo.translate(0, 0.5, 15);
  wingGeometries.push(leftWingTipGeo);

  const rightWingTipGeo = new THREE.BoxGeometry(2, 0.2, 4);
  rightWingTipGeo.rotateX(-Math.PI / 6);
  rightWingTipGeo.translate(0, 0.5, -15);
  wingGeometries.push(rightWingTipGeo);

  // Tail horizontal stabilizer - split to avoid overlap with vertical stabilizer
  const leftTailGeometry = new THREE.BoxGeometry(3, 0.2, 4.5);
  leftTailGeometry.translate(-9, 0, 2.5);
  wingGeometries.push(leftTailGeometry);

  const rightTailGeometry = new THREE.BoxGeometry(3, 0.2, 4.5);
  rightTailGeometry.translate(-9, 0, -2.5);
  wingGeometries.push(rightTailGeometry);

  // Vertical stabilizer
  const stabilizerGeometry = new THREE.BoxGeometry(4, 5, 0.3);
  stabilizerGeometry.translate(-8, 2.5, 0);
  wingGeometries.push(stabilizerGeometry);

  // Engine nacelles (under wings)
  const leftEngineGeo = new THREE.CylinderGeometry(0.8, 1, 3, 12);
  leftEngineGeo.rotateZ(Math.PI / 2);
  leftEngineGeo.translate(1, -1, 6);
  fuselageGeometries.push(leftEngineGeo);

  const rightEngineGeo = new THREE.CylinderGeometry(0.8, 1, 3, 12);
  rightEngineGeo.rotateZ(Math.PI / 2);
  rightEngineGeo.translate(1, -1, -6);
  fuselageGeometries.push(rightEngineGeo);

  // Merge geometries into single meshes to eliminate z-fighting
  const mergedFuselageGeometry = BufferGeometryUtils.mergeGeometries(fuselageGeometries);
  const fuselage = new THREE.Mesh(mergedFuselageGeometry, fuselageMaterial);
  fuselage.name = 'fuselage';
  group.add(fuselage);

  const mergedWingGeometry = BufferGeometryUtils.mergeGeometries(wingGeometries);
  const wings = new THREE.Mesh(mergedWingGeometry, wingMaterial);
  wings.name = 'wings';
  group.add(wings);

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
  const scale = isMobileDevice() ? PLANE_RENDER.MOBILE_SCALE : PLANE_RENDER.SCALE;
  mesh.scale.set(scale, scale, scale);

  // Create enhanced aircraft materials with realistic texturing
  const materials = createAircraftMaterials(color || '#3b82f6');

  // Apply enhanced materials to the plane
  const wingParts = ['wing', 'tail', 'stabilizer', 'tip', 'flap', 'aileron'];
  const accentParts = ['engine', 'nacelle', 'prop', 'spinner'];

  mesh.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const meshChild = child as THREE.Mesh;
      const name = meshChild.name.toLowerCase();

      // Determine which material to use based on mesh name
      if (accentParts.some(part => name.includes(part))) {
        // Engine parts get accent color
        meshChild.material = materials.accent;
      } else if (wingParts.some(part => name.includes(part))) {
        // Wing and tail surfaces
        meshChild.material = materials.wings;
      } else {
        // Fuselage and other body parts
        meshChild.material = materials.fuselage;
      }
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
 * Update the sky system (call each frame)
 */
export function updateSkySystem(deltaTime: number): void {
  if (camera) {
    updateSky(deltaTime, camera.position);
  }
}

/**
 * Render the scene
 */
export function render(): void {
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}
