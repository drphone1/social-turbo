/**
 * Random Delay Utility
 * Prevents WhatsApp account from being banned due to rapid message sending
 */

export interface DelayConfig {
  minMs: number;  // Minimum delay in milliseconds
  maxMs: number;  // Maximum delay in milliseconds
  enabled: boolean;
}

export const DEFAULT_DELAY_CONFIG: DelayConfig = {
  minMs: 2000,    // 2 seconds minimum
  maxMs: 8000,    // 8 seconds maximum
  enabled: true
};

/**
 * Generate random delay between min and max
 */
export function getRandomDelay(config: DelayConfig = DEFAULT_DELAY_CONFIG): number {
  if (!config.enabled) return 0;
  return Math.random() * (config.maxMs - config.minMs) + config.minMs;
}

/**
 * Sleep for specified milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Apply random delay before executing action
 */
export async function withRandomDelay<T>(
  fn: () => Promise<T>,
  config: DelayConfig = DEFAULT_DELAY_CONFIG
): Promise<T> {
  const delay = getRandomDelay(config);
  await sleep(delay);
  return fn();
}

/**
 * Get human-readable delay string
 */
export function formatDelay(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
