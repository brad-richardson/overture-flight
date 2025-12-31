import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { PLANE_MODEL_URL, PLANE_RENDER, DEFAULT_LOCATION } from './constants.js';

// Export for use in buildings.js
export { BufferGeometryUtils };

// Scene components
let scene, camera, renderer;
let planeModel = null;
let planeMeshes = new Map(); // id -> mesh

// World origin (for geo to world conversion)
let originLng = DEFAULT_LOCATION.lng;
let originLat = DEFAULT_LOCATION.lat;

// Constants for geo conversion
const METERS_PER_DEGREE_LAT = 111320;
const metersPerDegreeLng = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

/**
 * Convert geo coordinates to world coordinates
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @param {number} alt - Altitude in meters
 * @returns {{x: number, y: number, z: number}}
 */
export function geoToWorld(lng, lat, alt) {
  return {
    x: (lng - originLng) * metersPerDegreeLng(originLat),
    y: alt,
    z: -(lat - originLat) * METERS_PER_DEGREE_LAT
  };
}

/**
 * Convert world coordinates back to geo
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{lng: number, lat: number, alt: number}}
 */
export function worldToGeo(x, y, z) {
  return {
    lng: originLng + x / metersPerDegreeLng(originLat),
    lat: originLat - z / METERS_PER_DEGREE_LAT,
    alt: y
  };
}

/**
 * Set the world origin for coordinate conversion
 * @param {number} lng
 * @param {number} lat
 */
export function setOrigin(lng, lat) {
  originLng = lng;
  originLat = lat;
}

/**
 * Get current origin
 * @returns {{lng: number, lat: number}}
 */
export function getOrigin() {
  return { lng: originLng, lat: originLat };
}

/**
 * Initialize the Three.js scene
 * @returns {Promise<{scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer}>}
 */
export async function initScene() {
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
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

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
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
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
async function loadPlaneModel() {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      PLANE_MODEL_URL,
      (gltf) => {
        planeModel = gltf.scene;
        planeModel.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            // Override any existing texture with a neutral white base
            // This allows player colors to show properly
            child.material = new THREE.MeshStandardMaterial({
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
function createFallbackPlane() {
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
 * @param {string} id - Player ID
 * @param {string} color - Plane color
 * @returns {THREE.Object3D}
 */
function getOrCreatePlaneMesh(id, color) {
  if (planeMeshes.has(id)) {
    return planeMeshes.get(id);
  }

  if (!planeModel) {
    console.warn('Plane model not loaded yet');
    return null;
  }

  const mesh = planeModel.clone();
  mesh.scale.set(PLANE_RENDER.SCALE, PLANE_RENDER.SCALE, PLANE_RENDER.SCALE);

  // Apply color to the plane
  mesh.traverse((child) => {
    if (child.isMesh) {
      child.material = child.material.clone();
      child.material.color.set(color || '#3b82f6');
    }
  });

  scene.add(mesh);
  planeMeshes.set(id, mesh);
  return mesh;
}

/**
 * Update a plane's position and rotation
 * @param {Object} planeState - Plane state with lng, lat, altitude, heading, pitch, roll
 * @param {string} id - Player ID
 * @param {string} color - Plane color
 */
export function updatePlaneMesh(planeState, id, color) {
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
 * @param {string} id
 */
export function removePlaneMesh(id) {
  const mesh = planeMeshes.get(id);
  if (mesh) {
    scene.remove(mesh);
    planeMeshes.delete(id);
  }
}

/**
 * Get the Three.js scene
 * @returns {THREE.Scene}
 */
export function getScene() {
  return scene;
}

/**
 * Get the Three.js camera
 * @returns {THREE.PerspectiveCamera}
 */
export function getCamera() {
  return camera;
}

/**
 * Get the Three.js renderer
 * @returns {THREE.WebGLRenderer}
 */
export function getRenderer() {
  return renderer;
}

/**
 * Render the scene
 */
export function render() {
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}
