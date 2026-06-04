import { Express } from 'express';
import { setupAccountRoutes } from './accounts.routes';
import { setupContactRoutes } from './contacts.routes';
import { setupWarmupRoutes } from './warmup.routes';
import { setupRoutesLegacy } from '../routes.legacy';

/**
 * Setup all modular routes
 * Phase 2.7: Architecture Refactoring
 * 
 * This file orchestrates route setup with a mix of:
 * - New modular routes (accounts, contacts)
 * - Legacy routes (campaigns, auto-reply, etc.) - to be refactored
 */
export function setupRoutes(app: Express) {
  // Load new modular routes
  setupAccountRoutes(app);
  setupContactRoutes(app);
  setupWarmupRoutes(app);
  
  // Load legacy routes (temporary - will be modularized in next iteration)
  setupRoutesLegacy(app);
}

export { setupAccountRoutes } from './accounts.routes';
export { setupContactRoutes } from './contacts.routes';
