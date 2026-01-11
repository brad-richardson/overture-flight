import * as THREE from 'three';

// Renderer type (matches scene.ts export)
type RendererType = 'webgpu' | 'webgl';

/**
 * Sky System for Overture Flight Simulator
 *
 * Creates a procedural daytime sky with:
 * - Gradient sky dome (darker blue at zenith, lighter near horizon)
 * - Visible sun disk with glow effects
 * - Multi-layer procedural clouds at realistic altitudes
 * - Atmospheric fog/haze for depth perception
 *
 * Side effects on initialization:
 * - Sets scene.background to null (sky dome replaces solid color)
 * - Adds exponential fog to scene.fog
 *
 * Supports both WebGL (GLSL shaders) and WebGPU (TSL nodes) renderers.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface SkyConfig {
  sunPosition: THREE.Vector3;
  turbidity: number;        // Atmospheric haziness 1-10 (affects horizon color)
  cloudDensity: number;     // Cloud coverage 0-1
  cloudAltitude: number;    // Base cloud layer altitude in meters
  fogDensity: number;       // Atmospheric fog density
  fogColor: number;         // Fog color (hex)
  rendererType: RendererType; // WebGL or WebGPU
}

const DEFAULT_CONFIG: SkyConfig = {
  sunPosition: new THREE.Vector3(1000, 2000, 1000),
  turbidity: 2,
  cloudDensity: 0.4,
  cloudAltitude: 5000,
  fogDensity: 0.00006,
  fogColor: 0x9dc4e8,
  rendererType: 'webgl'
};

// ============================================================================
// Constants - Sky Geometry
// ============================================================================

/** Radius of the sky dome sphere in meters */
const SKY_DOME_RADIUS = 90000;

/** Distance from camera to place the sun mesh */
const SUN_DISTANCE = 80000;

/** Radius of the visible sun disk in meters */
const SUN_DISK_RADIUS = 500;

/** Radius of the inner sun glow in meters */
const SUN_INNER_GLOW_RADIUS = 800;

/** Radius of the outer sun glow in meters */
const SUN_OUTER_GLOW_RADIUS = 1200;

// ============================================================================
// Sky Shader - Simple gradient with sun
// ============================================================================

const skyVertexShader = `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragmentShader = `
  uniform vec3 sunPosition;
  uniform float turbidity;

  varying vec3 vWorldPosition;

  void main() {
    // Get view direction (normalized position on sky dome)
    vec3 direction = normalize(vWorldPosition);

    // Height factor: 0 at horizon, 1 at zenith
    float height = max(0.0, direction.y);

    // Sky colors - fixed daytime palette
    vec3 zenithColor = vec3(0.25, 0.55, 0.95);   // Deep blue at top
    vec3 horizonColor = vec3(0.65, 0.82, 0.95);  // Light blue-white at horizon

    // Add slight warmth based on turbidity (haziness)
    float hazeAmount = (turbidity - 1.0) / 9.0;  // 0-1 based on turbidity 1-10
    horizonColor = mix(horizonColor, vec3(0.85, 0.85, 0.8), hazeAmount * 0.3);

    // Smooth gradient from horizon to zenith
    float gradientFactor = pow(height, 0.8);
    vec3 skyColor = mix(horizonColor, zenithColor, gradientFactor);

    // Sun glow effect
    vec3 sunDir = normalize(sunPosition);
    float sunAngle = dot(direction, sunDir);

    // Atmospheric glow around sun
    float sunGlow = pow(max(0.0, sunAngle), 8.0) * 0.4;
    vec3 glowColor = vec3(1.0, 0.95, 0.8);
    skyColor += glowColor * sunGlow;

    // Subtle golden tint near horizon in sun direction
    float horizonSunGlow = pow(max(0.0, sunAngle), 2.0) * (1.0 - height) * 0.15;
    skyColor += vec3(0.3, 0.2, 0.05) * horizonSunGlow;

    gl_FragColor = vec4(skyColor, 1.0);
  }
