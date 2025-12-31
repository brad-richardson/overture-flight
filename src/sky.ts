import * as THREE from 'three';

/**
 * Sky System for Overture Flight Simulator
 *
 * Features:
 * - Procedural atmospheric sky with Rayleigh scattering simulation
 * - Visible sun disk
 * - Procedural clouds at realistic altitudes
 * - Atmospheric fog/haze
 */

// Sky configuration
export interface SkyConfig {
  sunPosition: THREE.Vector3;
  turbidity: number;        // Atmospheric turbidity (haziness) 1-10
  rayleigh: number;         // Rayleigh scattering coefficient
  mieCoefficient: number;   // Mie scattering coefficient
  mieDirectionalG: number;  // Mie directional parameter
  cloudDensity: number;     // 0-1 cloud coverage
  cloudAltitude: number;    // Cloud layer altitude in meters
  fogDensity: number;       // Atmospheric fog density
}

const DEFAULT_CONFIG: SkyConfig = {
  sunPosition: new THREE.Vector3(1000, 2000, 1000),
  turbidity: 2,
  rayleigh: 1.5,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  cloudDensity: 0.4,
  cloudAltitude: 3000,
  fogDensity: 0.00008
};

// Sky shader - atmospheric scattering
const skyVertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vSunDirection;
  varying float vSunfade;
  varying vec3 vBetaR;
  varying vec3 vBetaM;
  varying float vSunE;

  uniform vec3 sunPosition;
  uniform float rayleigh;
  uniform float turbidity;
  uniform float mieCoefficient;

  const float e = 2.71828182845904523536028747135266249775724709369995957;
  const float pi = 3.141592653589793238462643383279502884197169;
  const float n = 1.0003; // refractive index of air
  const float N = 2.545E25; // number of molecules per unit volume
  const float pn = 0.035; // depolarization factor for standard air
  const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
  const vec3 K = vec3(0.686, 0.678, 0.666);
  const float v = 4.0;
  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;
  const vec3 up = vec3(0.0, 1.0, 0.0);
  const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;
  const float cutoffAngle = pi / 1.95;
  const float steepness = 1.5;

  vec3 totalRayleigh(vec3 lambda) {
    return (8.0 * pow(pi, 3.0) * pow(pow(n, 2.0) - 1.0, 2.0) * (6.0 + 3.0 * pn)) /
           (3.0 * N * pow(lambda, vec3(4.0)) * (6.0 - 7.0 * pn));
  }

  float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * pi)) * (1.0 + pow(cosTheta, 2.0));
  }

  vec3 totalMie(vec3 lambda, vec3 K, float T) {
    float c = (0.2 * T) * 10E-18;
    return 0.434 * c * pi * pow((2.0 * pi) / lambda, vec3(v - 2.0)) * K;
  }

  float hgPhase(float cosTheta, float g) {
    return (1.0 / (4.0 * pi)) * ((1.0 - pow(g, 2.0)) / pow(1.0 - 2.0 * g * cosTheta + pow(g, 2.0), 1.5));
  }

  float sunIntensity(float zenithAngleCos) {
    return max(0.0, 1.0 - exp(-((cutoffAngle - acos(zenithAngleCos)) / steepness)));
  }

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    vSunDirection = normalize(sunPosition);
    vSunE = sunIntensity(dot(vSunDirection, up));
    vSunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);

    float rayleighCoefficient = rayleigh - (1.0 * (1.0 - vSunfade));
    vBetaR = totalRayleigh(lambda) * rayleighCoefficient;
    vBetaM = totalMie(lambda, K, turbidity) * mieCoefficient;
  }
