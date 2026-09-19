/**
 * Randomised delays. The point is politeness towards the sites Nexa reads:
 * jitter keeps repeated checks off a metronome, and the floor is enforced in
 * configuration rather than here.
 */
export function randomIntBetween(minInclusive: number, maxInclusive: number): number {
  if (maxInclusive < minInclusive) {
    throw new Error(`invalid range: ${minInclusive}..${maxInclusive}`);
  }
  const span = maxInclusive - minInclusive + 1;
  return minInclusive + Math.floor(Math.random() * span);
}

/** Next poll delay in milliseconds, drawn uniformly from [min, max] seconds. */
export function randomDelayMs(minSeconds: number, maxSeconds: number): number {
  return randomIntBetween(minSeconds, maxSeconds) * 1000;
}

/** Small human-scale pause between in-page steps (page loads, dropdown opens). */
export function shortPauseMs(base = 400, spread = 700): number {
  return base + Math.floor(Math.random() * spread);
}
