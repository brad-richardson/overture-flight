import { describe, expect, it } from 'vitest';
import {
  isCurrentGenerationSlot,
  ownsGenerationSlot,
  type GenerationToken,
} from '../src/generation-guard.js';

describe('generation guards', () => {
  it('requires both the current generation and exact request identity', () => {
    const current: GenerationToken = { generation: 3 };
    const replacement: GenerationToken = { generation: 3 };
    const slots = new Map([['14/1/2', current]]);

    expect(isCurrentGenerationSlot(slots, '14/1/2', current, 3)).toBe(true);
    expect(isCurrentGenerationSlot(slots, '14/1/2', current, 4)).toBe(false);
    expect(isCurrentGenerationSlot(slots, '14/1/2', replacement, 3)).toBe(false);
  });

  it('prevents stale cleanup from deleting a replacement request', () => {
    const stale: GenerationToken = { generation: 1 };
    const replacement: GenerationToken = { generation: 2 };
    const slots = new Map([['14/1/2', replacement]]);

    if (ownsGenerationSlot(slots, '14/1/2', stale)) {
      slots.delete('14/1/2');
    }

    expect(slots.get('14/1/2')).toBe(replacement);
  });
});
