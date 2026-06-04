import { Express } from 'express';
import { db } from '../database';
import { whatsappAccounts, autoReplyRules, autoReplyLogs } from '../database/schema';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { buildAutoReplyBrainPreview } from '../services/auto-reply-brain.service';

export function setupAutoReplyRoutes(app: Express) {
  // Auto-Reply Rules - Get all
  app.get('/api/auto-reply/rules', (req, res) => {
    try {
      const rules = db.select()
        .from(autoReplyRules)
        .orderBy(desc(autoReplyRules.createdAt))
        .all();

      const accountsMap = new Map(
        db.select().from(whatsappAccounts).all().map((account: any) => [account.id, account])
      );

      const enrichedRules = rules.map((rule: any) => {
        const account = accountsMap.get(rule.accountId);
        return {
          ...rule,
          accountPhone: account?.phoneNumber || account?.phone_number || rule.accountId,
          accountDisplayName: account?.displayName || account?.display_name || '',
        };
      });
      
      res.status(200).json(enrichedRules);
    } catch (error: any) {
      logger.error('Error fetching auto-reply rules:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-Reply Rules - Create
  app.post('/api/auto-reply/rules', (req, res) => {
    try {
      const { accountId, triggerType, triggerValue, activeHourStart, activeHourEnd, aiProvider, aiModel, systemPrompt, delayMin, delayMax, isEnabled, mediaPath, mediaType, mediaMimeType, mediaFileName, sendAsVoiceNote, silentPolicy, languagePolicy, escalationKeywords, allowFollowup } = req.body;
      
      const id = 'rule_' + uuidv4();
      
      db.insert(autoReplyRules).values({
        id,
        accountId,
        name: `${triggerType} Rule`,
        triggerType,
        keywords: triggerType === 'keyword' ? triggerValue : '',
        workingHours: `${activeHourStart}-${activeHourEnd}`,
        aiProviderId: aiProvider,
        aiModel,
        systemPrompt,
        mediaPath: mediaPath || null,
        mediaType: mediaType || null,
        mediaMimeType: mediaMimeType || null,
        mediaFileName: mediaFileName || null,
        sendAsVoiceNote: sendAsVoiceNote ? 1 : 0,
        silentPolicy: silentPolicy || null,
        languagePolicy: languagePolicy || null,
        escalationKeywords: escalationKeywords || null,
        allowFollowup: typeof allowFollowup === 'boolean' ? (allowFollowup ? 1 : 0) : 1,
        responseDelayMinMs: delayMin * 1000,
        responseDelayMaxMs: delayMax * 1000,
        isActive: isEnabled ? 1 : 0,
        createdAt: new Date().toISOString()
      }).run();

      res.status(201).json({
        id,
        message: 'Auto-reply rule created successfully'
      });
    } catch (error: any) {
      logger.error('Error creating auto-reply rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-Reply Rules - Update
  app.patch('/api/auto-reply/rules/:id', (req, res) => {
    try {
      const { id } = req.params;
      const updateData: any = {};

      if ('isEnabled' in req.body) {
        updateData.isActive = req.body.isEnabled ? 1 : 0;
      }
      if ('silentPolicy' in req.body) {
        updateData.silentPolicy = req.body.silentPolicy || null;
      }
      if ('languagePolicy' in req.body) {
        updateData.languagePolicy = req.body.languagePolicy || null;
      }
      if ('escalationKeywords' in req.body) {
        updateData.escalationKeywords = req.body.escalationKeywords || null;
      }
      if ('allowFollowup' in req.body) {
        updateData.allowFollowup = req.body.allowFollowup ? 1 : 0;
      }
      if ('systemPrompt' in req.body) {
        updateData.systemPrompt = req.body.systemPrompt || null;
      }

      db.update(autoReplyRules)
        .set(updateData)
        .where(eq(autoReplyRules.id, id))
        .run();

      res.status(200).json({ message: 'Auto-reply rule updated successfully' });
    } catch (error: any) {
      logger.error('Error updating auto-reply rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-Reply Rules - Delete
  app.delete('/api/auto-reply/rules/:id', (req, res) => {
    try {
      const { id } = req.params;
      
      db.delete(autoReplyRules)
        .where(eq(autoReplyRules.id, id))
        .run();

      res.status(200).json({ message: 'Auto-reply rule deleted successfully' });
    } catch (error: any) {
      logger.error('Error deleting auto-reply rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-Reply Logs - Get all
  app.get('/api/auto-reply/logs', (req, res) => {
    try {
      const logs = db.select()
        .from(autoReplyLogs)
        .orderBy(desc(autoReplyLogs.createdAt))
        .all();

      res.status(200).json(logs);
    } catch (error: any) {
      logger.error('Error fetching auto-reply logs:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-Reply Logs - Create
  app.post('/api/auto-reply/logs', (req, res) => {
    try {
      const { ruleId, fromPhone, incomingMessage, autoReply, mediaPath, mediaType, status, decisionType, detectedIntent, detectedLanguage, escalationReason, brainContext } = req.body;
      
      const id = 'log_' + uuidv4();
      
      db.insert(autoReplyLogs).values({
        id,
        ruleId,
        fromPhone,
        incomingMessage,
        autoReply,
        mediaPath: mediaPath || null,
        mediaType: mediaType || null,
        status,
        decisionType: decisionType || null,
        detectedIntent: detectedIntent || null,
        detectedLanguage: detectedLanguage || null,
        escalationReason: escalationReason || null,
        brainContext: brainContext ? JSON.stringify(brainContext) : null,
        createdAt: new Date().toISOString()
      }).run();

      res.status(201).json({ id, message: 'Auto-reply log created' });
    } catch (error: any) {
      logger.error('Error creating auto-reply log:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Auto-Reply Brain - Evaluate
  app.post('/api/auto-reply/brain/evaluate', async (req, res) => {
    try {
      const { accountId, contactId, remoteJid, message, ruleId } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await buildAutoReplyBrainPreview({
        accountId: accountId || null,
        contactId: contactId || null,
        remoteJid: remoteJid || null,
        message,
        ruleId: ruleId || null,
      });

      res.status(200).json(result);
    } catch (error: any) {
      logger.error('Error evaluating auto-reply brain:', error);
      res.status(500).json({ error: error.message || 'Failed to evaluate auto-reply brain' });
    }
  });
}
