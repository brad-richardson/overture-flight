import * as THREE from 'three';
import { worldToGeo } from './scene.js';
import type { StoredFeature } from './feature-picker.js';

/**
 * Feature Properties Modal
 *
 * Displays a modal showing all properties of clicked map features.
 * Follows the same pattern as the minimap modal for consistency.
 */

// DOM elements
let modal: HTMLElement | null = null;
let content: HTMLElement | null = null;
let coordsDisplay: HTMLElement | null = null;
let isOpen = false;

// Keyboard handler (escape + focus trap)
let keyboardHandler: ((e: KeyboardEvent) => void) | null = null;

// Focus trap elements
let focusableElements: HTMLElement[] = [];
let firstFocusable: HTMLElement | null = null;
let lastFocusable: HTMLElement | null = null;

/**
 * Format a property value for display
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '<span class="prop-null">null</span>';
  }
  if (typeof value === 'boolean') {
    return `<span class="prop-bool">${value}</span>`;
  }
  if (typeof value === 'number') {
    // Format numbers nicely
    if (Number.isInteger(value)) {
      return `<span class="prop-number">${value}</span>`;
    }
    return `<span class="prop-number">${value.toFixed(4)}</span>`;
  }
  if (typeof value === 'string') {
    return `<span class="prop-string">"${escapeHtml(value)}"</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="prop-array">[]</span>';
    if (value.length > 5) {
      return `<span class="prop-array">[${value.length} items]</span>`;
    }
    return `<span class="prop-array">[${value.map(v => formatValue(v)).join(', ')}]</span>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '<span class="prop-object">{}</span>';
    if (keys.length > 3) {
      return `<span class="prop-object">{${keys.length} properties}</span>`;
    }
    return `<span class="prop-object">{...}</span>`;
  }
  return String(value);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Get a display name for a feature
 */
function getFeatureName(feature: StoredFeature): string {
  const props = feature.properties;

  // Try common name fields
  if (props.name && typeof props.name === 'string') {
    return props.name;
  }

  // Try class/subtype for buildings
  if (props.class && typeof props.class === 'string') {
    return `${props.class} (${feature.layer})`;
  }
  if (props.subtype && typeof props.subtype === 'string') {
    return `${props.subtype} (${feature.layer})`;
  }

  // Default to layer name and geometry type
  return `${feature.layer} (${feature.type})`;
}

/**
 * Get icon for feature layer
 */
function getLayerIcon(layer: string): string {
  switch (layer) {
    case 'building':
    case 'buildings':
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L2 12h3v9h6v-6h2v6h6v-9h3L12 3zm0 5.5c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2z"/></svg>';
    case 'water':
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8z"/></svg>';
    case 'land_cover':
    case 'land':
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 6l-3.75 5 2.85 3.8-1.6 1.2C9.81 13.75 7 10 7 10l-6 8h22L14 6z"/></svg>';
    case 'transportation':
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>';
    case 'bathymetry':
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8zm0 18c-3.35 0-6-2.57-6-6.2 0-2.34 1.95-5.44 6-9.14 4.05 3.7 6 6.79 6 9.14 0 3.63-2.65 6.2-6 6.2z"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>';
  }
}

/**
 * Render a single feature's properties
 */
function renderFeature(feature: StoredFeature, index: number, total: number): string {
  const name = getFeatureName(feature);
  const icon = getLayerIcon(feature.layer);

  // Filter out coordinate data and internal properties
  const filteredProps = Object.entries(feature.properties)
    .filter(([key]) => {
      // Skip geometry-related and internal fields
      return !['geometry', 'coordinates', 'bbox', 'extent'].includes(key);
    })
    .sort(([a], [b]) => {
      // Sort with important properties first
      const priority = ['id', 'name', 'class', 'subtype', 'height', 'num_floors'];
      const aIdx = priority.indexOf(a);
      const bIdx = priority.indexOf(b);
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
      if (aIdx >= 0) return -1;
      if (bIdx >= 0) return 1;
      return a.localeCompare(b);
    });

  const propsHtml = filteredProps.length > 0
    ? filteredProps.map(([key, value]) =>
        `<tr><td class="prop-key">${escapeHtml(key)}</td><td class="prop-value">${formatValue(value)}</td></tr>`
      ).join('')
    : '<tr><td colspan="2" class="prop-empty">No properties</td></tr>';

  return `
    <div class="feature-card" data-index="${index}">
      <div class="feature-header">
        <div class="feature-icon">${icon}</div>
        <div class="feature-title">
          <h3>${escapeHtml(name)}</h3>
          <span class="feature-layer">${escapeHtml(feature.layer)}</span>
        </div>
        ${total > 1 ? `<span class="feature-count">${index + 1}/${total}</span>` : ''}
      </div>
      <table class="feature-props">
        <tbody>
          ${propsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Sets up focus trap for the modal to ensure keyboard users
 * cannot tab out to background elements (WCAG compliance).
 */
function setupFocusTrap(): void {
  if (!modal) return;

  // Find all focusable elements within the modal
  const focusableSelectors = [
    'button:not([disabled])',
    'input:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  focusableElements = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelectors));

  if (focusableElements.length > 0) {
    firstFocusable = focusableElements[0];
    lastFocusable = focusableElements[focusableElements.length - 1];
  }
}

/**
 * Open the modal with feature data
 */
export function showFeatureModal(features: StoredFeature[], worldPos: THREE.Vector3): void {
  if (!modal || !content) {
    console.warn('Feature modal not initialized');
    return;
  }

  // Convert world position to geo coordinates
  const geo = worldToGeo(worldPos.x, worldPos.y, worldPos.z);

  // Update coordinates display
  if (coordsDisplay) {
    coordsDisplay.textContent = `Lat: ${geo.lat.toFixed(5)}, Lon: ${geo.lng.toFixed(5)}`;
  }

  // Render all features
  const html = features.map((f, i) => renderFeature(f, i, features.length)).join('');
  content.innerHTML = html;

  // Open modal
  isOpen = true;
  modal.classList.add('feature-modal-open');

  // Setup focus trap
  setupFocusTrap();

  // Focus first focusable element
  setTimeout(() => {
    firstFocusable?.focus();
  }, 100);
}

/**
 * Close the modal
 */
export function closeFeatureModal(): void {
  if (!modal) return;
  isOpen = false;
  modal.classList.remove('feature-modal-open');
}

/**
 * Check if modal is open
 */
export function isFeatureModalOpen(): boolean {
  return isOpen;
}

/**
 * Initialize the feature modal
 */
export function initFeatureModal(): void {
  modal = document.getElementById('feature-modal');
  content = document.getElementById('feature-content');
  coordsDisplay = document.getElementById('feature-coords');

  if (!modal) {
    console.warn('Feature modal element not found');
    return;
  }

  // Close button
  const closeBtn = document.getElementById('feature-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeFeatureModal);
  }

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeFeatureModal();
    }
  });

  // Remove existing keyboard handler if present (prevents duplicates during HMR)
  if (keyboardHandler) {
    document.removeEventListener('keydown', keyboardHandler);
  }

  // Keyboard handler for escape and focus trap
  keyboardHandler = (e: KeyboardEvent) => {
    if (!isOpen) return;

    // Escape key to close
    if (e.key === 'Escape') {
      closeFeatureModal();
      return;
    }

    // Focus trap: handle Tab key
    if (e.key === 'Tab') {
      if (e.shiftKey) {
        // Shift+Tab: if on first element, wrap to last
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        // Tab: if on last element, wrap to first
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable?.focus();
        }
      }
    }
  };
  document.addEventListener('keydown', keyboardHandler);
}