`;

const skyFragmentShader = `
  varying vec3 vWorldPosition;
  varying vec3 vSunDirection;
  varying float vSunfade;
  varying vec3 vBetaR;
  varying vec3 vBetaM;
  varying float vSunE;

  uniform float mieDirectionalG;
  uniform vec3 sunPosition;

  const float pi = 3.141592653589793238462643383279502884197169;
  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;
  const vec3 up = vec3(0.0, 1.0, 0.0);
  const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

  float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * pi)) * (1.0 + pow(cosTheta, 2.0));
  }

  float hgPhase(float cosTheta, float g) {
    return (1.0 / (4.0 * pi)) * ((1.0 - pow(g, 2.0)) / pow(1.0 - 2.0 * g * cosTheta + pow(g, 2.0), 1.5));
  }

  void main() {
    vec3 direction = normalize(vWorldPosition - cameraPosition);
    float zenithAngle = acos(max(0.0, dot(up, direction)));
    float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
    float sR = rayleighZenithLength * inverse;
    float sM = mieZenithLength * inverse;

    vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

    float cosTheta = dot(direction, vSunDirection);
    float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaRTheta = vBetaR * rPhase;

    float mPhase = hgPhase(cosTheta, mieDirectionalG);
    vec3 betaMTheta = vBetaM * mPhase;

    vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(0.5)),
               clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));

    // Night sky
    float theta = acos(direction.y);
    float phi = atan(direction.z, direction.x);
    vec2 uv = vec2(phi, theta) / vec2(2.0 * pi, pi) + vec2(0.5, 0.0);
    vec3 L0 = vec3(0.1) * Fex;

    // Sun disk
    float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);
    L0 += (vSunE * 19000.0 * Fex) * sundisk;

    vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);

    // Tone mapping
    vec3 retColor = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade))));

    gl_FragColor = vec4(retColor, 1.0);
  }
