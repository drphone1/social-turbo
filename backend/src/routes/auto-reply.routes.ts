import Database from 'better-sqlite3';
import { Router } from 'express';

const router = Router();
const db = new Database('./database/whatsapp-turbo.db');

/**
 * GET /api/auto-reply/rules
 * Get all auto-reply rules
 */
router.get('/rules', (req, res) => {
  try {
    const rules = db.prepare(`
      SELECT ar.*, wa.phone_number as accountPhone
      FROM auto_reply_rules ar
      LEFT JOIN whatsapp_accounts wa ON ar.account_id = wa.id
      ORDER BY ar.created_at DESC
    `).all();

    res.status(200).json(rules);
  } catch (error: any) {
    console.error('Error fetching auto-reply rules:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auto-reply/rules
 * Create a new auto-reply rule
 */
router.post('/rules', (req, res) => {
  const { accountId, triggerType, triggerValue, activeHourStart, activeHourEnd, aiProvider, aiModel, systemPrompt, delayMin, delayMax, isEnabled } = req.body;

  try {
    const id = 'rule_' + Date.now();
    
    db.prepare(`
      INSERT INTO auto_reply_rules (
        id, account_id, trigger_type, trigger_value, 
        active_hour_start, active_hour_end, ai_provider, ai_model, 
        system_prompt, delay_min, delay_max, is_enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, accountId, triggerType, triggerValue,
      activeHourStart, activeHourEnd, aiProvider, aiModel,
      systemPrompt, delayMin, delayMax, isEnabled ? 1 : 0, new Date().toISOString()
    );

    res.status(201).json({
      id,
      message: 'Rule created successfully'
    });
  } catch (error: any) {
    console.error('Error creating auto-reply rule:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/auto-reply/rules/:id
 * Update auto-reply rule status
 */
router.patch('/rules/:id', (req, res) => {
  const { id } = req.params;
  const { isEnabled } = req.body;

  try {
    db.prepare(`
      UPDATE auto_reply_rules 
      SET is_enabled = ?
      WHERE id = ?
    `).run(isEnabled ? 1 : 0, id);

    res.status(200).json({ message: 'Rule updated successfully' });
  } catch (error: any) {
    console.error('Error updating rule:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/auto-reply/rules/:id
 * Delete an auto-reply rule
 */
router.delete('/rules/:id', (req, res) => {
  const { id } = req.params;

  try {
    db.prepare('DELETE FROM auto_reply_rules WHERE id = ?').run(id);
    res.status(200).json({ message: 'Rule deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting rule:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/auto-reply/logs
 * Get auto-reply response logs
 */
router.get('/logs', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT * FROM auto_reply_logs
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    res.status(200).json(logs);
  } catch (error: any) {
    console.error('Error fetching auto-reply logs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auto-reply/logs
 * Create auto-reply log entry
 */
router.post('/logs', (req, res) => {
  const { ruleId, fromPhone, incomingMessage, autoReply, status, ruleData } = req.body;

  try {
    const id = 'log_' + Date.now();
    
    db.prepare(`
      INSERT INTO auto_reply_logs (
        id, rule_id, from_phone, incoming_message, auto_reply, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, ruleId, fromPhone, incomingMessage, autoReply, status, new Date().toISOString()
    );

    res.status(201).json({ id, message: 'Log created' });
  } catch (error: any) {
    console.error('Error creating auto-reply log:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