`;

// ============================================================================
// Cloud Shader
// ============================================================================

const cloudVertexShader = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const cloudFragmentShader = `
  uniform float time;
  uniform float cloudDensity;
  uniform vec3 sunPosition;
  uniform float opacity;

  varying vec2 vUv;
  varying vec3 vWorldPosition;

  // Simplex noise functions
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;

    for (int i = 0; i < 5; i++) {
      value += amplitude * snoise(p * frequency);
      amplitude *= 0.5;
      frequency *= 2.0;
    }
    return value;
  }

  void main() {
    vec3 sunDir = normalize(sunPosition);

    // Create cloud noise at different scales
    vec3 noiseCoord = vec3(vUv * 3.0, time * 0.02);
    float noise = fbm(noiseCoord);

    // Add larger scale variation
    float largeNoise = fbm(noiseCoord * 0.3 + vec3(100.0));
    noise = noise * 0.6 + largeNoise * 0.4;

    // Shape the clouds
    float cloudShape = smoothstep(0.1 - cloudDensity * 0.3, 0.5, noise);

    // Edge softness
    float softEdge = smoothstep(0.0, 0.3, noise) * smoothstep(1.0, 0.7, noise);

    // Sun lighting on clouds
    float sunInfluence = dot(normalize(vWorldPosition), sunDir);
    vec3 cloudColor = mix(
      vec3(0.7, 0.75, 0.8),   // Shadowed side
      vec3(1.0, 0.98, 0.95),  // Sunlit side
      sunInfluence * 0.5 + 0.5
    );

    // Add golden tint near sun
    float sunProximity = pow(max(0.0, sunInfluence), 4.0);
    cloudColor += vec3(0.3, 0.2, 0.05) * sunProximity;

    float alpha = cloudShape * softEdge * opacity;

    // Fade out at edges of the cloud plane
    float edgeFade = 1.0 - smoothstep(0.3, 0.5, length(vUv - 0.5));
    alpha *= edgeFade;

    gl_FragColor = vec4(cloudColor, alpha);
  }
