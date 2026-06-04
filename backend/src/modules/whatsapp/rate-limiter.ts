/**
 * Rate Limiter Service
 * Manages delays between messages per account to prevent banning
 */

import { sleep, DelayConfig, DEFAULT_DELAY_CONFIG } from '../../utils/delay';
import { logger } from '../../utils/logger';

interface QueuedMessage {
  accountId: string;
  phone: string;
  text: string;
  timestamp: number;
}

export class RateLimiter {
  private messageCounts: Map<string, number> = new Map();
  private lastMessageTime: Map<string, number> = new Map();
  private delayConfig: Map<string, DelayConfig> = new Map();
  private messageQueue: Map<string, QueuedMessage[]> = new Map();

  constructor() {
    logger.info('RateLimiter initialized');
  }

  /**
   * Set delay config for specific account
   */
  setAccountDelayConfig(accountId: string, config: DelayConfig) {
    this.delayConfig.set(accountId, config);
    logger.info(`Delay config set for account ${accountId}: ${config.minMs}ms-${config.maxMs}ms`);
  }

  /**
   * Get delay config for account (or default)
   */
  getAccountDelayConfig(accountId: string): DelayConfig {
    return this.delayConfig.get(accountId) || DEFAULT_DELAY_CONFIG;
  }

  /**
   * Calculate wait time before next message
   */
  async waitBeforeSend(accountId: string): Promise<number> {
    const config = this.getAccountDelayConfig(accountId);
    if (!config.enabled) return 0;

    const lastTime = this.lastMessageTime.get(accountId) || 0;
    const timeSinceLastMessage = Date.now() - lastTime;
    const randomDelay = Math.random() * (config.maxMs - config.minMs) + config.minMs;

    const waitTime = Math.max(0, randomDelay - timeSinceLastMessage);

    if (waitTime > 0) {
      logger.debug(`Account ${accountId}: Waiting ${waitTime.toFixed(0)}ms before next message`);
      await sleep(waitTime);
    }

    this.lastMessageTime.set(accountId, Date.now());
    const count = (this.messageCounts.get(accountId) || 0) + 1;
    this.messageCounts.set(accountId, count);

    return waitTime;
  }

  /**
   * Get message statistics for account
   */
  getAccountStats(accountId: string) {
    return {
      totalMessages: this.messageCounts.get(accountId) || 0,
      lastMessageTime: this.lastMessageTime.get(accountId) || null,
      delayConfig: this.getAccountDelayConfig(accountId),
      queueLength: (this.messageQueue.get(accountId) || []).length
    };
  }

  /**
   * Reset stats for account
   */
  resetAccountStats(accountId: string) {
    this.messageCounts.delete(accountId);
    this.lastMessageTime.delete(accountId);
    logger.info(`Stats reset for account ${accountId}`);
  }

  /**
   * Get all account statistics
   */
  getAllStats() {
    const stats: any = {};
    for (const [accountId] of this.messageCounts) {
      stats[accountId] = this.getAccountStats(accountId);
    }
    return stats;
  }
}

// Global rate limiter instance
export const rateLimiter = new RateLimiter();

// Set default delays for all accounts
// Can be customized per account via setAccountDelayConfig
export function initializeRateLimiter() {
  logger.info('Initializing rate limiter with default config');
  return rateLimiter;
}
