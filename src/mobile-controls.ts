/**
 * Mobile touch controls - virtual joystick for flight control
 */

// Joystick state
let joystickActive = false;
let joystickStartX = 0;
let joystickStartY = 0;
let joystickCurrentX = 0;
let joystickCurrentY = 0;
let joystickTouchId: number | null = null;

// Joystick output (-1 to 1 for each axis)
const joystickOutput = {
  x: 0, // Left/Right (roll)
  y: 0  // Up/Down (pitch)
};

// Throttle output
const throttleOutput = {
  up: false,
  down: false
};

const JOYSTICK_RADIUS = 50; // Maximum joystick movement radius
const DEAD_ZONE = 0.15; // Dead zone threshold

/**
 * Joystick state interface
 */
export interface JoystickState {
  x: number;
  y: number;
}

/**
 * Throttle state interface
 */
export interface ThrottleState {
  up: boolean;
  down: boolean;
}

/**
 * Check if device has touch capability (for hiding joystick on desktop)
 */
export function hasTouchCapability(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Check if this is a mobile/touch device
 */
export function isMobileDevice(): boolean {
  return hasTouchCapability() || window.innerWidth <= 768;
}

/**
 * Initialize mobile controls UI
 */
export function initMobileControls(): void {
  // Only show joystick on devices with actual touch capability
  if (hasTouchCapability()) {
    createJoystickUI();
  }

  // Always show throttle buttons (they work with both touch and mouse)
  createThrottleButtons();

  // Note: Desktop keyboard help is hidden via CSS @media query for narrow screens
  // We don't hide it via JS anymore because touch-capable laptops would incorrectly trigger it
}

/**
 * Hide the desktop keyboard controls help on mobile
 */
function hideDesktopControlsHelp(): void {
  const controlsHelp = document.getElementById('controls-help');
  if (controlsHelp) {
    controlsHelp.style.display = 'none';
  }
}

/**
 * Create the joystick UI element
 */
function createJoystickUI(): void {
  // Container for the joystick
  const container = document.createElement('div');
  container.id = 'joystick-container';
  container.innerHTML = `
    <div id="joystick-base">
      <div id="joystick-stick"></div>
    </div>
    <div id="joystick-label">FLIGHT</div>
  `;
  document.body.appendChild(container);

  const base = document.getElementById('joystick-base');
  const stick = document.getElementById('joystick-stick');

  if (!base || !stick) return;

  // Touch event handlers
  base.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.touches.length > 0) {
      const touch = e.touches[0];
      joystickTouchId = touch.identifier;
      joystickActive = true;

      const rect = base.getBoundingClientRect();
      joystickStartX = rect.left + rect.width / 2;
      joystickStartY = rect.top + rect.height / 2;
      joystickCurrentX = touch.clientX;
      joystickCurrentY = touch.clientY;

      updateJoystickVisual(stick);
      updateJoystickOutput();
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!joystickActive) return;

    // Find our touch
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === joystickTouchId) {
        const touch = e.touches[i];
        joystickCurrentX = touch.clientX;
        joystickCurrentY = touch.clientY;
        updateJoystickVisual(stick);
        updateJoystickOutput();
        break;
      }
    }
  }, { passive: true });

  const endJoystick = (e: TouchEvent): void => {
    // Check if our touch ended
    if (joystickActive) {
      let found = false;
      if (e.touches) {
        for (let i = 0; i < e.touches.length; i++) {
          if (e.touches[i].identifier === joystickTouchId) {
            found = true;
            break;
          }
        }
      }

      if (!found) {
        joystickActive = false;
        joystickTouchId = null;
        joystickOutput.x = 0;
        joystickOutput.y = 0;
        stick.style.transform = 'translate(-50%, -50%)';
      }
    }
  };

  document.addEventListener('touchend', endJoystick, { passive: true });
  document.addEventListener('touchcancel', endJoystick, { passive: true });
}

/**
 * Update joystick visual position
 */
function updateJoystickVisual(stick: HTMLElement): void {
  let dx = joystickCurrentX - joystickStartX;
  let dy = joystickCurrentY - joystickStartY;

  // Clamp to radius
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance > JOYSTICK_RADIUS) {
    dx = (dx / distance) * JOYSTICK_RADIUS;
    dy = (dy / distance) * JOYSTICK_RADIUS;
  }

  stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

/**
 * Update joystick output values
 */
function updateJoystickOutput(): void {
  const dx = joystickCurrentX - joystickStartX;
  const dy = joystickCurrentY - joystickStartY;

  // Normalize to -1 to 1
  joystickOutput.x = Math.max(-1, Math.min(1, dx / JOYSTICK_RADIUS));
  joystickOutput.y = Math.max(-1, Math.min(1, dy / JOYSTICK_RADIUS));

  // Apply dead zone
  if (Math.abs(joystickOutput.x) < DEAD_ZONE) joystickOutput.x = 0;
  if (Math.abs(joystickOutput.y) < DEAD_ZONE) joystickOutput.y = 0;
}

/**
 * Create throttle up/down buttons
 */
function createThrottleButtons(): void {
  const container = document.createElement('div');
  container.id = 'throttle-container';
  container.innerHTML = `
    <button id="throttle-up">▲<br><span>THR+</span></button>
    <button id="throttle-down">▼<br><span>THR-</span></button>
  `;
  document.body.appendChild(container);

  const upBtn = document.getElementById('throttle-up');
  const downBtn = document.getElementById('throttle-down');

  if (!upBtn || !downBtn) return;

  // Throttle up - touch events
  upBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    throttleOutput.up = true;
    upBtn.classList.add('active');
  }, { passive: false });

  upBtn.addEventListener('touchend', () => {
    throttleOutput.up = false;
    upBtn.classList.remove('active');
  }, { passive: true });

  upBtn.addEventListener('touchcancel', () => {
    throttleOutput.up = false;
    upBtn.classList.remove('active');
  }, { passive: true });

  // Throttle up - mouse events for desktop
  upBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    throttleOutput.up = true;
    upBtn.classList.add('active');
  });

  upBtn.addEventListener('mouseup', () => {
    throttleOutput.up = false;
    upBtn.classList.remove('active');
  });

  upBtn.addEventListener('mouseleave', () => {
    throttleOutput.up = false;
    upBtn.classList.remove('active');
  });

  // Throttle down - touch events
  downBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    throttleOutput.down = true;
    downBtn.classList.add('active');
  }, { passive: false });

  downBtn.addEventListener('touchend', () => {
    throttleOutput.down = false;
    downBtn.classList.remove('active');
  }, { passive: true });

  downBtn.addEventListener('touchcancel', () => {
    throttleOutput.down = false;
    downBtn.classList.remove('active');
  }, { passive: true });

  // Throttle down - mouse events for desktop
  downBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    throttleOutput.down = true;
    downBtn.classList.add('active');
  });

  downBtn.addEventListener('mouseup', () => {
    throttleOutput.down = false;
    downBtn.classList.remove('active');
  });

  downBtn.addEventListener('mouseleave', () => {
    throttleOutput.down = false;
    downBtn.classList.remove('active');
  });
}

/**
 * Get current joystick state
 */
export function getJoystickState(): JoystickState {
  return { ...joystickOutput };
}

/**
 * Get current throttle state
 */
export function getThrottleState(): ThrottleState {
  return { ...throttleOutput };
}

/**
 * Check if joystick is currently being used
 */
export function isJoystickActive(): boolean {
  return joystickActive;
}