`;

// ============================================================================
// Cloud Layer Configuration
// ============================================================================

interface CloudLayerConfig {
  altitudeOffset: number;  // Offset from base cloud altitude
  size: number;            // Size of cloud plane
  opacity: number;         // Layer opacity
}

const CLOUD_LAYERS: CloudLayerConfig[] = [
  { altitudeOffset: 0, size: 80000, opacity: 0.5 },
  { altitudeOffset: 500, size: 70000, opacity: 0.35 },
  { altitudeOffset: 1000, size: 60000, opacity: 0.2 }
];

// ============================================================================
// TSL (Three.js Shading Language) Materials for WebGPU
// ============================================================================

// WebGPU module types (dynamically imported)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebGPUModule = any;

// TSL imports - dynamically imported when WebGPU is used
let tslModule: TSLModule | null = null;
let webgpuModule: WebGPUModule | null = null;

/**
 * Load TSL module for node shader functions
 */
async function loadTSL(): Promise<TSLModule> {
  if (!tslModule) {
    tslModule = await import('three/tsl');
  }
  return tslModule;
}

/**
 * Load WebGPU module for node materials
 */
async function loadWebGPU(): Promise<WebGPUModule> {
  if (!webgpuModule) {
    webgpuModule = await import('three/webgpu');
  }
  return webgpuModule;
}

/**
 * Create WebGPU-compatible sky dome material using TSL nodes
 */
async function createWebGPUSkyMaterial(
  sunPosition: THREE.Vector3,
  turbidity: number
): Promise<{
  material: THREE.Material;
  uniforms: { sunPosition: THREE.Vector3; turbidity: number };
}> {
  // Load both modules - TSL for node functions, WebGPU for material classes
  const TSL = await loadTSL();
  const { MeshBasicNodeMaterial } = await loadWebGPU();

  // Create uniform nodes
  const sunPosUniform = TSL.uniform(sunPosition);
  const turbidityUniform = TSL.uniform(turbidity);

  // Get world position and normalize for sky direction
  const worldPos = TSL.positionWorld;
  const direction = TSL.normalize(worldPos);

  // Height factor: 0 at horizon, 1 at zenith
  const height = TSL.max(0.0, direction.y);

  // Sky colors
  const zenithColor = TSL.vec3(0.25, 0.55, 0.95);
  const horizonColor = TSL.vec3(0.65, 0.82, 0.95);

  // Add slight warmth based on turbidity
  const hazeAmount = turbidityUniform.sub(1.0).div(9.0);
  const hazyHorizon = TSL.mix(horizonColor, TSL.vec3(0.85, 0.85, 0.8), hazeAmount.mul(0.3));

  // Smooth gradient
  const gradientFactor = TSL.pow(height, 0.8);
  const skyColor = TSL.mix(hazyHorizon, zenithColor, gradientFactor);

  // Sun glow effect
  const sunDir = TSL.normalize(sunPosUniform);
  const sunAngle = TSL.dot(direction, sunDir);

  // Atmospheric glow
  const sunGlow = TSL.pow(TSL.max(0.0, sunAngle), 8.0).mul(0.4);
  const glowColor = TSL.vec3(1.0, 0.95, 0.8);
  const withGlow = skyColor.add(glowColor.mul(sunGlow));

  // Golden tint near horizon in sun direction
  const horizonSunGlow = TSL.pow(TSL.max(0.0, sunAngle), 2.0).mul(TSL.float(1.0).sub(height)).mul(0.15);
  const finalColor = withGlow.add(TSL.vec3(0.3, 0.2, 0.05).mul(horizonSunGlow));

  // Create node material
  const material = new MeshBasicNodeMaterial();
  material.colorNode = finalColor;
  material.side = THREE.BackSide;
  material.depthWrite = false;

  return {
    material,
    uniforms: { sunPosition, turbidity }
  };
}

/**
 * Create a simple WebGPU-compatible cloud material
 * Uses a simplified approach without complex noise (TSL noise is still evolving)
 */
async function createWebGPUCloudMaterial(
  sunPosition: THREE.Vector3,
  cloudDensity: number,
  opacity: number
): Promise<{
  material: THREE.Material;
  uniforms: { time: { value: number }; cloudDensity: number; sunPosition: THREE.Vector3; opacity: number };
}> {
  // Load both modules - TSL for node functions, WebGPU for material classes
  const TSL = await loadTSL();
  const { MeshBasicNodeMaterial } = await loadWebGPU();

  // For WebGPU clouds, use a simpler approach with a pre-baked cloud texture
  // or a simplified procedural pattern (full simplex noise in TSL is complex)
  const timeUniform = TSL.uniform(0);
  const densityUniform = TSL.uniform(cloudDensity);
  const opacityUniform = TSL.uniform(opacity);
  const sunPosUniform = TSL.uniform(sunPosition);

  // Get UV coordinates
  const uv = TSL.uv();

  // Simple procedural pattern using sine waves (approximates clouds)
  const scale = 3.0;
  const offsetX = timeUniform.mul(0.02);
  const offsetY = timeUniform.mul(0.015);

  const noise1 = TSL.sin(uv.x.mul(scale).add(offsetX)).mul(TSL.cos(uv.y.mul(scale).add(offsetY)));
  const noise2 = TSL.sin(uv.x.mul(scale * 2.3).add(offsetX.mul(1.3))).mul(TSL.cos(uv.y.mul(scale * 2.1).add(offsetY.mul(1.2)))).mul(0.5);
  const noise3 = TSL.sin(uv.x.mul(scale * 4.7).add(offsetX.mul(0.7))).mul(TSL.cos(uv.y.mul(scale * 5.2).add(offsetY.mul(0.8)))).mul(0.25);

  const combinedNoise = noise1.add(noise2).add(noise3).mul(0.5).add(0.5);

  // Shape clouds based on density
  const cloudShape = TSL.smoothstep(TSL.float(0.4).sub(densityUniform.mul(0.3)), 0.7, combinedNoise);

  // Sun lighting
  const worldPos = TSL.positionWorld;
  const sunDir = TSL.normalize(sunPosUniform);
  const sunInfluence = TSL.dot(TSL.normalize(worldPos), sunDir);

  // Cloud color with lighting
  const shadowColor = TSL.vec3(0.7, 0.75, 0.8);
  const sunlitColor = TSL.vec3(1.0, 0.98, 0.95);
  const cloudColor = TSL.mix(shadowColor, sunlitColor, sunInfluence.mul(0.5).add(0.5));

  // Golden tint near sun
  const sunProximity = TSL.pow(TSL.max(0.0, sunInfluence), 4.0);
  const tintedColor = cloudColor.add(TSL.vec3(0.3, 0.2, 0.05).mul(sunProximity));

  // Alpha with edge fade
  const edgeFade = TSL.float(1.0).sub(TSL.smoothstep(0.3, 0.5, TSL.length(uv.sub(0.5))));
  const alpha = cloudShape.mul(edgeFade).mul(opacityUniform);

  // Create node material
  const material = new MeshBasicNodeMaterial();
  material.colorNode = tintedColor;
  material.opacityNode = alpha;
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  return {
    material,
    uniforms: {
      time: { value: 0 },
      cloudDensity,
      sunPosition,
      opacity
    }
  };
}

// ============================================================================
// Sky System Class
// ============================================================================

export class SkySystem {
  private scene: THREE.Scene;
  private config: SkyConfig;
  private skyMesh: THREE.Mesh | null = null;
  private sunMesh: THREE.Mesh | null = null;
  private cloudLayers: THREE.Mesh[] = [];
  private skyUniforms: { [key: string]: THREE.IUniform };
  private time: number = 0;
  private initialized: boolean = false;

  // WebGPU-specific uniform references (for updating cloud time values)
  private webgpuCloudUniforms: Array<{ time: { value: number }; cloudDensity: number; sunPosition: THREE.Vector3; opacity: number }> = [];

  constructor(scene: THREE.Scene, config: Partial<SkyConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.skyUniforms = {};
    // Note: init() is now async and called separately via initAsync()
  }

  /**
   * Initialize the sky system asynchronously
   * Must be called after construction for WebGPU support
   */
  public async initAsync(): Promise<void> {
    if (this.initialized) return;

    if (this.config.rendererType === 'webgpu') {
      await this.createSkyWebGPU();
      await this.createCloudsWebGPU();
    } else {
      this.createSkyWebGL();
      this.createCloudsWebGL();
    }

    this.createSun();
    this.setupFog();
    this.initialized = true;
  }

  private createSkyWebGL(): void {
    this.skyUniforms = {
      sunPosition: { value: this.config.sunPosition.clone() },
      turbidity: { value: this.config.turbidity }
    };

    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide,
      depthWrite: false
    });

    const skyGeometry = new THREE.SphereGeometry(SKY_DOME_RADIUS, 32, 32);
    this.skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    this.skyMesh.renderOrder = -1000;
    this.scene.add(this.skyMesh);

    // Remove solid color background - sky dome replaces it
    this.scene.background = null;
  }

  private async createSkyWebGPU(): Promise<void> {
    const { material } = await createWebGPUSkyMaterial(
      this.config.sunPosition,
      this.config.turbidity
    );

    const skyGeometry = new THREE.SphereGeometry(SKY_DOME_RADIUS, 32, 32);
    this.skyMesh = new THREE.Mesh(skyGeometry, material);
    this.skyMesh.renderOrder = -1000;
    this.scene.add(this.skyMesh);

    // Remove solid color background - sky dome replaces it
    this.scene.background = null;
  }

  private createSun(): void {
    const sunGeometry = new THREE.SphereGeometry(SUN_DISK_RADIUS, 32, 32);
    const sunMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffee,
      transparent: true,
      opacity: 0.9
    });

    this.sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);

    const sunDir = this.config.sunPosition.clone().normalize();
    this.sunMesh.position.copy(sunDir.multiplyScalar(SUN_DISTANCE));

    this.scene.add(this.sunMesh);

    // Inner glow
    const glowGeometry = new THREE.SphereGeometry(SUN_INNER_GLOW_RADIUS, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffff88,
      transparent: true,
      opacity: 0.3,
      side: THREE.BackSide
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    this.sunMesh.add(glowMesh);

    // Outer glow
    const outerGlowGeometry = new THREE.SphereGeometry(SUN_OUTER_GLOW_RADIUS, 32, 32);
    const outerGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffeeaa,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide
    });
    const outerGlowMesh = new THREE.Mesh(outerGlowGeometry, outerGlowMaterial);
    this.sunMesh.add(outerGlowMesh);
  }

  private createCloudsWebGL(): void {
    CLOUD_LAYERS.forEach((layerConfig, index) => {
      // Create independent uniforms for each layer
      const layerUniforms = {
        time: { value: 0 },
        cloudDensity: { value: this.config.cloudDensity },
        sunPosition: { value: this.config.sunPosition.clone() },
        opacity: { value: layerConfig.opacity }
      };

      const cloudMaterial = new THREE.ShaderMaterial({
        uniforms: layerUniforms,
        vertexShader: cloudVertexShader,
        fragmentShader: cloudFragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      });

      const cloudGeometry = new THREE.PlaneGeometry(layerConfig.size, layerConfig.size, 1, 1);
      const cloudMesh = new THREE.Mesh(cloudGeometry, cloudMaterial);
      cloudMesh.rotation.x = -Math.PI / 2;
      cloudMesh.position.y = this.config.cloudAltitude + layerConfig.altitudeOffset;
      cloudMesh.renderOrder = -900 + index;

      // Store reference to uniforms on the mesh for updates
      (cloudMesh as any).cloudUniforms = layerUniforms;

      this.cloudLayers.push(cloudMesh);
      this.scene.add(cloudMesh);
    });
  }

  private async createCloudsWebGPU(): Promise<void> {
    for (let index = 0; index < CLOUD_LAYERS.length; index++) {
      const layerConfig = CLOUD_LAYERS[index];

      const { material, uniforms } = await createWebGPUCloudMaterial(
        this.config.sunPosition,
        this.config.cloudDensity,
        layerConfig.opacity
      );

      this.webgpuCloudUniforms.push(uniforms);

      const cloudGeometry = new THREE.PlaneGeometry(layerConfig.size, layerConfig.size, 1, 1);
      const cloudMesh = new THREE.Mesh(cloudGeometry, material);
      cloudMesh.rotation.x = -Math.PI / 2;
      cloudMesh.position.y = this.config.cloudAltitude + layerConfig.altitudeOffset;
      cloudMesh.renderOrder = -900 + index;

      // Store index for WebGPU uniform updates
      (cloudMesh as any).webgpuUniformIndex = index;

      this.cloudLayers.push(cloudMesh);
      this.scene.add(cloudMesh);
    }
  }

  private setupFog(): void {
    this.scene.fog = new THREE.FogExp2(this.config.fogColor, this.config.fogDensity);
  }

  /**
   * Update the sky system - call each frame
   */
  public update(deltaTime: number, cameraPosition?: THREE.Vector3): void {
    this.time += deltaTime;

    // Pre-calculate wind offset once per frame
    const windOffsetX = Math.sin(this.time * 0.01) * 1000;
    const windOffsetZ = Math.cos(this.time * 0.008) * 800;

    // Keep sky dome centered on camera
    if (cameraPosition && this.skyMesh) {
      this.skyMesh.position.copy(cameraPosition);
    }

    // Keep sun at consistent visual position relative to camera
    if (cameraPosition && this.sunMesh) {
      const sunDir = this.config.sunPosition.clone().normalize();
      this.sunMesh.position.copy(cameraPosition).add(sunDir.multiplyScalar(SUN_DISTANCE));
    }

    // Update cloud layers
    this.cloudLayers.forEach((cloud, index) => {
      // Update time uniform (WebGL path)
      const uniforms = (cloud as any).cloudUniforms;
      if (uniforms) {
        uniforms.time.value = this.time;
      }

      // Update time uniform (WebGPU path)
      const webgpuIndex = (cloud as any).webgpuUniformIndex;
      if (webgpuIndex !== undefined && this.webgpuCloudUniforms[webgpuIndex]) {
        this.webgpuCloudUniforms[webgpuIndex].time.value = this.time;
      }

      // Apply wind with layer-specific speed multiplier
      const layerSpeedMultiplier = 1.0 + index * 0.4;
      cloud.position.x = windOffsetX * layerSpeedMultiplier;
      cloud.position.z = windOffsetZ * layerSpeedMultiplier;

      // Keep clouds centered around camera horizontally
      if (cameraPosition) {
        cloud.position.x += cameraPosition.x;
        cloud.position.z += cameraPosition.z;
      }
    });
  }

  /**
   * Update sun position (affects sky color and cloud lighting)
   * Note: Also updates the visual sun mesh position relative to current camera
   */
  public setSunPosition(position: THREE.Vector3): void {
    this.config.sunPosition.copy(position);

    if (this.skyUniforms.sunPosition) {
      this.skyUniforms.sunPosition.value.copy(position);
    }

    // Update cloud uniforms
    this.cloudLayers.forEach(cloud => {
      const uniforms = (cloud as any).cloudUniforms;
      if (uniforms?.sunPosition) {
        uniforms.sunPosition.value.copy(position);
      }
    });

    if (this.sunMesh) {
      const sunDir = position.clone().normalize();
      this.sunMesh.position.copy(sunDir.multiplyScalar(SUN_DISTANCE));
    }
  }

  /**
   * Set cloud density (0-1)
   */
  public setCloudDensity(density: number): void {
    this.config.cloudDensity = Math.max(0, Math.min(1, density));
    this.cloudLayers.forEach(cloud => {
      const uniforms = (cloud as any).cloudUniforms;
      if (uniforms?.cloudDensity) {
        uniforms.cloudDensity.value = this.config.cloudDensity;
      }
    });
  }

  /**
   * Set atmospheric turbidity (haziness 1-10)
   */
  public setTurbidity(turbidity: number): void {
    this.config.turbidity = Math.max(1, Math.min(10, turbidity));
    if (this.skyUniforms.turbidity) {
      this.skyUniforms.turbidity.value = this.config.turbidity;
    }
  }

  /**
   * Set fog density
   */
  public setFogDensity(density: number): void {
    this.config.fogDensity = density;
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = density;
    }
  }

  /**
   * Clean up all resources
   */
  public dispose(): void {
    if (this.skyMesh) {
      this.scene.remove(this.skyMesh);
      this.skyMesh.geometry.dispose();
      (this.skyMesh.material as THREE.Material).dispose();
    }

    if (this.sunMesh) {
      this.scene.remove(this.sunMesh);
      this.sunMesh.geometry.dispose();
      (this.sunMesh.material as THREE.Material).dispose();
    }

    this.cloudLayers.forEach(cloud => {
      this.scene.remove(cloud);
      cloud.geometry.dispose();
      (cloud.material as THREE.Material).dispose();
    });
    this.cloudLayers = [];
  }
}

// ============================================================================
// Module API
// ============================================================================

let skySystemInstance: SkySystem | null = null;

/**
 * Initialize the sky system
 * @param scene - Three.js scene
 * @param config - Sky configuration including rendererType ('webgl' or 'webgpu')
 */
export async function initSkySystem(scene: THREE.Scene, config?: Partial<SkyConfig>): Promise<SkySystem> {
  if (skySystemInstance) {
    skySystemInstance.dispose();
  }
  skySystemInstance = new SkySystem(scene, config);
  await skySystemInstance.initAsync();
  return skySystemInstance;
}

/**
 * Get the sky system instance
 */
export function getSkySystem(): SkySystem | null {
  return skySystemInstance;
}

/**
 * Update the sky system
 */
export function updateSky(deltaTime: number, cameraPosition?: THREE.Vector3): void {
  if (skySystemInstance) {
    skySystemInstance.update(deltaTime, cameraPosition);
  }
}
