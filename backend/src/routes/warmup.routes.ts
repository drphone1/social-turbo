import { Router } from 'express';
import { executeInterAccountWarmup } from '../services/warmup.service';
import { warmUpProfiles, whatsappAccounts } from '../database/schema';
import { db } from '../database';
import { eq } from 'drizzle-orm';

export function setupWarmupRoutes(app: any) {
  const router = Router();

  /**
   * GET /api/warmup/profiles
   * Get all warmup profiles
   */
  router.get('/profiles', (req, res) => {
    try {
      const profiles = db.select().from(warmUpProfiles).all();
      res.json(profiles);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/warmup/trigger
   * Trigger the inter-account warmup functionality manually
   */
  router.post('/trigger', async (req, res) => {
    try {
      const result = await executeInterAccountWarmup();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.use('/api/warmup', router);
}
