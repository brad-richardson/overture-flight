/** Identity-bearing token for asynchronous work tied to a world generation. */
export interface GenerationToken {
  generation: number;
}

/** True only when this exact request still owns the key-scoped loading slot. */
export function ownsGenerationSlot<T extends GenerationToken>(
  slots: ReadonlyMap<string, T>,
  key: string,
  token: T
): boolean {
  return slots.get(key) === token;
}

/**
 * Accept work only while both its world generation and request identity remain
 * current. The identity check prevents an older completion from claiming a
 * same-key slot created by a replacement request.
 */
export function isCurrentGenerationSlot<T extends GenerationToken>(
  slots: ReadonlyMap<string, T>,
  key: string,
  token: T,
  currentGeneration: number
): boolean {
  return token.generation === currentGeneration
    && ownsGenerationSlot(slots, key, token);
}
