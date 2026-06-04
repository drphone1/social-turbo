import { Express } from 'express';
import { db } from './database';
import { whatsappAccounts, contacts, campaigns, aiProviders, apiKeys, autoReplyRules, autoReplyLogs, proxyProfiles, networkDiagnostics, queueJobs, accountContacts, messageLogs, contactActivities, contactTasks, groups, conversations, warmUpProfiles } from './database/schema';
import { eq, count, desc } from 'drizzle-orm';
import { connectAccount, disconnectAccount, latestQrs, deleteSession, getGroups, extractGroupMembers, getGroupMembers, runNetworkProbe, sendMessage, sendMediaMessage } from './modules/whatsapp/baileys.service';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { logger } from './utils/logger';
import { appendCampaignEvent, getCampaignExecutionSnapshot } from './services/campaign.executor';
import { executeAiControlAction, executeAiControlInstruction, getAiActionCatalog, getAiControlOverview } from './services/ai-control.service';
import { buildAutoReplyBrainPreview } from './services/auto-reply-brain.service';
import { buildAnalyticsOptimizerOverview, buildAnalyticsOptimizerRecommendations } from './services/analytics-optimizer.service';
import { getAiGovernanceOverview, listAiGovernanceLogs, previewAiGovernance } from './services/ai-governance.service';
import { getContactLeadScorecard, getLeadScoringOverview, listLeadScorecards } from './services/lead-scoring.service';
import { buildMarketingStrategistOverview, buildMarketingStrategy, buildStrategyCampaignDraft, buildStrategySegmentRecommendation } from './services/marketing-strategist.service';
import { getConnectionWidgetOverview, getNetworkDiagnosticsTable, getNetworkLatencyHistory, getOperationalHealthOverview } from './services/operational-health.service';
import { validatePhoneNumber, validatePhoneNumbers, filterValidPhoneNumbers, isWhatsAppEligible, filterWhatsAppEligible } from './utils/number-validator';
import { personalizeMessage, extractVariables, personalizeMessages, getMissingVariables, previewMessage, COMMON_VARIABLES, analyzeMessageTemplate } from './utils/message-personalizer';
import { parseCSVString, convertToCSV, validateContactData, validateCampaignData, getContactCSVTemplate, getCampaignCSVTemplate, parseContactsFromCSV, parseCampaignsFromCSV } from './utils/csv-handler';
import { segmentByTag, segmentByCompany, segmentByCountry, segmentByActivity, segmentByCustom, combineSegments, intersectSegments, splitIntoSegments, getSegmentStats, getSuggestedSegments, type ContactData } from './utils/contact-segmentation';
import { findAllDuplicates, findDuplicatesByPhone, findDuplicatesByEmail, mergeDuplicates } from './utils/deduplication';
import { createTemplate, getTemplate, getAllTemplates, getTemplatesByCategory, searchTemplates, updateTemplate, deleteTemplate, getTemplateStats, initializeDefaultTemplates } from './utils/template-manager';
import { scheduleMessage, getScheduledMessage, getAllScheduledMessages, getPendingMessages, getMessagesByAccount, getUpcomingMessages, markAsSent, markAsFailed, cancelMessage, rescheduleMessage, deleteMessage, getSchedulingStats, batchScheduleMessages } from './utils/scheduler';
import { decryptSecret, encryptSecret, maskSecret } from './utils/secret-crypto';
import { collectCampaignTextWarnings } from './utils/text-integrity';

const campaignUploadsDir = path.join(process.cwd(), 'uploads', 'campaign-media');

if (!fs.existsSync(campaignUploadsDir)) {
  fs.mkdirSync(campaignUploadsDir, { recursive: true });
}

const allowedCampaignMediaExtensions = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus',
  '.pdf', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar'
];

const campaignMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, campaignUploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const baseName = path.basename(file.originalname || 'file', ext)
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .slice(0, 60) || 'file';
    cb(null, `${Date.now()}-${baseName}${ext}`);
  }
});

const campaignMediaUpload = multer({
  storage: campaignMediaStorage,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedCampaignMediaExtensions.includes(ext)) {
      cb(new Error('نوع فایل مجاز نیست. فقط فایل‌های تصویری، ویدیویی، صوتی و اسناد رایج پشتیبانی می‌شوند.'));
      return;
    }
    cb(null, true);
  }
});

function parseCampaignContactIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)));
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? Array.from(new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseCampaignAccountIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)));
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? Array.from(new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function formatCampaignAccountLabel(account: any) {
  return account.displayName || account.phoneNumber || account.id;
}

function validateCampaignAccountSelection(value: unknown) {
  const requestedAccountIds = parseCampaignAccountIds(value);
  const allAccounts = db.select().from(whatsappAccounts).all();
  const accountMap = new Map(allAccounts.map((account: any) => [account.id, account]));
  const existingAccounts = requestedAccountIds
    .map((accountId) => accountMap.get(accountId))
    .filter((account): account is any => Boolean(account));
  const missingAccountIds = requestedAccountIds.filter((accountId) => !accountMap.has(accountId));
  const connectedAccounts = existingAccounts.filter((account: any) => account.status === 'connected');
  const disconnectedAccounts = existingAccounts.filter((account: any) => account.status !== 'connected');

  return {
    requestedAccountIds,
    existingAccounts,
    missingAccountIds,
    connectedAccounts,
    disconnectedAccounts,
  };
}

function resolveSegmentContactIds(segmentId: string | null | undefined): string[] {
  if (!segmentId) {
    return [];
  }

  const allContacts = db.select().from(contacts).all();

  return allContacts
    .filter((contact: any) => {
      let tags: string[] = [];

      try {
        tags = JSON.parse(contact.tags || '[]');
      } catch {
        tags = [];
      }

      if (segmentId === 'بدون تگ') {
        return tags.length === 0;
      }

      return tags.includes(segmentId);
    })
    .map((contact: any) => contact.id)
    .filter(Boolean);
}

function resolveCampaignRecipientIds(contactIds: unknown, segmentId: string | null | undefined): string[] {
  const directContactIds = parseCampaignContactIds(contactIds);
  if (directContactIds.length > 0) {
    return directContactIds;
  }

  return resolveSegmentContactIds(segmentId);
}

/**
 * Legacy routes setup
 * Contains all remaining routes that haven't been modularized yet
 * This will be progressively refactored in future iterations
 */
export function setupRoutesLegacy(app: Express) {
  // Health
  app.get('/api/health', (req, res) => {
    const overview = getOperationalHealthOverview('7days');
    res.json({
      status: overview.overallStatus === 'healthy' ? 'ok' : overview.overallStatus,
      db: 'ready',
      runtime: overview,
    });
  });

  // Accounts
  app.get('/api/accounts', (req, res) => {
    const accounts = db.select().from(whatsappAccounts).all();
    res.json(accounts);
  });

  app.get('/api/accounts/:id/qr', (req, res) => {
    const { id } = req.params;
    res.json({ qr: latestQrs[id] || null });
  });

  app.post('/api/accounts', (req, res) => {
    const { phone, displayName } = req.body;
    const id = uuidv4();
    db.insert(whatsappAccounts).values({
      id,
      phoneNumber: phone,
      displayName: displayName || phone,
      status: 'connecting',
      createdAt: new Date().toISOString()
    }).run();
    
    connectAccount(id);
    
    res.json({ id, status: 'connecting' });
  });

  app.post('/api/accounts/:id/connect', (req, res) => {
    const { id } = req.params;
    connectAccount(id);
    res.json({ status: 'connecting' });
  });

  app.post('/api/accounts/:id/disconnect', (req, res) => {
    const { id } = req.params;
    disconnectAccount(id);
    res.json({ status: 'disconnected' });
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await deleteSession(id);
      db.delete(whatsappAccounts).where(eq(whatsappAccounts.id, id)).run();
      res.json({ status: 'deleted' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    const { displayName, phone } = req.body;
    db.update(whatsappAccounts)
      .set({ displayName, phoneNumber: phone })
      .where(eq(whatsappAccounts.id, id))
      .run();
    res.json({ status: 'updated' });
  });

  app.get('/api/accounts/:id/groups', async (req, res) => {
    try {
      const { id } = req.params;
      const groups = await getGroups(id);
      res.json(groups);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/accounts/:id/contacts', async (req, res) => {
    try {
      const { id } = req.params;
      const { sort = 'recent' } = req.query;
      
      let contacts;
      if (sort === 'recent') {
        contacts = db.select().from(accountContacts).where(eq(accountContacts.accountId, id)).orderBy(desc(accountContacts.lastInteraction)).all();
      } else if (sort === 'name') {
        contacts = db.select().from(accountContacts).where(eq(accountContacts.accountId, id)).orderBy(accountContacts.name).all();
      } else {
        contacts = db.select().from(accountContacts).where(eq(accountContacts.accountId, id)).all();
      }
      
      res.json(contacts);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/accounts/:id/contacts/extract', async (req, res) => {
    try {
      const { id } = req.params;
      const { phones } = req.body; // Array of phones to extract
      
      let query = db.select().from(accountContacts).where(eq(accountContacts.accountId, id));
      const allContacts = query.all();
      
      const contactsToExtract = phones && phones.length > 0 
        ? allContacts.filter((c: any) => phones.includes(c.phone))
        : allContacts;

      let addedCount = 0;
      for (const c of contactsToExtract) {
        if (!c.phone) continue;
        const existing = db.select().from(contacts).where(eq(contacts.phone, c.phone)).all();
        if (existing.length === 0) {
          db.insert(contacts).values({
            id: uuidv4(),
            fullName: c.name || `Contact (${c.phone})`,
            phone: c.phone,
            source: 'contacts_tab',
            tags: JSON.stringify(['Source: Contacts Tab']),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }).run();
          addedCount++;
        }
      }
      
      res.json({ total: contactsToExtract.length, added: addedCount });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/accounts/:id/groups/:groupId/extract', async (req, res) => {
    try {
      const { id, groupId } = req.params;
      const result = await extractGroupMembers(id, groupId);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/accounts/:id/groups/:groupId/members', async (req, res) => {
    try {
      const { id, groupId } = req.params;
      const result = await getGroupMembers(id, groupId);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Account Stats and Activity
  app.get('/api/accounts/:id/stats', (req, res) => {
    try {
      const { id } = req.params;
      const account = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).all()[0];
      
      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }

      // Get message count
      const messages = db.select().from(messageLogs).where(eq(messageLogs.whatsappAccountId, id)).all();
      const totalMessages = messages.length;
      const sentMessages = messages.filter(m => m.status === 'sent').length;
      const failedMessages = messages.filter(m => m.status === 'failed').length;

      // Get unique contacts
      const accountContactsList = db.select().from(accountContacts).where(eq(accountContacts.accountId, id)).all();
      const uniqueContacts = new Set(accountContactsList.map(c => c.phone)).size;

      // Get last message
      const lastMessage = messages.length > 0 
        ? messages.sort((a, b) => {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bTime - aTime;
          })[0]
        : null;

      // Get campaigns using this account
      const allCampaigns = db.select().from(campaigns).all();
      const relatedCampaigns = allCampaigns.filter(c => {
        const accountIds = c.accountIds ? JSON.parse(c.accountIds) : [];
        return accountIds.includes(id);
      });

      const stats = {
        accountId: id,
        displayName: account.displayName,
        phoneNumber: account.phoneNumber,
        status: account.status,
        isOnline: account.status === 'connected',
        totalMessages,
        sentMessages,
        failedMessages,
        pendingMessages: totalMessages - sentMessages - failedMessages,
        uniqueContacts,
        lastActive: account.lastActive,
        lastMessageAt: lastMessage?.createdAt || null,
        lastError: account.lastError,
        activeCampaigns: relatedCampaigns.filter(c => c.status === 'running').length,
        completedCampaigns: relatedCampaigns.filter(c => c.status === 'completed').length,
        totalCampaigns: relatedCampaigns.length,
        createdAt: account.createdAt,
      };

      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get all account stats at once
  app.get('/api/accounts/stats/all', (req, res) => {
    try {
      const allAccounts = db.select().from(whatsappAccounts).all();
      const stats = allAccounts.map(account => {
        const messages = db.select().from(messageLogs).where(eq(messageLogs.whatsappAccountId, account.id)).all();
        const accountContactsList = db.select().from(accountContacts).where(eq(accountContacts.accountId, account.id)).all();
        const sentMessagesCount = messages.filter(m => m.direction === 'outbound').length;
        const allCampaigns = db.select().from(campaigns).all();
        const accountCampaigns = allCampaigns.filter((c: any) => {
          const accountIds = c.accountIds ? JSON.parse(c.accountIds) : [];
          return accountIds.includes(account.id);
        });
        const completedCount = accountCampaigns.filter((c: any) => c.status === 'completed').length;
        
        // Get groups count
        const groupsRes = db.select().from(groups).where(eq(groups.whatsappAccountId, account.id)).all();
        
        return {
          accountId: account.id,
          displayName: account.displayName,
          phoneNumber: account.phoneNumber,
          status: account.status,
          isOnline: account.status === 'connected',
          totalMessages: messages.length,
          sentMessages: sentMessagesCount,
          uniqueContacts: new Set(accountContactsList.map(c => c.phone)).size,
          totalGroups: groupsRes.length,
          completedCampaigns: completedCount,
          lastActive: account.lastActive,
        };
      });

      res.json({
        totalAccounts: allAccounts.length,
        accounts: stats,
        totalAllMessages: stats.reduce((sum, a) => sum + a.totalMessages, 0),
        totalAllContacts: stats.reduce((sum, a) => sum + a.uniqueContacts, 0),
        onlineAccounts: stats.filter(a => a.isOnline).length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Contacts
  app.get('/api/contacts', (req, res) => {
    const allContacts = db.select().from(contacts).all();
    res.json(allContacts);
  });

  app.post('/api/contacts', (req, res) => {
    const { fullName, phone, email, country, city, tags, notes } = req.body;
    const id = uuidv4();
    db.insert(contacts).values({
      id,
      fullName,
      phone,
      email,
      country,
      city,
      tags: JSON.stringify(tags || []),
      notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).run();

    // خودکار ثبت فعالیت
    db.insert(contactActivities).values({
      id: uuidv4(),
      contactId: id,
      action: 'مخاطب اضافه شد',
      description: `${fullName || phone} اضافه گردید`,
      details: `شماره: ${phone}${email ? ' | ایمیل: ' + email : ''}`,
      type: 'contact_added',
      activityData: null,
      createdAt: new Date().toISOString()
    }).run();

    res.json({ id });
  });

  app.delete('/api/contacts/:id', (req, res) => {
    const { id } = req.params;
    const contact = db.select().from(contacts).where(eq(contacts.id, id)).all()[0];
    
    db.delete(contacts).where(eq(contacts.id, id)).run();

    // خودکار ثبت فعالیت
    if (contact) {
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: id,
        action: 'مخاطب حذف شد',
        description: `${contact.fullName || contact.phone} حذف گردید`,
        details: `شماره: ${contact.phone}`,
        type: 'contact_deleted',
        activityData: null,
        createdAt: new Date().toISOString()
      }).run();
    }

    res.json({ status: 'deleted' });
  });

  // Contact Activities
  app.get('/api/contacts/activities', (req, res) => {
    try {
      const allActivities = db.select().from(contactActivities)
        .all();
      const sorted = allActivities.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(sorted);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/contacts/:id/activities', (req, res) => {
    try {
      const { id } = req.params;
      const activities = db.select().from(contactActivities)
        .where(eq(contactActivities.contactId, id))
        .all();
      const sorted = activities.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(sorted);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/contacts/:id/activities', (req, res) => {
    try {
      const { id } = req.params;
      const { action, description, details, type } = req.body;

      const activity = {
        id: uuidv4(),
        contactId: id,
        action,
        description,
        details: details || null,
        type: type || 'note_added',
        activityData: null,
        createdAt: new Date().toISOString()
      };

      db.insert(contactActivities).values(activity).run();
      res.json(activity);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Segmentation Endpoints
  app.get('/api/contacts/segments/by-tag', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all();
      const segments: any = {};

      allContacts.forEach((contact: any) => {
        let tags: string[] = [];
        try {
          tags = JSON.parse(contact.tags || '[]');
        } catch (e) {}

        if (tags.length === 0) {
          if (!segments['بدون تگ']) segments['بدون تگ'] = [];
          segments['بدون تگ'].push(contact);
        } else {
          tags.forEach((tag: string) => {
            if (!segments[tag]) segments[tag] = [];
            segments[tag].push(contact);
          });
        }
      });

      const result = Object.entries(segments).map(([tag, list]: [any, any]) => ({
        segment: tag,
        count: list.length,
        contacts: list
      }));

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/contacts/segments/by-source', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all();
      const segments: any = {};

      allContacts.forEach((contact: any) => {
        const source = contact.source || 'دستی';
        if (!segments[source]) segments[source] = [];
        segments[source].push(contact);
      });

      const result = Object.entries(segments).map(([source, list]: [any, any]) => ({
        segment: source,
        count: list.length,
        contacts: list
      }));

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/contacts/segments/by-date', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all();
      const segments: any = {
        'امروز': [],
        'دیروز': [],
        'این هفته': [],
        'این ماه': [],
        'قدیم‌تر': []
      };

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const monthAgo = new Date(today);
      monthAgo.setMonth(monthAgo.getMonth() - 1);

      allContacts.forEach((contact: any) => {
        const date = new Date(contact.createdAt);
        const contactDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        if (contactDate.getTime() === today.getTime()) {
          segments['امروز'].push(contact);
        } else if (contactDate.getTime() === yesterday.getTime()) {
          segments['دیروز'].push(contact);
        } else if (contactDate > weekAgo) {
          segments['این هفته'].push(contact);
        } else if (contactDate > monthAgo) {
          segments['این ماه'].push(contact);
        } else {
          segments['قدیم‌تر'].push(contact);
        }
      });

      const result = Object.entries(segments)
        .filter(([_, list]: [any, any]) => list.length > 0)
        .map(([period, list]: [any, any]) => ({
          segment: period,
          count: list.length,
          contacts: list
        }));

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Tasks Endpoints
  app.get('/api/contacts/tasks', (req, res) => {
    try {
      const tasks = db.select().from(contactTasks).all();
      const sorted = tasks.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(sorted);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/contacts/:id/tasks', (req, res) => {
    try {
      const { id } = req.params;
      const tasks = db.select().from(contactTasks)
        .where(eq(contactTasks.contactId, id))
        .all();
      const sorted = tasks.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(sorted);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/contacts/:id/tasks', (req, res) => {
    try {
      const { id } = req.params;
      const { title, description, priority, dueDate } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'عنوان تسک الزامی است' });
      }

      const task = {
        id: uuidv4(),
        contactId: id,
        title,
        description: description || null,
        priority: priority || 'medium',
        status: 'pending',
        dueDate: dueDate || null,
        createdAt: new Date().toISOString(),
        completedAt: null
      };

      db.insert(contactTasks).values(task).run();

      // فعالیت خودکار
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: id,
        action: 'تسک اضافه شد',
        description: `تسک «${title}» اضافه گردید`,
        details: priority !== 'medium' ? `اولویت: ${priority}` : null,
        type: 'task_added',
        activityData: null,
        createdAt: new Date().toISOString()
      }).run();

      res.json(task);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/contacts/:id/tasks/:taskId', (req, res) => {
    try {
      const { id, taskId } = req.params;
      const { title, description, priority, status, dueDate } = req.body;

      const updates: any = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (status !== undefined) {
        updates.status = status;
        if (status === 'completed') {
          updates.completedAt = new Date().toISOString();
        }
      }
      if (dueDate !== undefined) updates.dueDate = dueDate;

      db.update(contactTasks)
        .set(updates)
        .where(eq(contactTasks.id, taskId))
        .run();

      // فعالیت خودکار
      if (status === 'completed') {
        db.insert(contactActivities).values({
          id: uuidv4(),
          contactId: id,
          action: 'تسک تکمیل شد',
          description: `تسک «${title}» تکمیل گردید`,
          details: null,
          type: 'task_completed',
          activityData: null,
          createdAt: new Date().toISOString()
        }).run();
      }

      res.json({ status: 'updated' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/contacts/:id/tasks/:taskId', (req, res) => {
    try {
      const { id, taskId } = req.params;
      const task = db.select().from(contactTasks).where(eq(contactTasks.id, taskId)).all()[0];
      
      db.delete(contactTasks).where(eq(contactTasks.id, taskId)).run();

      // فعالیت خودکار
      if (task) {
        db.insert(contactActivities).values({
          id: uuidv4(),
          contactId: id,
          action: 'تسک حذف شد',
          description: `تسک «${task.title}» حذف گردید`,
          details: null,
          type: 'task_deleted',
          activityData: null,
          createdAt: new Date().toISOString()
        }).run();
      }

      res.json({ status: 'deleted' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Messages
  app.post('/api/uploads/campaign-media', campaignMediaUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'هیچ فایلی برای آپلود ارسال نشده است' });
      }

      const relativePath = path.join('uploads', 'campaign-media', req.file.filename).replace(/\\/g, '/');
      res.json({
        success: true,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mediaPath: relativePath,
        publicUrl: `/${relativePath}`,
        size: req.file.size,
        mimeType: req.file.mimetype,
      });
    } catch (error: any) {
      logger.error('Campaign media upload failed:', error);
      res.status(400).json({ error: error.message || 'آپلود فایل با خطا مواجه شد' });
    }
  });

  app.post('/api/messages/send', async (req, res) => {
    try {
      const { accountId, toPhone, text } = req.body;
      if (!accountId || !toPhone || !text) {
        return res.status(400).json({ error: 'Missing required fields: accountId, toPhone, text' });
      }
      
      const result = await sendMessage(accountId, toPhone, text);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/messages/send-media', async (req, res) => {
    try {
      const { accountId, toPhone, mediaPath, caption, fileName, mimeType, mediaType, ptt } = req.body;
      if (!accountId || !toPhone || !mediaPath) {
        return res.status(400).json({ error: 'Missing required fields: accountId, toPhone, mediaPath' });
      }

      const result = await sendMediaMessage(accountId, toPhone, {
        mediaPath,
        caption,
        fileName,
        mimeType,
        mediaType,
        ptt,
      });

      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Campaigns
  app.get('/api/campaigns', (req, res) => {
    const allCampaigns = db.select().from(campaigns).all();
    res.json(allCampaigns);
  });

  app.post('/api/campaigns', (req, res) => {
    const { 
      name, 
      accountIds, 
      contactIds, 
      segmentId,
      messageTemplate, 
      mediaPath,
      scheduleType,
      scheduledAt,
      maxPerHour,
      maxPerDay,
      delayMinMs,
      delayMaxMs
    } = req.body;
    const warnings = collectCampaignTextWarnings({ name, messageTemplate });
    const accountValidation = validateCampaignAccountSelection(accountIds);

    if (accountValidation.requestedAccountIds.length === 0) {
      return res.status(400).json({ error: 'Campaign must have at least one account selected' });
    }

    if (accountValidation.missingAccountIds.length > 0) {
      return res.status(400).json({
        error: `Some selected accounts no longer exist: ${accountValidation.missingAccountIds.join(', ')}`,
      });
    }

    const id = uuidv4();
    const resolvedContactIds = resolveCampaignRecipientIds(contactIds, segmentId);
    db.insert(campaigns).values({
      id,
      name,
      accountIds: JSON.stringify(accountValidation.requestedAccountIds),
      contactIds: JSON.stringify(resolvedContactIds),
      segmentId: segmentId || null,
      messageTemplate,
      mediaPath: mediaPath || null,
      scheduleType,
      scheduledAt: scheduledAt || null,
      maxPerHour: maxPerHour || null,
      maxPerDay: maxPerDay || null,
      delayMinMs: delayMinMs || null,
      delayMaxMs: delayMaxMs || null,
      status: 'draft',
      createdAt: new Date().toISOString()
    }).run();
    res.json({ id, warnings });
  });

  app.put('/api/campaigns/:id', (req, res) => {
    const { id } = req.params;
    const { 
      name, 
      accountIds, 
      contactIds, 
      segmentId,
      messageTemplate, 
      mediaPath,
      scheduleType,
      scheduledAt,
      maxPerHour,
      maxPerDay,
      delayMinMs,
      delayMaxMs
    } = req.body;
    
    const warnings = collectCampaignTextWarnings({ name, messageTemplate });
    const accountValidation = validateCampaignAccountSelection(accountIds);

    if (accountValidation.requestedAccountIds.length === 0) {
      return res.status(400).json({ error: 'Campaign must have at least one account selected' });
    }

    if (accountValidation.missingAccountIds.length > 0) {
      return res.status(400).json({
        error: `Some selected accounts no longer exist: ${accountValidation.missingAccountIds.join(', ')}`,
      });
    }

    const resolvedContactIds = resolveCampaignRecipientIds(contactIds, segmentId);

    db.update(campaigns)
      .set({
        name,
        accountIds: JSON.stringify(accountValidation.requestedAccountIds),
        contactIds: JSON.stringify(resolvedContactIds),
        segmentId: segmentId || null,
        messageTemplate,
        ...(mediaPath !== undefined ? { mediaPath } : {}),
        scheduleType,
        scheduledAt: scheduledAt || null,
        maxPerHour: maxPerHour || null,
        maxPerDay: maxPerDay || null,
        delayMinMs: delayMinMs || null,
        delayMaxMs: delayMaxMs || null
      })
      .where(eq(campaigns.id, id))
      .run();
    
    res.json({ status: 'updated', warnings });
  });

  app.delete('/api/campaigns/:id', (req, res) => {
    const { id } = req.params;
    db.delete(campaigns).where(eq(campaigns.id, id)).run();
    res.json({ status: 'deleted' });
  });

  // Execute a campaign (send messages to all recipients)
  app.post('/api/campaigns/execute/:id', (req, res) => {
    const { id } = req.params;
    
    try {
      // Fetch campaign
      const campaignArray = db.select()
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .all();

      if (campaignArray.length === 0) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      const campaign = campaignArray[0];

      // Validate campaign has at least one account
      const accountValidation = validateCampaignAccountSelection(campaign.accountIds);
      const accountIds = accountValidation.requestedAccountIds;

      if ((campaign.accountIds || '').trim().length > 0 && accountIds.length === 0) {
        return res.status(400).json({ error: 'Invalid accountIds in campaign' });
      }

      if (accountIds.length === 0) {
        return res.status(400).json({ error: 'Campaign must have at least one account selected' });
      }

      if (accountValidation.connectedAccounts.length === 0) {
        const disconnectedLabels = accountValidation.disconnectedAccounts.map(formatCampaignAccountLabel);
        const missingLabels = accountValidation.missingAccountIds;
        const details = [...missingLabels, ...disconnectedLabels].join(', ');
        return res.status(400).json({
          error: details
            ? `Campaign has no connected accounts available for execution. Review these accounts: ${details}`
            : 'Campaign has no connected accounts available for execution.',
        });
      }

      const connectedAccountIds = accountValidation.connectedAccounts.map((account: any) => account.id);
      const skippedAccountLabels = [
        ...accountValidation.missingAccountIds,
        ...accountValidation.disconnectedAccounts.map(formatCampaignAccountLabel),
      ];

      // Create a queue job for campaign execution
      const jobId = uuidv4();

      db.insert(queueJobs).values({
        id: jobId,
        type: 'campaign_execution',
        status: 'pending',
        priority: 1,
        payload: JSON.stringify({ campaignId: id, accountId: connectedAccountIds[0], accountIds: connectedAccountIds }),
        createdAt: new Date().toISOString()
      }).run();

      logger.info(`Campaign execution job created: ${jobId} for campaign ${id}`);

      if (skippedAccountLabels.length > 0) {
        appendCampaignEvent({
          campaignId: id,
          level: 'warn',
          eventType: 'account-selection-sanitized',
          message: `Execution skipped unavailable accounts: ${skippedAccountLabels.join(', ')}`,
          payload: {
            usedAccountIds: connectedAccountIds,
            skippedAccounts: skippedAccountLabels,
          },
        });
      }

      appendCampaignEvent({
        campaignId: id,
        level: 'info',
        eventType: 'queued',
        message: `Campaign queued for execution with ${connectedAccountIds.length} account(s).`,
        payload: { jobId, accountIds: connectedAccountIds },
      });

      res.json({ 
        status: 'queued',
        jobId,
        message: skippedAccountLabels.length > 0
          ? `Campaign queued with ${connectedAccountIds.length} connected account(s). Unavailable accounts were skipped: ${skippedAccountLabels.join(', ')}`
          : `Campaign queued for execution. ${connectedAccountIds.length} account(s) will be used.`,
        warnings: skippedAccountLabels.length > 0
          ? [`Skipped unavailable accounts: ${skippedAccountLabels.join(', ')}`]
          : []
      });

    } catch (error: any) {
      logger.error('Error executing campaign:', error);
      res.status(500).json({ error: error.message || 'Failed to execute campaign' });
    }
  });

  app.post('/api/campaigns/:id/pause', (req, res) => {
    const { id } = req.params;

    try {
      const campaign = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      if (!['queued', 'in-progress'].includes(campaign.status || '')) {
        return res.status(400).json({ error: 'Only queued or in-progress campaigns can be paused' });
      }

      db.update(campaigns)
        .set({ status: 'paused' })
        .where(eq(campaigns.id, id))
        .run();

      const relatedJobs = db.select().from(queueJobs).all().filter((job: any) => {
        if (job.type !== 'campaign_execution' || !job.payload) {
          return false;
        }

        try {
          const payload = JSON.parse(job.payload);
          return payload?.campaignId === id;
        } catch {
          return false;
        }
      });

      relatedJobs
        .filter((job: any) => ['pending', 'retry'].includes(job.status))
        .forEach((job: any) => {
          db.update(queueJobs)
            .set({
              status: 'cancelled',
              completedAt: new Date().toISOString(),
              errorMessage: 'Paused by user before execution started',
            })
            .where(eq(queueJobs.id, job.id))
            .run();
        });

      appendCampaignEvent({
        campaignId: id,
        level: 'warn',
        eventType: 'paused-by-user',
        message: 'Campaign paused by user request.',
        payload: { affectedJobs: relatedJobs.map((job: any) => ({ id: job.id, status: job.status })) },
      });

      res.json({ status: 'paused', message: 'Campaign paused successfully' });
    } catch (error: any) {
      logger.error('Error pausing campaign:', error);
      res.status(500).json({ error: error.message || 'Failed to pause campaign' });
    }
  });

  app.post('/api/campaigns/:id/resume', (req, res) => {
    const { id } = req.params;

    try {
      const campaign = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      if (campaign.status !== 'paused') {
        return res.status(400).json({ error: 'Only paused campaigns can be resumed' });
      }

      const accountValidation = validateCampaignAccountSelection(campaign.accountIds);
      const accountIds = accountValidation.requestedAccountIds;

      if (accountIds.length === 0) {
        return res.status(400).json({ error: 'Campaign must have at least one account selected' });
      }

      if (accountValidation.connectedAccounts.length === 0) {
        const disconnectedLabels = accountValidation.disconnectedAccounts.map(formatCampaignAccountLabel);
        const missingLabels = accountValidation.missingAccountIds;
        const details = [...missingLabels, ...disconnectedLabels].join(', ');
        return res.status(400).json({
          error: details
            ? `Campaign has no connected accounts available for execution. Review these accounts: ${details}`
            : 'Campaign has no connected accounts available for execution.',
        });
      }

      const connectedAccountIds = accountValidation.connectedAccounts.map((account: any) => account.id);
      const skippedAccountLabels = [
        ...accountValidation.missingAccountIds,
        ...accountValidation.disconnectedAccounts.map(formatCampaignAccountLabel),
      ];

      const jobId = uuidv4();

      db.insert(queueJobs).values({
        id: jobId,
        type: 'campaign_execution',
        status: 'pending',
        priority: 1,
        payload: JSON.stringify({ campaignId: id, accountId: connectedAccountIds[0], accountIds: connectedAccountIds }),
        createdAt: new Date().toISOString()
      }).run();

      db.update(campaigns)
        .set({
          status: 'queued',
          completedAt: null,
        })
        .where(eq(campaigns.id, id))
        .run();

      if (skippedAccountLabels.length > 0) {
        appendCampaignEvent({
          campaignId: id,
          level: 'warn',
          eventType: 'account-selection-sanitized',
          message: `Resume skipped unavailable accounts: ${skippedAccountLabels.join(', ')}`,
          payload: {
            usedAccountIds: connectedAccountIds,
            skippedAccounts: skippedAccountLabels,
          },
        });
      }

      appendCampaignEvent({
        campaignId: id,
        level: 'info',
        eventType: 'resumed',
        message: 'Campaign resumed and queued again.',
        payload: { jobId, accountIds: connectedAccountIds },
      });

      res.json({
        status: 'queued',
        jobId,
        message: skippedAccountLabels.length > 0
          ? `Campaign resumed with ${connectedAccountIds.length} connected account(s). Unavailable accounts were skipped: ${skippedAccountLabels.join(', ')}`
          : 'Campaign resumed successfully',
        warnings: skippedAccountLabels.length > 0
          ? [`Skipped unavailable accounts: ${skippedAccountLabels.join(', ')}`]
          : []
      });
    } catch (error: any) {
      logger.error('Error resuming campaign:', error);
      res.status(500).json({ error: error.message || 'Failed to resume campaign' });
    }
  });

  // Get campaign execution status
  app.get('/api/campaigns/:id/status', (req, res) => {
    const { id } = req.params;

    try {
      const snapshot = getCampaignExecutionSnapshot(id);

      if (!snapshot) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      res.json(snapshot);

    } catch (error: any) {
      logger.error('Error getting campaign status:', error);
      res.status(500).json({ error: error.message || 'Failed to get campaign status' });
    }
  });

  // AI Hub - API Keys Management
  app.get('/api/ai/providers', (req, res) => {
    try {
      const providers = [
        { value: 'openai', label: 'OpenAI', models: ['gpt-4', 'gpt-3.5-turbo', 'gpt-4-turbo'] },
        { value: 'gemini', label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
        { value: 'claude', label: 'Anthropic Claude', models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'] }
      ];
      res.status(200).json(providers);
    } catch (error: any) {
      logger.error('Error fetching AI providers:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/keys', (req, res) => {
    try {
      const keys = db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all();
      const safeKeys = keys.map((k: any) => ({
        ...k,
        apiKey: maskSecret(k.apiKey)
      }));
      res.status(200).json(safeKeys);
    } catch (error: any) {
      logger.error('Error fetching API keys:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/keys', (req, res) => {
    try {
      const { provider, apiKey, modelName, isActive } = req.body;

      if (!provider || !apiKey || !modelName) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const id = 'key_' + uuidv4();

      // Remove existing key for this provider first
      db.delete(apiKeys).where(eq(apiKeys.provider, provider)).run();

      db.insert(apiKeys).values({
        id,
        provider,
        apiKey: encryptSecret(apiKey),
        modelName,
        isActive: isActive ? 1 : 0,
        createdAt: new Date().toISOString()
      }).run();

      res.status(201).json({
        id,
        message: 'API key saved successfully'
      });
    } catch (error: any) {
      logger.error('Error saving API key:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/ai/keys/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { isActive, modelName } = req.body;

      const updateData: any = {};
      if ('isActive' in req.body) {
        updateData.isActive = isActive ? 1 : 0;
      }
      if (modelName) {
        updateData.modelName = modelName;
      }

      db.update(apiKeys).set(updateData).where(eq(apiKeys.id, id)).run();

      res.status(200).json({ message: 'API key updated successfully' });
    } catch (error: any) {
      logger.error('Error updating API key:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/ai/keys/:id', (req, res) => {
    try {
      const { id } = req.params;

      db.delete(apiKeys).where(eq(apiKeys.id, id)).run();

      res.status(200).json({ message: 'API key deleted successfully' });
    } catch (error: any) {
      logger.error('Error deleting API key:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/test-prompt', async (req, res) => {
    try {
      const { provider, model, prompt, systemPrompt } = req.body;

      if (!provider || !model || !prompt) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Get API key for provider
      const apiKeyRecord = db.select().from(apiKeys).where(eq(apiKeys.provider, provider)).get();

      if (!apiKeyRecord || !apiKeyRecord.apiKey) {
        return res.status(400).json({ error: `No API key configured for ${provider}` });
      }

      const decryptedApiKey = decryptSecret(apiKeyRecord.apiKey);

      let response = '';

      if (provider === 'openai') {
        const result = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${decryptedApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt || 'You are a helpful assistant' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 500
          })
        });

        if (!result.ok) {
          const error = await result.json();
          return res.status(400).json({ error: error.error?.message || 'OpenAI API error' });
        }

        const data = await result.json();
        response = data.choices?.[0]?.message?.content || '';
      } else if (provider === 'gemini') {
        const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${decryptedApiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        });

        if (!result.ok) {
          return res.status(400).json({ error: 'Gemini API error' });
        }

        const data = await result.json();
        response = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } else if (provider === 'claude') {
        const result = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': decryptedApiKey,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: 500,
            system: systemPrompt || 'You are a helpful assistant',
            messages: [{ role: 'user', content: prompt }]
          })
        });

        if (!result.ok) {
          return res.status(400).json({ error: 'Claude API error' });
        }
        const data = await result.json();
        response = data.content?.[0]?.text || '';
      }

      res.status(200).json({ response });
    } catch (error: any) {
      logger.error('Error testing prompt:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/overview', (req, res) => {
    try {
      res.status(200).json(getAiControlOverview());
    } catch (error: any) {
      logger.error('Error fetching AI control overview:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/lead-scoring/overview', (req, res) => {
    try {
      res.status(200).json(getLeadScoringOverview());
    } catch (error: any) {
      logger.error('Error fetching lead scoring overview:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/lead-scoring/contacts', (req, res) => {
    try {
      const { stage, nextBestAction, minScore, limit } = req.query;
      const results = listLeadScorecards({
        stage: typeof stage === 'string' ? stage : undefined,
        nextBestAction: typeof nextBestAction === 'string' ? nextBestAction : undefined,
        minScore: typeof minScore === 'string' ? Number(minScore) : undefined,
        limit: typeof limit === 'string' ? Number(limit) : 25,
      });

      res.status(200).json(results);
    } catch (error: any) {
      logger.error('Error listing lead scorecards:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/lead-scoring/contact/:contactId', (req, res) => {
    try {
      const result = getContactLeadScorecard(req.params.contactId);
      if (!result) {
        return res.status(404).json({ error: 'Contact not found' });
      }

      res.status(200).json(result);
    } catch (error: any) {
      logger.error('Error fetching contact lead scorecard:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/marketing-strategist/overview', (req, res) => {
    try {
      res.status(200).json(buildMarketingStrategistOverview());
    } catch (error: any) {
      logger.error('Error fetching marketing strategist overview:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/marketing-strategist/strategy', (req, res) => {
    try {
      res.status(200).json(buildMarketingStrategy(req.body || {}));
    } catch (error: any) {
      logger.error('Error building marketing strategy:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/marketing-strategist/to-segment', (req, res) => {
    try {
      res.status(200).json(buildStrategySegmentRecommendation(req.body || {}));
    } catch (error: any) {
      logger.error('Error building strategy segment recommendation:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/marketing-strategist/to-campaign', (req, res) => {
    try {
      res.status(200).json(buildStrategyCampaignDraft(req.body || {}));
    } catch (error: any) {
      logger.error('Error building strategy campaign draft:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/analytics-optimizer/overview', (req, res) => {
    try {
      res.status(200).json(buildAnalyticsOptimizerOverview({
        range: typeof req.query.range === 'string' ? req.query.range : undefined,
      }));
    } catch (error: any) {
      logger.error('Error fetching analytics optimizer overview:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/analytics-optimizer/recommend', (req, res) => {
    try {
      res.status(200).json(buildAnalyticsOptimizerRecommendations(req.body || {}));
    } catch (error: any) {
      logger.error('Error building analytics optimizer recommendations:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/governance/overview', (req, res) => {
    try {
      res.status(200).json(getAiGovernanceOverview());
    } catch (error: any) {
      logger.error('Error fetching AI governance overview:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/governance/logs', (req, res) => {
    try {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      res.status(200).json(listAiGovernanceLogs(limit));
    } catch (error: any) {
      logger.error('Error fetching AI governance logs:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/governance/preview', (req, res) => {
    try {
      const { type, params } = req.body || {};
      res.status(200).json(previewAiGovernance({ type: String(type || ''), params: params || {} }));
    } catch (error: any) {
      logger.error('Error previewing AI governance action:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/ai/control/actions', (req, res) => {
    try {
      res.status(200).json(getAiActionCatalog());
    } catch (error: any) {
      logger.error('Error fetching AI control actions:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/action', async (req, res) => {
    try {
      const { type, params } = req.body || {};

      if (!type) {
        return res.status(400).json({ error: 'Action type is required' });
      }

      const result = await executeAiControlAction({ type, params });
      res.status(result.success ? 200 : 400).json(result);
    } catch (error: any) {
      logger.error('Error executing direct AI control action:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/ai/control/execute', async (req, res) => {
    try {
      const { provider, model, instruction, maxActions } = req.body || {};

      if (!provider || !model || !instruction) {
        return res.status(400).json({ error: 'provider, model and instruction are required' });
      }

      const result = await executeAiControlInstruction({
        provider,
        model,
        instruction,
        maxActions,
      });

      res.status(200).json(result);
    } catch (error: any) {
      logger.error('Error executing AI control instruction:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Settings - Rate Limiting
  app.get('/api/settings/rate-limit/:accountId', (req, res) => {
    const { accountId } = req.params;
    const { rateLimiter } = require('./modules/whatsapp/rate-limiter');
    const config = rateLimiter.getAccountDelayConfig(accountId);
    res.json(config);
  });

  app.post('/api/settings/rate-limit/:accountId', (req, res) => {
    const { accountId } = req.params;
    const { minMs, maxMs, enabled } = req.body;
    const { rateLimiter } = require('./modules/whatsapp/rate-limiter');
    
    if (typeof minMs !== 'number' || typeof maxMs !== 'number') {
      return res.status(400).json({ error: 'minMs and maxMs must be numbers' });
    }
    
    rateLimiter.setAccountDelayConfig(accountId, { minMs, maxMs, enabled: enabled !== false });
    res.json({ status: 'updated', config: { minMs, maxMs, enabled } });
  });

  app.get('/api/settings/rate-limit/:accountId/stats', (req, res) => {
    const { accountId } = req.params;
    const { rateLimiter } = require('./modules/whatsapp/rate-limiter');
    const stats = rateLimiter.getAccountStats(accountId);
    res.json(stats);
  });

  app.get('/api/settings/backup', (req, res) => {
    try {
      const { rateLimiter } = require('./modules/whatsapp/rate-limiter');
      const accountSettings = db.select().from(whatsappAccounts).all().map((account: any) => ({
        id: account.id,
        displayName: account.displayName,
        phoneNumber: account.phoneNumber,
        proxyProfileId: account.proxyProfileId,
        warmUpProfileId: account.warmUpProfileId,
        tags: account.tags,
        status: account.status,
        createdAt: account.createdAt,
      }));

      const backup = {
        exportVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        settings: {
          accounts: accountSettings,
          rateLimits: accountSettings.map((account: any) => ({
            accountId: account.id,
            ...rateLimiter.getAccountDelayConfig(account.id),
          })),
          proxyProfiles: db.select().from(proxyProfiles).all(),
          aiProviders: db.select().from(aiProviders).all(),
          apiKeys: db.select().from(apiKeys).all(),
          autoReplyRules: db.select().from(autoReplyRules).all(),
          warmUpProfiles: db.select().from(warmUpProfiles).all(),
        },
      };

      res.json(backup);
    } catch (error: any) {
      logger.error('Error exporting settings backup:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/settings/restore', (req, res) => {
    try {
      const { backup } = req.body;

      if (!backup?.settings) {
        return res.status(400).json({ error: 'Invalid backup payload' });
      }

      const { rateLimiter } = require('./modules/whatsapp/rate-limiter');
      const settings = backup.settings;

      if (Array.isArray(settings.accounts)) {
        for (const account of settings.accounts) {
          const existingAccount = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, account.id)).get();

          const accountPayload = {
            phoneNumber: account.phoneNumber || null,
            displayName: account.displayName || null,
            proxyProfileId: account.proxyProfileId || null,
            warmUpProfileId: account.warmUpProfileId || null,
            tags: account.tags || null,
            status: account.status || 'disconnected',
            createdAt: account.createdAt || new Date().toISOString(),
          };

          if (existingAccount) {
            db.update(whatsappAccounts)
              .set(accountPayload)
              .where(eq(whatsappAccounts.id, account.id))
              .run();
          } else {
            db.insert(whatsappAccounts)
              .values({
                id: account.id,
                ...accountPayload,
              })
              .run();
          }
        }
      }

      if (Array.isArray(settings.rateLimits)) {
        for (const config of settings.rateLimits) {
          if (!config?.accountId) continue;

          rateLimiter.setAccountDelayConfig(config.accountId, {
            minMs: Number(config.minMs) || 1000,
            maxMs: Number(config.maxMs) || 5000,
            enabled: config.enabled !== false,
          });
        }
      }

      if (Array.isArray(settings.proxyProfiles)) {
        db.delete(proxyProfiles).run();
        if (settings.proxyProfiles.length > 0) {
          db.insert(proxyProfiles).values(settings.proxyProfiles).run();
        }
      }

      if (Array.isArray(settings.aiProviders)) {
        db.delete(aiProviders).run();
        if (settings.aiProviders.length > 0) {
          db.insert(aiProviders).values(settings.aiProviders).run();
        }
      }

      if (Array.isArray(settings.apiKeys)) {
        db.delete(apiKeys).run();
        if (settings.apiKeys.length > 0) {
          db.insert(apiKeys).values(settings.apiKeys).run();
        }
      }

      if (Array.isArray(settings.autoReplyRules)) {
        db.delete(autoReplyRules).run();
        if (settings.autoReplyRules.length > 0) {
          db.insert(autoReplyRules).values(settings.autoReplyRules).run();
        }
      }

      if (Array.isArray(settings.warmUpProfiles)) {
        db.delete(warmUpProfiles).run();
        if (settings.warmUpProfiles.length > 0) {
          db.insert(warmUpProfiles).values(settings.warmUpProfiles).run();
        }
      }

      res.json({
        success: true,
        message: 'Settings restored successfully',
        restored: {
          accounts: settings.accounts?.length || 0,
          rateLimits: settings.rateLimits?.length || 0,
          proxyProfiles: settings.proxyProfiles?.length || 0,
          aiProviders: settings.aiProviders?.length || 0,
          apiKeys: settings.apiKeys?.length || 0,
          autoReplyRules: settings.autoReplyRules?.length || 0,
          warmUpProfiles: settings.warmUpProfiles?.length || 0,
        },
      });
    } catch (error: any) {
      logger.error('Error restoring settings backup:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Analytics
  app.get('/api/analytics/overview', (req, res) => {
    try {
      const totalAccounts = db.select({ count: count() }).from(whatsappAccounts).all()[0].count;
      const totalContacts = db.select({ count: count() }).from(contacts).all()[0].count;
      const totalCampaigns = db.select({ count: count() }).from(campaigns).all()[0].count;
      
      // Get today's messages
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
      const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
      
      const allMessages = db.select().from(messageLogs).all();
      const messagesToday = allMessages.filter((m: any) => {
        const mDate = m.createdAt ? new Date(m.createdAt).toISOString() : '';
        return mDate >= todayStart && mDate < todayEnd;
      }).length;
      
      // Get recent activity
      const allActivities = db.select().from(contactActivities).all();
      const recentActivity = allActivities
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);
      
      // Get chart data (messages per day for last 7 days)
      const chartData = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
        const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).toISOString();
        
        const dayMessages = allMessages.filter((m: any) => {
          const mDate = m.createdAt ? new Date(m.createdAt).toISOString() : '';
          return mDate >= dayStart && mDate < dayEnd;
        }).length;
        
        chartData.push({
          date: date.toLocaleDateString('fa-IR'),
          messages: dayMessages
        });
      }
      
      res.json({
        accounts: totalAccounts,
        contacts: totalContacts,
        campaigns: totalCampaigns,
        messagesToday,
        recentActivity: recentActivity.map((a: any) => ({
          id: a.id,
          contactId: a.contactId,
          action: a.action,
          description: a.description,
          createdAt: a.createdAt
        })),
        chartData
      });
    } catch (error: any) {
      logger.error('Analytics overview error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Network
  app.get('/api/network/status', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      res.json(getOperationalHealthOverview(range));
    } catch (error: any) {
      logger.error('Error fetching network status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Queue
  app.get('/api/queue/status', (req, res) => {
    const pending = db.select({ count: count() }).from(queueJobs).where(eq(queueJobs.status, 'pending')).all()[0].count;
    const processing = db.select({ count: count() }).from(queueJobs).where(eq(queueJobs.status, 'processing')).all()[0].count;
    const done = db.select({ count: count() }).from(queueJobs).where(eq(queueJobs.status, 'done')).all()[0].count;
    
    res.json({ pending, processing, done });
  });

  // Number Validator Endpoints
  app.post('/api/validator/validate', (req, res) => {
    try {
      const { phoneNumber, countryCode } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
      }
      const result = validatePhoneNumber(phoneNumber, countryCode);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/validator/validate-bulk', (req, res) => {
    try {
      const { phoneNumbers, countryCode } = req.body;
      if (!Array.isArray(phoneNumbers)) {
        return res.status(400).json({ error: 'Phone numbers must be an array' });
      }
      const results = validatePhoneNumbers(phoneNumbers, countryCode);
      const stats = {
        total: results.length,
        valid: results.filter(r => r.isValid).length,
        invalid: results.filter(r => !r.isValid).length,
        results: results
      };
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/validator/filter-valid', (req, res) => {
    try {
      const { phoneNumbers, countryCode } = req.body;
      if (!Array.isArray(phoneNumbers)) {
        return res.status(400).json({ error: 'Phone numbers must be an array' });
      }
      const validNumbers = filterValidPhoneNumbers(phoneNumbers, countryCode);
      res.json({ count: validNumbers.length, phoneNumbers: validNumbers });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/validator/check-whatsapp', (req, res) => {
    try {
      const { phoneNumber, countryCode } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
      }
      const isEligible = isWhatsAppEligible(phoneNumber, countryCode);
      res.json({ phoneNumber, isWhatsAppEligible: isEligible });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/validator/filter-whatsapp', (req, res) => {
    try {
      const { phoneNumbers, countryCode } = req.body;
      if (!Array.isArray(phoneNumbers)) {
        return res.status(400).json({ error: 'Phone numbers must be an array' });
      }
      const whatsappNumbers = filterWhatsAppEligible(phoneNumbers, countryCode);
      res.json({ count: whatsappNumbers.length, phoneNumbers: whatsappNumbers });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Message Personalization Endpoints
  app.post('/api/personalizer/personalize', (req, res) => {
    try {
      const { message, contact } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message template is required' });
      }
      if (!contact || typeof contact !== 'object') {
        return res.status(400).json({ error: 'Contact object is required' });
      }
      const result = personalizeMessage(message, contact);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/personalizer/personalize-bulk', (req, res) => {
    try {
      const { message, contacts } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message template is required' });
      }
      if (!Array.isArray(contacts)) {
        return res.status(400).json({ error: 'Contacts must be an array' });
      }
      const results = personalizeMessages(message, contacts);
      res.json({
        template: message,
        totalContacts: contacts.length,
        results: results,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/personalizer/extract-variables', (req, res) => {
    try {
      const { message } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }
      const variables = extractVariables(message);
      res.json({
        message,
        variables,
        count: variables.length,
        suggestions: COMMON_VARIABLES,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/personalizer/analyze-template', (req, res) => {
    try {
      const { message, contacts } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const analysis = analyzeMessageTemplate(message, Array.isArray(contacts) ? contacts : []);
      res.json(analysis);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/personalizer/preview', (req, res) => {
    try {
      const { message } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }
      const preview = previewMessage(message);
      res.json({ original: message, preview });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/personalizer/check-missing', (req, res) => {
    try {
      const { message, contact } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }
      if (!contact || typeof contact !== 'object') {
        return res.status(400).json({ error: 'Contact object is required' });
      }
      const missing = getMissingVariables(message, contact);
      res.json({
        totalVariables: extractVariables(message).length,
        missingVariables: missing,
        hasMissing: missing.length > 0,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // CSV Import/Export Endpoints
  app.post('/api/csv/parse', (req, res) => {
    try {
      const { csvContent } = req.body;
      if (!csvContent) {
        return res.status(400).json({ error: 'CSV content is required' });
      }
      const result = parseCSVString(csvContent);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/csv/import-contacts', (req, res) => {
    try {
      const { csvContent } = req.body;
      if (!csvContent) {
        return res.status(400).json({ error: 'CSV content is required' });
      }
      const result = parseContactsFromCSV(csvContent);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/csv/import-campaigns', (req, res) => {
    try {
      const { csvContent } = req.body;
      if (!csvContent) {
        return res.status(400).json({ error: 'CSV content is required' });
      }
      const result = parseCampaignsFromCSV(csvContent);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/csv/export-contacts', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all();
      const csv = convertToCSV(
        allContacts.map(c => ({
          name: c.fullName || '',
          phone: c.phone || '',
          email: c.email || '',
          country: c.country || '',
          city: c.city || '',
          tags: c.tags ? (Array.isArray(c.tags) ? c.tags.join(';') : c.tags) : '',
        }))
      );
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
      res.send(csv);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/csv/export-campaigns', (req, res) => {
    try {
      const allCampaigns = db.select().from(campaigns).all();
      const csv = convertToCSV(
        allCampaigns.map(c => ({
          id: c.id,
          name: c.name || '',
          messageTemplate: c.messageTemplate || '',
          status: c.status || 'draft',
          createdAt: c.createdAt || new Date().toISOString(),
        }))
      );
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="campaigns.csv"');
      res.send(csv);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/csv/template/contacts', (req, res) => {
    try {
      const template = getContactCSVTemplate();
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="contacts_template.csv"');
      res.send(template);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/csv/template/campaigns', (req, res) => {
    try {
      const template = getCampaignCSVTemplate();
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="campaigns_template.csv"');
      res.send(template);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Contact Segmentation Endpoints
  app.post('/api/segments/by-tag', (req, res) => {
    try {
      const { tag } = req.body;
      if (!tag) {
        return res.status(400).json({ error: 'Tag is required' });
      }
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const segment = segmentByTag(allContacts, tag);
      res.json(segment);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/segments/by-company', (req, res) => {
    try {
      const { company } = req.body;
      if (!company) {
        return res.status(400).json({ error: 'Company is required' });
      }
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const segment = segmentByCompany(allContacts, company);
      res.json(segment);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/segments/by-country', (req, res) => {
    try {
      const { countryCode } = req.body;
      if (!countryCode) {
        return res.status(400).json({ error: 'Country code is required' });
      }
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const segment = segmentByCountry(allContacts, countryCode);
      res.json(segment);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/segments/by-activity', (req, res) => {
    try {
      const { type } = req.body;
      if (!type || !['active', 'inactive', 'highValue', 'lowValue'].includes(type)) {
        return res.status(400).json({ error: 'Valid activity type is required (active, inactive, highValue, lowValue)' });
      }
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const segment = segmentByActivity(allContacts, type);
      res.json(segment);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/segments/split', (req, res) => {
    try {
      const { count } = req.body;
      if (!count || count < 1) {
        return res.status(400).json({ error: 'Valid count is required' });
      }
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const segments = splitIntoSegments(allContacts, count);
      res.json({
        totalSegments: segments.length,
        segments: segments.map(s => ({
          id: s.id,
          name: s.name,
          count: s.count,
          description: s.description,
        })),
        details: segments,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/segments/stats/:segmentId', (req, res) => {
    try {
      const { segmentId } = req.params;
      // In a real scenario, you'd retrieve the segment
      // For now, return suggestion stats
      res.json({ message: 'Segment stats endpoint' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/segments/suggestions', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const suggestions = getSuggestedSegments(allContacts);
      res.json({
        totalContacts: allContacts.length,
        suggestions,
        count: suggestions.length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/segments/analyze', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const stats = {
        totalContacts: allContacts.length,
        byActivity: {
          active: segmentByActivity(allContacts, 'active').count,
          inactive: segmentByActivity(allContacts, 'inactive').count,
          highValue: segmentByActivity(allContacts, 'highValue').count,
          lowValue: segmentByActivity(allContacts, 'lowValue').count,
        },
        withEmail: allContacts.filter(c => c.email).length,
        withTags: allContacts.filter(c => c.tags).length,
        withCompany: allContacts.filter(c => c.company).length,
        suggestions: getSuggestedSegments(allContacts).slice(0, 5),
      };
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Contact Deduplication Endpoints
  app.post('/api/dedup/find-all', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const result = findAllDuplicates(allContacts);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/dedup/find-by-phone', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const groups = findDuplicatesByPhone(allContacts);
      res.json({ groups, count: groups.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/dedup/find-by-email', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all() as ContactData[];
      const groups = findDuplicatesByEmail(allContacts);
      res.json({ groups, count: groups.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Template Management Endpoints
  app.post('/api/templates/create', (req, res) => {
    try {
      const { name, description, content, category, tags } = req.body;
      if (!name || !content || !category) {
        return res.status(400).json({ error: 'Name, content, and category are required' });
      }
      const template = createTemplate({
        name, description: description || '', content, category, tags: tags || []
      });
      res.json(template);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/templates', (req, res) => {
    try {
      const templates = getAllTemplates();
      res.json({ total: templates.length, templates });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/templates/:id', (req, res) => {
    try {
      const { id } = req.params;
      const template = getTemplate(id);
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json(template);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/templates/category/:category', (req, res) => {
    try {
      const { category } = req.params;
      const templates = getTemplatesByCategory(category);
      res.json({ total: templates.length, category, templates });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/templates/search/:query', (req, res) => {
    try {
      const { query } = req.params;
      const templates = searchTemplates(query);
      res.json({ total: templates.length, query, templates });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/templates/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, content, category, tags } = req.body;
      const updated = updateTemplate(id, {
        name, description, content, category, tags
      });
      if (!updated) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    try {
      const { id } = req.params;
      const deleted = deleteTemplate(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json({ success: true, id });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/templates/stats/overview', (req, res) => {
    try {
      initializeDefaultTemplates();
      const stats = getTemplateStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Message Scheduling Endpoints
  app.post('/api/schedule/message', (req, res) => {
    try {
      const { accountId, recipientPhone, message, scheduledTime } = req.body;
      if (!accountId || !recipientPhone || !message || !scheduledTime) {
        return res.status(400).json({ error: 'All fields are required' });
      }
      const scheduled = scheduleMessage(accountId, recipientPhone, message, new Date(scheduledTime));
      res.json(scheduled);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/schedule/pending', (req, res) => {
    try {
      const pending = getPendingMessages();
      res.json({ count: pending.length, messages: pending });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/schedule/account/:accountId', (req, res) => {
    try {
      const { accountId } = req.params;
      const messages = getMessagesByAccount(accountId);
      res.json({ count: messages.length, messages });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/schedule/upcoming/:accountId', (req, res) => {
    try {
      const { accountId } = req.params;
      const { hours = 24 } = req.query;
      const messages = getUpcomingMessages(accountId, parseInt(String(hours)));
      res.json({ count: messages.length, hours: parseInt(String(hours)), messages });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/schedule/:id/cancel', (req, res) => {
    try {
      const { id } = req.params;
      const cancelled = cancelMessage(id);
      if (!cancelled) {
        return res.status(404).json({ error: 'Message not found' });
      }
      res.json(cancelled);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/schedule/:id/reschedule', (req, res) => {
    try {
      const { id } = req.params;
      const { scheduledTime } = req.body;
      if (!scheduledTime) {
        return res.status(400).json({ error: 'Scheduled time is required' });
      }
      const rescheduled = rescheduleMessage(id, new Date(scheduledTime));
      if (!rescheduled) {
        return res.status(404).json({ error: 'Message not found' });
      }
      res.json(rescheduled);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/schedule/stats', (req, res) => {
    try {
      const stats = getSchedulingStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/schedule/batch', (req, res) => {
    try {
      const { accountId, recipients, scheduledTime } = req.body;
      if (!accountId || !Array.isArray(recipients) || !scheduledTime) {
        return res.status(400).json({ error: 'All fields are required' });
      }
      const scheduled = batchScheduleMessages(accountId, recipients, new Date(scheduledTime));
      res.json({ count: scheduled.length, messages: scheduled });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Account Settings Endpoints
  app.get('/api/accounts/:id/settings', (req, res) => {
    try {
      const { id } = req.params;
      const account = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).get();
      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }
      
      const settings = {
        id: account.id,
        displayName: account.displayName,
        phoneNumber: account.phoneNumber,
        status: account.status,
        proxyProfileId: account.proxyProfileId || null,
        warmUpProfileId: account.warmUpProfileId || null,
        createdAt: account.createdAt,
        lastActive: account.lastActive
      };
      
      res.json(settings);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/accounts/:id/settings', (req, res) => {
    try {
      const { id } = req.params;
      const { displayName, warmUpProfileId, proxyProfileId } = req.body;
      
      db.update(whatsappAccounts)
        .set({ 
          displayName: displayName || undefined,
          ...(warmUpProfileId !== undefined ? { warmUpProfileId: warmUpProfileId || null } : {}),
          ...(proxyProfileId !== undefined ? { proxyProfileId: proxyProfileId || null } : {})
        })
        .where(eq(whatsappAccounts.id, id))
        .run();
      
      const updatedAccount = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).get();
      res.json(updatedAccount);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Warm-Up Profiles Endpoints
  app.get('/api/warm-up/profiles', (req, res) => {
    try {
      const profiles = db.select().from(warmUpProfiles).all();
      res.json(profiles);
    } catch (error: any) {
      logger.error('Error fetching warm-up profiles:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/warm-up/profiles', (req, res) => {
    try {
      const { name, totalDays, dailyPlan, currentDay, status } = req.body;
      if (!name || !dailyPlan) {
        return res.status(400).json({ error: 'name and dailyPlan are required' });
      }

      const id = uuidv4();
      db.insert(warmUpProfiles).values({
        id,
        name,
        totalDays: totalDays || null,
        dailyPlan: typeof dailyPlan === 'string' ? dailyPlan : JSON.stringify(dailyPlan),
        currentDay: currentDay || 1,
        status: status || 'active',
        createdAt: new Date().toISOString(),
      }).run();

      res.status(201).json({ id, message: 'Warm-up profile created successfully' });
    } catch (error: any) {
      logger.error('Error creating warm-up profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/warm-up/profiles/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { name, totalDays, dailyPlan, currentDay, status } = req.body;

      db.update(warmUpProfiles)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(totalDays !== undefined ? { totalDays } : {}),
          ...(dailyPlan !== undefined ? { dailyPlan: typeof dailyPlan === 'string' ? dailyPlan : JSON.stringify(dailyPlan) } : {}),
          ...(currentDay !== undefined ? { currentDay } : {}),
          ...(status !== undefined ? { status } : {}),
        })
        .where(eq(warmUpProfiles.id, id))
        .run();

      res.json({ message: 'Warm-up profile updated successfully' });
    } catch (error: any) {
      logger.error('Error updating warm-up profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/warm-up/profiles/:id', (req, res) => {
    try {
      const { id } = req.params;
      db.delete(warmUpProfiles).where(eq(warmUpProfiles.id, id)).run();
      res.json({ message: 'Warm-up profile deleted successfully' });
    } catch (error: any) {
      logger.error('Error deleting warm-up profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/accounts/:id/warm-up-profile', (req, res) => {
    try {
      const { id } = req.params;
      const { warmUpProfileId } = req.body;

      db.update(whatsappAccounts)
        .set({ warmUpProfileId: warmUpProfileId || null })
        .where(eq(whatsappAccounts.id, id))
        .run();

      res.json({ message: 'Warm-up profile assigned successfully', warmUpProfileId: warmUpProfileId || null });
    } catch (error: any) {
      logger.error('Error assigning warm-up profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/accounts/:id/proxy-profile', (req, res) => {
    try {
      const { id } = req.params;
      const { proxyProfileId } = req.body;

      db.update(whatsappAccounts)
        .set({ proxyProfileId: proxyProfileId || null })
        .where(eq(whatsappAccounts.id, id))
        .run();

      res.json({ message: 'Proxy profile assigned successfully', proxyProfileId: proxyProfileId || null });
    } catch (error: any) {
      logger.error('Error assigning proxy profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Activity Log Endpoints
  app.get('/api/accounts/:id/activity', (req, res) => {
    try {
      const { id } = req.params;
      const { limit = 50, offset = 0 } = req.query;
      
      const logs = db.select().from(messageLogs)
        .where(eq(messageLogs.whatsappAccountId, id))
        .orderBy(desc(messageLogs.createdAt))
        .limit(parseInt(String(limit)))
        .offset(parseInt(String(offset)))
        .all();
      
      const totalCount = db.select({ count: count() }).from(messageLogs)
        .where(eq(messageLogs.whatsappAccountId, id))
        .get();
      
      res.json({
        count: logs.length,
        total: totalCount?.count || 0,
        offset: parseInt(String(offset)),
        limit: parseInt(String(limit)),
        activity: logs
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Backup & Restore Endpoints
  app.get('/api/accounts/:id/backup', (req, res) => {
    try {
      const { id } = req.params;
      const account = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).get();
      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }
      
      const accountContacts_data = db.select().from(accountContacts).where(eq(accountContacts.accountId, id)).all();
      const messageLogs_data = db.select().from(messageLogs).where(eq(messageLogs.whatsappAccountId, id)).all();
      const campaigns_data = db.select().from(campaigns).all();
      
      const backup = {
        account,
        contacts: accountContacts_data,
        messageLogs: messageLogs_data,
        campaigns: campaigns_data,
        backupDate: new Date().toISOString()
      };
      
      res.json(backup);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/accounts/:id/restore', (req, res) => {
    try {
      const { id } = req.params;
      const { backup } = req.body;
      
      if (!backup || !backup.account) {
        return res.status(400).json({ error: 'Invalid backup data' });
      }
      
      db.update(whatsappAccounts)
        .set({
          displayName: backup.account.displayName
        })
        .where(eq(whatsappAccounts.id, id))
        .run();
      
      res.json({
        success: true,
        message: 'Account restored successfully',
        accountId: id
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Analytics - Messages
  app.get('/api/analytics/messages', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      const daysBack = range === 'today' ? 1 : range === '7days' ? 7 : range === '30days' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      // Total messages
      const allLogs = db.select().from(messageLogs).all();
      const recentLogs = allLogs.filter((log: any) => new Date(log.createdAt) >= startDate);
      
      const totalMessages = recentLogs.length;
      const deliveredMessages = recentLogs.filter((log: any) => log.status === 'delivered').length;
      const failedMessages = recentLogs.filter((log: any) => log.status === 'failed').length;

      // Connected accounts
      const allAccounts = db.select().from(whatsappAccounts).all();
      const connectedAccounts = allAccounts.filter((acc: any) => acc.status === 'connected').length;

      // Total contacts
      const totalContacts = db.select().from(contacts).all().length;

      // Daily data
      const dailyData: any = {};
      for (let i = daysBack; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        dailyData[dateStr] = { date: dateStr, sent: 0, delivered: 0, failed: 0 };
      }

      recentLogs.forEach((log: any) => {
        const dateStr = log.createdAt.split('T')[0];
        if (dailyData[dateStr]) {
          dailyData[dateStr].sent++;
          if (log.status === 'delivered') dailyData[dateStr].delivered++;
          if (log.status === 'failed') dailyData[dateStr].failed++;
        }
      });

      res.json({
        totalMessages,
        deliveredMessages,
        failedMessages,
        successRate: totalMessages > 0 ? ((deliveredMessages / totalMessages) * 100).toFixed(1) : 0,
        connectedAccounts,
        totalContacts,
        dailyData: Object.values(dailyData),
        messageIncrease: 5
      });
    } catch (error: any) {
      logger.error('Error fetching message analytics:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Analytics - Auto-Reply
  app.get('/api/analytics/auto-reply', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      const daysBack = range === 'today' ? 1 : range === '7days' ? 7 : range === '30days' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      // Get auto-reply logs
      const allLogs = db.select().from(autoReplyLogs).all();
      const recentLogs = allLogs.filter((log: any) => new Date(log.createdAt) >= startDate);

      const totalAutoReplies = recentLogs.length;
      const successCount = recentLogs.filter((log: any) => log.status === 'sent').length;
      const failedCount = recentLogs.filter((log: any) => log.status === 'failed').length;

      // Active rules
      const activeRules = db.select().from(autoReplyRules)
        .where(eq(autoReplyRules.isActive, 1))
        .all().length;

      // Calculate average response time
      let totalResponseTime = 0;
      recentLogs.forEach((log: any) => {
        totalResponseTime += (log.autoReply?.length || 0) * 0.01; // Rough estimate
      });
      const avgResponseTime = recentLogs.length > 0 ? (totalResponseTime / recentLogs.length).toFixed(2) : 0;

      res.json({
        totalAutoReplies,
        successCount,
        failedCount,
        successRate: totalAutoReplies > 0 ? ((successCount / totalAutoReplies) * 100).toFixed(1) : 0,
        activeRules,
        avgResponseTime,
        minDelay: 3,
        maxDelay: 8
      });
    } catch (error: any) {
      logger.error('Error fetching auto-reply analytics:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Analytics - Campaigns
  app.get('/api/analytics/campaigns', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      const daysBack = range === 'today' ? 1 : range === '7days' ? 7 : range === '30days' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      // Get campaigns
      const allCampaigns = db.select().from(campaigns).all();
      const recentCampaigns = allCampaigns.filter((c: any) => 
        new Date(c.createdAt) >= startDate
      );

      const totalCampaigns = recentCampaigns.length;
      let totalSent = 0;
      let totalDelivered = 0;

      recentCampaigns.forEach((campaign: any) => {
        totalSent += campaign.sentCount || 0;
        totalDelivered += campaign.deliveredCount || 0;
      });

      // Campaign data for chart
      const campaignData = recentCampaigns.map((c: any) => ({
        name: c.name,
        sent: c.sentCount || 0,
        delivered: c.deliveredCount || 0,
        failed: (c.failedCount || 0)
      })).slice(0, 5);

      const successRate = totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : 0;
      const successCount = totalDelivered;

      res.json({
        totalCampaigns,
        totalSent,
        totalDelivered,
        successRate,
        successCount,
        campaignData
      });
    } catch (error: any) {
      logger.error('Error fetching campaigns analytics:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Analytics - Keywords
  app.get('/api/analytics/keywords', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      const daysBack = range === 'today' ? 1 : range === '7days' ? 7 : range === '30days' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      // Get message logs to analyze keywords
      const allLogs = db.select().from(messageLogs).all();
      const recentLogs = allLogs.filter((log: any) => new Date(log.createdAt) >= startDate);

      // Count keywords
      const keywordCounts: Record<string, number> = {};
      recentLogs.forEach((log: any) => {
        if (log.content) {
          const words = log.content.split(/\s+/).filter((w: string) => w.length > 3);
          words.forEach((word: string) => {
            const cleaned = word.replace(/[^\u0600-\u06FFA-Za-z0-9]/g, '').toLowerCase();
            if (cleaned) {
              keywordCounts[cleaned] = (keywordCounts[cleaned] || 0) + 1;
            }
          });
        }
      });

      // Sort and format
      const keywords = Object.entries(keywordCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([keyword, count]) => ({
          keyword,
          count,
          percentage: recentLogs.length > 0 
            ? ((count / recentLogs.length) * 100).toFixed(1)
            : 0
        }));

      res.json(keywords);
    } catch (error: any) {
      logger.error('Error fetching keywords analytics:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Get all profiles
  app.get('/api/proxy/profiles', (req, res) => {
    try {
      const profiles = db.select().from(proxyProfiles).all();
      res.json(profiles);
    } catch (error: any) {
      logger.error('Error fetching proxy profiles:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Create profile
  app.post('/api/proxy/profiles', (req, res) => {
    try {
      const { name, type, host, port, username, password } = req.body;
      
      if (!name || !type || !host || !port) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const id = uuidv4();
      db.insert(proxyProfiles).values({
        id,
        name,
        type,
        host,
        port,
        username: username || null,
        password: password || null,
        rotationPolicy: null,
        testStatus: 'untested',
        lastTested: null
      }).run();

      res.json({
        success: true,
        message: 'Proxy profile created successfully',
        profileId: id
      });
    } catch (error: any) {
      logger.error('Error creating proxy profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Update profile
  app.patch('/api/proxy/profiles/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { name, type, host, port, username, password } = req.body;

      db.update(proxyProfiles)
        .set({
          name: name || undefined,
          type: type || undefined,
          host: host || undefined,
          port: port || undefined,
          username: username || undefined,
          password: password || undefined
        })
        .where(eq(proxyProfiles.id, id))
        .run();

      res.json({
        success: true,
        message: 'Proxy profile updated successfully'
      });
    } catch (error: any) {
      logger.error('Error updating proxy profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Delete profile
  app.delete('/api/proxy/profiles/:id', (req, res) => {
    try {
      const { id } = req.params;
      db.delete(proxyProfiles).where(eq(proxyProfiles.id, id)).run();
      
      res.json({
        success: true,
        message: 'Proxy profile deleted successfully'
      });
    } catch (error: any) {
      logger.error('Error deleting proxy profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Test proxy
  app.post('/api/proxy/test/:id', (req, res) => {
    try {
      const { id } = req.params;
      
      // Simulate proxy test
      const latency = Math.floor(Math.random() * 100) + 20;
      const success = Math.random() > 0.1; // 90% success rate
      const testStatus = success ? 'healthy' : 'unhealthy';
      
      db.update(proxyProfiles)
        .set({
          testStatus: testStatus,
          lastTested: new Date().toISOString()
        })
        .where(eq(proxyProfiles.id, id))
        .run();

      res.json({
        success,
        latency,
        status: testStatus
      });
    } catch (error: any) {
      logger.error('Error testing proxy:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Toggle rotation policy
  app.patch('/api/proxy/toggle/:id', (req, res) => {
    try {
      const { id } = req.params;
      
      const profile = db.select().from(proxyProfiles)
        .where(eq(proxyProfiles.id, id))
        .all()[0];

      if (profile) {
        const rotationPolicy = profile.rotationPolicy === 'active' ? 'inactive' : 'active';
        
        db.update(proxyProfiles)
          .set({ rotationPolicy: rotationPolicy })
          .where(eq(proxyProfiles.id, id))
          .run();

        res.json({
          success: true,
          message: 'Proxy rotation policy toggled',
          rotationPolicy: rotationPolicy
        });
      } else {
        res.status(404).json({ error: 'Proxy profile not found' });
      }
    } catch (error: any) {
      logger.error('Error toggling proxy status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Proxy Manager - Get proxy stats
  app.get('/api/proxy/stats', (req, res) => {
    try {
      const profiles = db.select().from(proxyProfiles).all();
      
      const stats = {
        totalProfiles: profiles.length,
        activeProfiles: profiles.filter((p: any) => p.rotationPolicy === 'active').length,
        healthyProfiles: profiles.filter((p: any) => p.testStatus === 'healthy').length,
        unhealthyProfiles: profiles.filter((p: any) => p.testStatus === 'unhealthy').length,
        untestedProfiles: profiles.filter((p: any) => p.testStatus === 'untested').length
      };

      res.json(stats);
    } catch (error: any) {
      logger.error('Error fetching proxy stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Network Status - Get overall network status
  app.get('/api/network/status', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      res.json(getOperationalHealthOverview(range));
    } catch (error: any) {
      logger.error('Error fetching network status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Network Status - Get diagnostics
  app.get('/api/network/diagnostics', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      res.json(getNetworkDiagnosticsTable(range));
    } catch (error: any) {
      logger.error('Error fetching diagnostics:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Network Status - Get latency history
  app.get('/api/network/latency', (req, res) => {
    try {
      const range = req.query.range as string || '7days';
      res.json(getNetworkLatencyHistory(range));
    } catch (error: any) {
      logger.error('Error fetching latency history:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Network Status - Run ping test
  app.post('/api/network/ping', async (req, res) => {
    try {
      const result = await runNetworkProbe(req.body?.host);
      res.status(result.success ? 200 : 502).json(result);
    } catch (error: any) {
      logger.error('Error running ping test:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/network/connection-widget', async (req, res) => {
    try {
      const shouldRefresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
      const host = typeof req.query.host === 'string' ? req.query.host : undefined;
      const overview = getOperationalHealthOverview('today');

      if (shouldRefresh || overview.freshnessMinutes > 1.5) {
        await runNetworkProbe(host);
      }

      res.json(await getConnectionWidgetOverview());
    } catch (error: any) {
      logger.error('Error fetching connection widget data:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Network Status - Get network stats
  app.get('/api/network/stats', (req, res) => {
    try {
      const allDiagnostics = db.select().from(networkDiagnostics).all();
      
      const onlineCount = allDiagnostics.filter((d: any) => d.status === 'online').length;
      
      const stats = {
        totalTests: allDiagnostics.length,
        onlineTests: onlineCount,
        offlineTests: allDiagnostics.length - onlineCount,
        avgLatency: allDiagnostics.length > 0
          ? (allDiagnostics.reduce((sum: number, d: any) => sum + (d.pingMs || 0), 0) / allDiagnostics.length).toFixed(2)
          : 0,
        uptime: allDiagnostics.length > 0
          ? (((onlineCount) / allDiagnostics.length) * 100).toFixed(2)
          : 0
      };

      res.json(stats);
    } catch (error: any) {
      logger.error('Error fetching network stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared Inbox - Get conversations
  app.get('/api/conversations', (req, res) => {
    try {
      const status = req.query.status as string;
      
      let allConversations = db.select().from(conversations).all();
      
      if (status) {
        allConversations = allConversations.filter((c: any) => c.status === status);
      }

      // Enrich with contact data
      const result = allConversations.map((conv: any) => {
        const contact = db.select().from(contacts).where(eq(contacts.id, conv.contactId)).all()[0];
        return {
          id: conv.id,
          contactId: conv.contactId,
          contactName: contact?.fullName || 'Unknown',
          contactPhone: contact?.phone || '',
          status: conv.status,
          unreadCount: conv.unreadCount || 0,
          lastMessage: conv.lastMessageAt ? 'پیام موجود' : 'بدون پیام',
          lastMessageAt: conv.lastMessageAt || new Date().toISOString(),
          assignedTo: null,
          isPinned: Math.random() > 0.7, // Simulate
          createdAt: conv.createdAt
        };
      });

      res.json(result);
    } catch (error: any) {
      logger.error('Error fetching conversations:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared Inbox - Get messages for conversation
  app.get('/api/conversations/:id/messages', (req, res) => {
    try {
      const { id } = req.params;

      const conversation = db.select().from(conversations)
        .where(eq(conversations.id, id))
        .get();

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const messages = db.select().from(messageLogs)
        .all()
        .filter((log: any) => log.conversationId === id)
        .sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
        .map((log: any) => ({
          id: log.id || uuidv4(),
          conversationId: id,
          senderId: log.whatsappAccountId || 'system',
          content: log.content || '',
          mediaPath: log.mediaPath || null,
          messageType: log.messageType || 'text',
          timestamp: log.createdAt || new Date().toISOString(),
          isRead: log.direction === 'outbound' ? true : (conversation.unreadCount || 0) === 0,
          type: log.direction === 'outbound' ? 'sent' : 'received'
        }));

      res.json(messages);
    } catch (error: any) {
      logger.error('Error fetching messages:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared Inbox - Send message
  app.post('/api/conversations/:id/messages', async (req, res) => {
    try {
      const { id } = req.params;
      const { content, mediaPath, fileName, mimeType, mediaType, ptt } = req.body;

      if (!content && !mediaPath) {
        return res.status(400).json({ error: 'Message content or mediaPath required' });
      }

      const conversation = db.select().from(conversations)
        .where(eq(conversations.id, id))
        .get();

      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const contact = db.select().from(contacts)
        .where(eq(contacts.id, conversation.contactId || ''))
        .get();

      if (!contact?.phone) {
        return res.status(400).json({ error: 'Conversation contact has no phone number' });
      }

      if (!conversation.whatsappAccountId) {
        return res.status(400).json({ error: 'Conversation has no linked WhatsApp account' });
      }

      if (mediaPath) {
        await sendMediaMessage(conversation.whatsappAccountId, contact.phone, {
          mediaPath,
          caption: content || '',
          fileName,
          mimeType,
          mediaType,
          ptt,
        });
      } else {
        await sendMessage(conversation.whatsappAccountId, contact.phone, content);
      }

      const messageId = uuidv4();
      const now = new Date().toISOString();

      db.insert(messageLogs).values({
        id: messageId,
        whatsappAccountId: conversation.whatsappAccountId,
        contactId: conversation.contactId,
        conversationId: conversation.id,
        direction: 'outbound',
        messageType: mediaPath ? (mediaType || 'document') : 'text',
        content: content || '',
        mediaPath: mediaPath || null,
        status: 'sent',
        createdAt: now,
      }).run();

      db.update(conversations)
        .set({
          lastMessageAt: now,
          updatedAt: now,
          status: 'open'
        })
        .where(eq(conversations.id, id))
        .run();

      res.json({
        success: true,
        message: {
          id: messageId,
          conversationId: id,
          senderId: conversation.whatsappAccountId,
          content: content || '',
          mediaPath: mediaPath || null,
          messageType: mediaPath ? (mediaType || 'document') : 'text',
          timestamp: now,
          isRead: true,
          type: 'sent'
        }
      });
    } catch (error: any) {
      logger.error('Error sending message:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared Inbox - Close conversation
  app.patch('/api/conversations/:id/close', (req, res) => {
    try {
      const { id } = req.params;

      db.update(conversations)
        .set({ status: 'closed' as any })
        .where(eq(conversations.id, id))
        .run();

      res.json({
        success: true,
        message: 'Conversation closed successfully'
      });
    } catch (error: any) {
      logger.error('Error closing conversation:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared Inbox - Toggle pin conversation
  app.patch('/api/conversations/:id/pin', (req, res) => {
    try {
      const { id } = req.params;

      res.json({
        success: true,
        message: 'Conversation pin toggled successfully',
        conversationId: id
      });
    } catch (error: any) {
      logger.error('Error toggling pin:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Shared Inbox - Get conversation stats
  app.get('/api/conversations/stats', (req, res) => {
    try {
      const allConversations = db.select().from(conversations).all();
      
      const stats = {
        totalConversations: allConversations.length,
        openConversations: allConversations.filter((c: any) => c.status === 'open').length,
        closedConversations: allConversations.filter((c: any) => c.status === 'closed').length,
        pendingConversations: allConversations.filter((c: any) => c.status === 'pending').length,
        totalUnread: allConversations.reduce((sum: number, c: any) => sum + (c.unreadCount || 0), 0),
        avgResponseTime: Math.floor(Math.random() * 3600) + 60 // Simulate in seconds
      };

      res.json(stats);
    } catch (error: any) {
      logger.error('Error fetching conversation stats:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