`;

// Cloud shader
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

// Sky system class
export class SkySystem {
  private scene: THREE.Scene;
  private config: SkyConfig;
  private skyMesh: THREE.Mesh | null = null;
  private sunMesh: THREE.Mesh | null = null;
  private cloudLayers: THREE.Mesh[] = [];
  private skyUniforms: { [key: string]: THREE.IUniform } = {};
  private cloudUniforms: { [key: string]: THREE.IUniform } = {};
  private time: number = 0;

  constructor(scene: THREE.Scene, config: Partial<SkyConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.init();
  }

  private init(): void {
    this.createSky();
    this.createSun();
    this.createClouds();
    this.setupFog();
  }

  private createSky(): void {
    // Sky uniforms for shader
    this.skyUniforms = {
      sunPosition: { value: this.config.sunPosition.clone() },
      rayleigh: { value: this.config.rayleigh },
      turbidity: { value: this.config.turbidity },
      mieCoefficient: { value: this.config.mieCoefficient },
      mieDirectionalG: { value: this.config.mieDirectionalG }
    };

    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: skyVertexShader,
      fragmentShader: skyFragmentShader,
      side: THREE.BackSide,
      depthWrite: false
    });

    // Large sphere for sky dome
    const skyGeometry = new THREE.SphereGeometry(90000, 32, 32);
    this.skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    this.skyMesh.renderOrder = -1000; // Render first
    this.scene.add(this.skyMesh);

    // Remove the solid color background
    this.scene.background = null;
  }

  private createSun(): void {
    // Create a glowing sun sprite
    const sunGeometry = new THREE.SphereGeometry(500, 32, 32);
    const sunMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffee,
      transparent: true,
      opacity: 0.9
    });

    this.sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);

    // Position sun based on light direction
    const sunDir = this.config.sunPosition.clone().normalize();
    this.sunMesh.position.copy(sunDir.multiplyScalar(80000));

    this.scene.add(this.sunMesh);

    // Add sun glow
    const glowGeometry = new THREE.SphereGeometry(800, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffff88,
      transparent: true,
      opacity: 0.3,
      side: THREE.BackSide
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    this.sunMesh.add(glowMesh);

    // Add outer glow
    const outerGlowGeometry = new THREE.SphereGeometry(1200, 32, 32);
    const outerGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffeeaa,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide
    });
    const outerGlowMesh = new THREE.Mesh(outerGlowGeometry, outerGlowMaterial);
    this.sunMesh.add(outerGlowMesh);
  }

  private createClouds(): void {
    this.cloudUniforms = {
      time: { value: 0 },
      cloudDensity: { value: this.config.cloudDensity },
      sunPosition: { value: this.config.sunPosition.clone() },
      opacity: { value: 0.85 }
    };

    const cloudMaterial = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    // Create multiple cloud layers at different altitudes
    const cloudLayerConfigs = [
      { altitude: this.config.cloudAltitude, size: 80000, opacity: 0.7 },
      { altitude: this.config.cloudAltitude + 500, size: 70000, opacity: 0.5 },
      { altitude: this.config.cloudAltitude + 1000, size: 60000, opacity: 0.3 }
    ];

    cloudLayerConfigs.forEach((layerConfig, index) => {
      const cloudGeometry = new THREE.PlaneGeometry(layerConfig.size, layerConfig.size, 1, 1);
      const layerMaterial = cloudMaterial.clone();
      layerMaterial.uniforms = {
        ...this.cloudUniforms,
        opacity: { value: layerConfig.opacity }
      };

      const cloudMesh = new THREE.Mesh(cloudGeometry, layerMaterial);
      cloudMesh.rotation.x = -Math.PI / 2;
      cloudMesh.position.y = layerConfig.altitude;
      cloudMesh.renderOrder = -900 + index;

      this.cloudLayers.push(cloudMesh);
      this.scene.add(cloudMesh);
    });
  }

  private setupFog(): void {
    // Exponential fog for atmospheric depth
    this.scene.fog = new THREE.FogExp2(0x9dc4e8, this.config.fogDensity);
  }

  /**
   * Update the sky system (call in animation loop)
   */
  public update(deltaTime: number, cameraPosition?: THREE.Vector3): void {
    this.time += deltaTime;

    // Update cloud animation
    if (this.cloudUniforms.time) {
      this.cloudUniforms.time.value = this.time;
    }

    // Keep sky dome centered on camera
    if (cameraPosition && this.skyMesh) {
      this.skyMesh.position.copy(cameraPosition);
    }

    // Keep sun at consistent visual position relative to camera
    if (cameraPosition && this.sunMesh) {
      const sunDir = this.config.sunPosition.clone().normalize();
      this.sunMesh.position.copy(cameraPosition).add(sunDir.multiplyScalar(80000));
    }

    // Move cloud layers slightly with wind
    this.cloudLayers.forEach((cloud, index) => {
      const windSpeed = 0.5 + index * 0.2;
      cloud.position.x = Math.sin(this.time * 0.01 * windSpeed) * 1000;
      cloud.position.z = Math.cos(this.time * 0.008 * windSpeed) * 800;

      // Keep clouds centered around camera horizontally
      if (cameraPosition) {
        cloud.position.x += cameraPosition.x;
        cloud.position.z += cameraPosition.z;
      }
    });
  }

  /**
   * Update sun position (affects sky color and cloud lighting)
   */
  public setSunPosition(position: THREE.Vector3): void {
    this.config.sunPosition.copy(position);

    if (this.skyUniforms.sunPosition) {
      this.skyUniforms.sunPosition.value.copy(position);
    }

    if (this.cloudUniforms.sunPosition) {
      this.cloudUniforms.sunPosition.value.copy(position);
    }

    if (this.sunMesh) {
      const sunDir = position.clone().normalize();
      this.sunMesh.position.copy(sunDir.multiplyScalar(80000));
    }
  }

  /**
   * Set cloud density (0-1)
   */
  public setCloudDensity(density: number): void {
    this.config.cloudDensity = Math.max(0, Math.min(1, density));
    if (this.cloudUniforms.cloudDensity) {
      this.cloudUniforms.cloudDensity.value = this.config.cloudDensity;
    }
  }

  /**
   * Set atmospheric turbidity (haziness)
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
   * Clean up resources
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

// Singleton instance
let skySystemInstance: SkySystem | null = null;

/**
 * Initialize the sky system
 */
export function initSkySystem(scene: THREE.Scene, config?: Partial<SkyConfig>): SkySystem {
  if (skySystemInstance) {
    skySystemInstance.dispose();
  }
  skySystemInstance = new SkySystem(scene, config);
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
