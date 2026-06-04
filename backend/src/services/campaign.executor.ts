import { db } from '../database';
import { campaigns, messageLogs, contacts, whatsappAccounts, warmUpProfiles, queueJobs, campaignEvents } from '../database/schema';
import { eq, inArray } from 'drizzle-orm';
import { sendMessage, sendMediaMessage } from '../modules/whatsapp/baileys.service';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { analyzeSuspiciousText } from '../utils/text-integrity';
import { personalizeMessage as personalizeTemplateMessage } from '../utils/message-personalizer';

interface CampaignExecutionResult {
  campaignId: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  usedAccountIds?: string[];
  errors: string[];
  executionState?: string;
}

interface AccountWindowUsage {
  hour: number;
  day: number;
}

interface WarmUpLimitInfo {
  profileId: string;
  profileName: string;
  currentDay: number;
  dailyLimit: number;
  status: string;
}

interface CampaignEventInput {
  campaignId: string;
  level?: 'info' | 'warn' | 'error' | 'success';
  eventType: string;
  message: string;
  accountId?: string | null;
  contactId?: string | null;
  payload?: Record<string, any> | null;
}

interface CampaignProgressSummary {
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  pendingCount: number;
  sentContactIds: Set<string>;
  failedContactIds: Set<string>;
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getCampaignById(campaignId: string) {
  return db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
}

function getCampaignMessageLogs(campaignId: string) {
  return db.select()
    .from(messageLogs)
    .all()
    .filter((log: any) => log.campaignId === campaignId)
    .sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

function resolveCampaignRecipientIds(campaign: any): string[] {
  const directRecipientIds = parseStringArray(campaign?.contactIds);
  if (directRecipientIds.length > 0) {
    return directRecipientIds;
  }

  if (!campaign?.segmentId) {
    return [];
  }

  return db.select()
    .from(contacts)
    .all()
    .filter((contact: any) => {
      let tags: string[] = [];

      try {
        tags = JSON.parse(contact.tags || '[]');
      } catch {
        tags = [];
      }

      if (campaign.segmentId === 'بدون تگ') {
        return tags.length === 0;
      }

      return tags.includes(campaign.segmentId);
    })
    .map((contact: any) => contact.id)
    .filter(Boolean);
}

function summarizeCampaignProgress(campaign: any): CampaignProgressSummary {
  const recipientIds = resolveCampaignRecipientIds(campaign);
  const logs = getCampaignMessageLogs(campaign.id);
  const logsByContact = new Map<string, any[]>();

  logs.forEach((log: any) => {
    if (!log.contactId) {
      return;
    }

    if (!logsByContact.has(log.contactId)) {
      logsByContact.set(log.contactId, []);
    }

    logsByContact.get(log.contactId)?.push(log);
  });

  const sentContactIds = new Set<string>();
  const failedContactIds = new Set<string>();

  recipientIds.forEach((recipientId) => {
    const contactLogs = logsByContact.get(recipientId) || [];
    if (contactLogs.some((log: any) => log.status === 'sent')) {
      sentContactIds.add(recipientId);
      return;
    }

    if (contactLogs.some((log: any) => log.status === 'failed')) {
      failedContactIds.add(recipientId);
    }
  });

  const totalRecipients = recipientIds.length;
  const storedSentCount = Math.max(0, Number(campaign?.sentCount || 0));
  const storedFailedCount = Math.max(0, Number(campaign?.failedCount || 0));
  const sentCount = Math.max(sentContactIds.size, storedSentCount);
  const failedCount = Math.max(failedContactIds.size, storedFailedCount);
  const pendingCount = ['completed', 'cancelled'].includes(campaign?.status || '')
    ? 0
    : Math.max(0, totalRecipients - sentCount - failedCount);

  return {
    totalRecipients,
    sentCount,
    failedCount,
    pendingCount,
    sentContactIds,
    failedContactIds,
  };
}

function syncCampaignCounters(campaignId: string) {
  const campaign = getCampaignById(campaignId);
  if (!campaign) {
    return null;
  }

  const summary = summarizeCampaignProgress(campaign);
  db.update(campaigns)
    .set({
      sentCount: summary.sentCount,
      failedCount: summary.failedCount,
    })
    .where(eq(campaigns.id, campaignId))
    .run();

  return summary;
}

export function appendCampaignEvent(input: CampaignEventInput) {
  db.insert(campaignEvents)
    .values({
      id: uuidv4(),
      campaignId: input.campaignId,
      accountId: input.accountId || null,
      contactId: input.contactId || null,
      level: input.level || 'info',
      eventType: input.eventType,
      message: input.message,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function createCampaignMessageLog(options: {
  campaignId: string;
  accountId?: string | null;
  contactId?: string | null;
  status: 'sent' | 'failed';
  content?: string;
  mediaPath?: string | null;
  messageType?: string;
  parsedData?: Record<string, any> | null;
}) {
  db.insert(messageLogs)
    .values({
      id: uuidv4(),
      whatsappAccountId: options.accountId || null,
      contactId: options.contactId || null,
      campaignId: options.campaignId,
      direction: 'outbound',
      messageType: options.messageType || 'text',
      content: options.content || '',
      mediaPath: options.mediaPath || null,
      status: options.status,
      parsedData: options.parsedData ? JSON.stringify(options.parsedData) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function getCampaignQueueJobs(campaignId: string) {
  return db.select()
    .from(queueJobs)
    .all()
    .filter((job: any) => {
      if (job.type !== 'campaign_execution' || !job.payload) {
        return false;
      }

      try {
        const payload = JSON.parse(job.payload);
        return payload?.campaignId === campaignId;
      } catch {
        return false;
      }
    });
}

export function getCampaignExecutionSnapshot(campaignId: string) {
  const campaign = getCampaignById(campaignId);
  if (!campaign) {
    return null;
  }

  const summary = summarizeCampaignProgress(campaign);
  const logs = getCampaignMessageLogs(campaignId);
  const events = db.select()
    .from(campaignEvents)
    .all()
    .filter((event: any) => event.campaignId === campaignId)
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const queueJobList = getCampaignQueueJobs(campaignId)
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const configuredAccountIds = parseStringArray(campaign.accountIds);
  const accountIds = Array.from(new Set([
    ...configuredAccountIds,
    ...logs.map((log: any) => log.whatsappAccountId).filter(Boolean),
    ...events.map((event: any) => event.accountId).filter(Boolean),
  ]));

  const accountsMap = new Map(
    db.select()
      .from(whatsappAccounts)
      .all()
      .map((account: any) => [account.id, account])
  );

  const accountBreakdown = accountIds.map((accountId) => {
    const accountLogs = logs.filter((log: any) => log.whatsappAccountId === accountId);
    const sentCount = accountLogs.filter((log: any) => log.status === 'sent').length;
    const failedCount = accountLogs.filter((log: any) => log.status === 'failed').length;
    const lastEvent = events.find((event: any) => event.accountId === accountId) || null;
    const account = accountsMap.get(accountId);
    const warmUp = getWarmUpLimitForAccount(accountId);
    const usage = getHistoricalAccountUsage(accountId);

    return {
      accountId,
      displayName: account?.displayName || account?.phoneNumber || accountId,
      phoneNumber: account?.phoneNumber || null,
      connectionStatus: account?.status || 'unknown',
      attemptedCount: accountLogs.length,
      sentCount,
      failedCount,
      hourUsage: usage.hour,
      dayUsage: usage.day,
      maxPerHour: campaign.maxPerHour || null,
      maxPerDay: campaign.maxPerDay || null,
      warmUp,
      lastEvent,
    };
  });

  const totalRecipients = summary.totalRecipients;
  const completedRecipients = summary.sentCount + summary.failedCount;
  const latestJob = queueJobList[0] || null;

  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    totalRecipients,
    sentCount: summary.sentCount,
    failedCount: summary.failedCount,
    pendingCount: summary.pendingCount,
    deliveredCount: campaign.deliveredCount || 0,
    readCount: campaign.readCount || 0,
    blockedCount: campaign.blockedCount || 0,
    completedRecipients,
    progressPercent: totalRecipients > 0 ? Math.min(100, Math.round((completedRecipients / totalRecipients) * 100)) : 0,
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt,
    completedAt: campaign.completedAt,
    queue: latestJob ? {
      id: latestJob.id,
      status: latestJob.status,
      attempts: latestJob.attempts || 0,
      maxAttempts: latestJob.maxAttempts || 0,
      errorMessage: latestJob.errorMessage || null,
      createdAt: latestJob.createdAt,
      startedAt: latestJob.startedAt,
      completedAt: latestJob.completedAt,
    } : null,
    accountBreakdown,
    recentEvents: events.slice(0, 20),
  };
}

function getRandomCampaignDelayMs(campaign: any) {
  const rawMin = Number(campaign?.delayMinMs || 0);
  const rawMax = Number(campaign?.delayMaxMs || 0);
  const min = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 0;
  const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 0;

  if (!min && !max) {
    return 0;
  }

  const normalizedMin = Math.min(min || max, max || min);
  const normalizedMax = Math.max(min || max, max || min);

  if (normalizedMax <= normalizedMin) {
    return normalizedMin;
  }

  return normalizedMin + Math.floor(Math.random() * (normalizedMax - normalizedMin + 1));
}

async function waitForCampaignDelay(campaign: any) {
  const delayMs = getRandomCampaignDelayMs(campaign);
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getHourWindowStart(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
}

function getDayWindowStart(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function getHistoricalAccountUsage(accountId: string, now = new Date()): AccountWindowUsage {
  const hourStart = getHourWindowStart(now).getTime();
  const dayStart = getDayWindowStart(now).getTime();

  const outboundLogs = db.select()
    .from(messageLogs)
    .all()
    .filter((log: any) => log.whatsappAccountId === accountId && log.direction === 'outbound' && log.status === 'sent');

  let hour = 0;
  let day = 0;

  outboundLogs.forEach((log: any) => {
    const createdAt = log.createdAt ? new Date(log.createdAt).getTime() : 0;
    if (createdAt >= dayStart) {
      day++;
    }
    if (createdAt >= hourStart) {
      hour++;
    }
  });

  return { hour, day };
}

function extractWarmUpDailyLimit(profile: any): number | null {
  if (!profile?.dailyPlan) {
    return null;
  }

  try {
    const parsedPlan = JSON.parse(profile.dailyPlan);
    const currentDay = Math.max(1, Number(profile.currentDay || 1));

    if (Array.isArray(parsedPlan)) {
      const dayEntry = parsedPlan[currentDay - 1];
      if (typeof dayEntry === 'number') return dayEntry;
      if (dayEntry && typeof dayEntry === 'object') {
        return Number(dayEntry.dailyLimit || dayEntry.maxMessages || dayEntry.maxPerDay || dayEntry.limit || 0) || null;
      }
    }

    if (parsedPlan && typeof parsedPlan === 'object') {
      const dayEntry = parsedPlan[String(currentDay)] ?? parsedPlan[`day${currentDay}`] ?? parsedPlan[currentDay - 1];
      if (typeof dayEntry === 'number') return dayEntry;
      if (dayEntry && typeof dayEntry === 'object') {
        return Number(dayEntry.dailyLimit || dayEntry.maxMessages || dayEntry.maxPerDay || dayEntry.limit || 0) || null;
      }
    }
  } catch (error) {
    logger.warn(`Failed to parse warm-up daily plan for profile ${profile?.id}:`, error);
  }

  return null;
}

function getWarmUpLimitForAccount(accountId: string): WarmUpLimitInfo | null {
  const account = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, accountId)).get();
  if (!account?.warmUpProfileId) {
    return null;
  }

  const profile = db.select().from(warmUpProfiles).where(eq(warmUpProfiles.id, account.warmUpProfileId)).get();
  if (!profile) {
    return null;
  }

  if (profile.status && !['active', 'running'].includes(profile.status)) {
    return null;
  }

  const currentDay = Math.max(1, Number(profile.currentDay || 1));
  const totalDays = Math.max(1, Number(profile.totalDays || currentDay));
  if (currentDay > totalDays) {
    return null;
  }

  const dailyLimit = extractWarmUpDailyLimit(profile);
  if (!dailyLimit || dailyLimit <= 0) {
    return null;
  }

  return {
    profileId: profile.id,
    profileName: profile.name || profile.id,
    currentDay,
    dailyLimit,
    status: profile.status || 'active',
  };
}

function canUseAccountForCampaign(
  accountId: string,
  campaign: any,
  historicalUsage: Map<string, AccountWindowUsage>,
  executionUsage: Map<string, AccountWindowUsage>,
  warmUpLimits: Map<string, WarmUpLimitInfo | null>
): boolean {
  const maxPerHour = campaign.maxPerHour && campaign.maxPerHour > 0 ? campaign.maxPerHour : null;
  const maxPerDay = campaign.maxPerDay && campaign.maxPerDay > 0 ? campaign.maxPerDay : null;
  const warmUpDailyLimit = warmUpLimits.get(accountId)?.dailyLimit || null;
  const effectiveMaxPerDay = maxPerDay && warmUpDailyLimit
    ? Math.min(maxPerDay, warmUpDailyLimit)
    : (maxPerDay || warmUpDailyLimit);

  if (!maxPerHour && !effectiveMaxPerDay) {
    return true;
  }

  const historical = historicalUsage.get(accountId) || { hour: 0, day: 0 };
  const execution = executionUsage.get(accountId) || { hour: 0, day: 0 };
  const effectiveHourUsage = historical.hour + execution.hour;
  const effectiveDayUsage = historical.day + execution.day;

  if (maxPerHour && effectiveHourUsage >= maxPerHour) {
    return false;
  }

  if (effectiveMaxPerDay && effectiveDayUsage >= effectiveMaxPerDay) {
    return false;
  }

  return true;
}

function incrementExecutionUsage(accountId: string, executionUsage: Map<string, AccountWindowUsage>) {
  const current = executionUsage.get(accountId) || { hour: 0, day: 0 };
  executionUsage.set(accountId, {
    hour: current.hour + 1,
    day: current.day + 1,
  });
}

function selectNextAccountId(
  accountIds: string[],
  startIndex: number,
  campaign: any,
  historicalUsage: Map<string, AccountWindowUsage>,
  executionUsage: Map<string, AccountWindowUsage>,
  warmUpLimits: Map<string, WarmUpLimitInfo | null>
) {
  for (let offset = 0; offset < accountIds.length; offset++) {
    const candidateIndex = (startIndex + offset) % accountIds.length;
    const candidateAccountId = accountIds[candidateIndex];
    if (canUseAccountForCampaign(candidateAccountId, campaign, historicalUsage, executionUsage, warmUpLimits)) {
      return {
        accountId: candidateAccountId,
        nextIndex: (candidateIndex + 1) % accountIds.length,
      };
    }
  }

  return null;
}

/**
 * Personalizes message template by replacing placeholders with actual contact data
 * Example: "سلام {{name}}، این پیام تستی است" -> "سلام احمد، این پیام تستی است"
 */
export function personalizeMessage(template: string, contactData: any): string {
  return personalizeTemplateMessage(template, contactData).personalizedMessage;
}

/**
 * Executes a campaign by sending messages to all recipients.
 * When multiple accounts are provided, recipients are distributed in round-robin order.
 */
export async function executeCampaign(campaignId: string, accountIdOrAccountIds: string | string[]): Promise<CampaignExecutionResult> {
  const result: CampaignExecutionResult = {
    campaignId,
    totalRecipients: 0,
    sentCount: 0,
    failedCount: 0,
    usedAccountIds: [],
    errors: []
  };

  try {
    // Fetch campaign from database
    const campaignArray = db.select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .all();

    if (campaignArray.length === 0) {
      const errorMsg = `Campaign ${campaignId} not found`;
      logger.error(errorMsg);
      result.errors.push(errorMsg);
      result.executionState = 'failed';
      return result;
    }

    const campaign = campaignArray[0];

    const executionAccountIds = Array.isArray(accountIdOrAccountIds)
      ? accountIdOrAccountIds.filter(Boolean)
      : [accountIdOrAccountIds].filter(Boolean);

    let campaignAccountIds: string[] = [];
    try {
      campaignAccountIds = campaign.accountIds ? JSON.parse(campaign.accountIds) : [];
    } catch (e) {
      logger.warn(`Failed to parse campaign accountIds for ${campaignId}, falling back to provided account IDs.`);
    }

    const availableAccountIds = Array.from(new Set([
      ...executionAccountIds,
      ...campaignAccountIds,
    ].filter(Boolean)));

    if (availableAccountIds.length === 0) {
      const errorMsg = `Campaign ${campaignId} has no execution accounts`;
      logger.error(errorMsg);
      result.errors.push(errorMsg);
      result.executionState = 'failed';
      return result;
    }

    result.usedAccountIds = availableAccountIds;

    // Validate campaign status
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      const errorMsg = `Campaign ${campaignId} is already ${campaign.status}`;
      logger.warn(errorMsg);
      result.errors.push(errorMsg);
      result.executionState = campaign.status;
      return result;
    }

    if (campaign.status === 'paused') {
      const pausedMsg = `Campaign ${campaignId} is paused and cannot continue until resumed`;
      logger.warn(pausedMsg);
      appendCampaignEvent({
        campaignId,
        level: 'warn',
        eventType: 'paused-before-start',
        message: pausedMsg,
      });
      result.errors.push(pausedMsg);
      result.executionState = 'paused';
      return result;
    }

    // Validate campaign content
    if ((!campaign.messageTemplate || campaign.messageTemplate.trim() === '') && !campaign.mediaPath) {
      const errorMsg = `Campaign ${campaignId} has no message template or media path`;
      logger.error(errorMsg);
      result.errors.push(errorMsg);
      result.executionState = 'failed';
      return result;
    }

    // Get recipient contact IDs
    const recipientIds = resolveCampaignRecipientIds(campaign);

    if (recipientIds.length === 0) {
      const errorMsg = `Campaign ${campaignId} has no recipients`;
      logger.warn(errorMsg);
      result.errors.push(errorMsg);
      result.executionState = 'failed';
      return result;
    }

    result.totalRecipients = recipientIds.length;

    const existingProgress = syncCampaignCounters(campaignId);
    result.sentCount = existingProgress?.sentCount || 0;
    result.failedCount = existingProgress?.failedCount || 0;
    const pendingRecipientIds = recipientIds.filter((recipientId) => !existingProgress?.sentContactIds.has(recipientId));

    if (pendingRecipientIds.length === 0) {
      db.update(campaigns)
        .set({
          status: 'completed',
          completedAt: new Date().toISOString(),
        })
        .where(eq(campaigns.id, campaignId))
        .run();

      appendCampaignEvent({
        campaignId,
        level: 'success',
        eventType: 'already-complete',
        message: `Campaign ${campaignId} already has successful logs for all recipients.`,
      });

      result.executionState = 'completed';
      return result;
    }

    // Mark campaign as started
    db.update(campaigns)
      .set({ 
        status: 'in-progress',
        sentCount: existingProgress?.sentCount || 0,
        failedCount: existingProgress?.failedCount || 0,
        startedAt: campaign.startedAt || new Date().toISOString(),
        completedAt: null,
      })
      .where(eq(campaigns.id, campaignId))
      .run();

    appendCampaignEvent({
      campaignId,
      level: 'info',
      eventType: 'execution-started',
      message: `Campaign execution started with ${availableAccountIds.length} account(s) and ${pendingRecipientIds.length} pending recipient(s).`,
      payload: { availableAccountIds, totalRecipients: recipientIds.length, pendingRecipients: pendingRecipientIds.length },
    });

    const textIntegrityWarning = analyzeSuspiciousText(campaign.messageTemplate, 'messageTemplate');
    if (textIntegrityWarning) {
      appendCampaignEvent({
        campaignId,
        level: 'warn',
        eventType: 'text-integrity-warning',
        message: textIntegrityWarning.message,
        payload: textIntegrityWarning,
      });
    }

    logger.info(`Starting campaign execution: ${campaignId} for accounts ${availableAccountIds.join(', ')}`);
    logger.info(`Campaign will send to ${pendingRecipientIds.length} pending recipients`);

    // Fetch all recipient contacts
    const recipientsArray = db.select()
      .from(contacts)
      .where(inArray(contacts.id, recipientIds))
      .all();

    const recipientsMap = new Map(recipientsArray.map(c => [c.id, c]));
    const historicalUsage = new Map<string, AccountWindowUsage>(
      availableAccountIds.map(accountId => [accountId, getHistoricalAccountUsage(accountId)])
    );
    const warmUpLimits = new Map<string, WarmUpLimitInfo | null>(
      availableAccountIds.map(accountId => [accountId, getWarmUpLimitForAccount(accountId)])
    );
    const executionUsage = new Map<string, AccountWindowUsage>(
      availableAccountIds.map(accountId => [accountId, { hour: 0, day: 0 }])
    );
    let roundRobinIndex = 0;

    // Send message to each recipient
    for (let index = 0; index < pendingRecipientIds.length; index++) {
      const liveCampaign = getCampaignById(campaignId);
      if (!liveCampaign) {
        const missingCampaignError = `Campaign ${campaignId} no longer exists during execution`;
        logger.warn(missingCampaignError);
        result.errors.push(missingCampaignError);
        result.executionState = 'failed';
        break;
      }

      if (liveCampaign.status === 'paused') {
        logger.info(`Campaign ${campaignId} paused during execution`);
        appendCampaignEvent({
          campaignId,
          level: 'warn',
          eventType: 'execution-paused',
          message: `Campaign paused after processing ${index} pending recipient(s).`,
          payload: { processedPendingRecipients: index },
        });
        syncCampaignCounters(campaignId);
        result.executionState = 'paused';
        return result;
      }

      if (liveCampaign.status === 'cancelled') {
        logger.info(`Campaign ${campaignId} cancelled during execution`);
        appendCampaignEvent({
          campaignId,
          level: 'warn',
          eventType: 'execution-cancelled',
          message: `Campaign cancelled after processing ${index} pending recipient(s).`,
          payload: { processedPendingRecipients: index },
        });
        syncCampaignCounters(campaignId);
        result.executionState = 'cancelled';
        return result;
      }

      const recipientId = pendingRecipientIds[index];
      const contact = recipientsMap.get(recipientId);
      const selectedAccount = selectNextAccountId(
        availableAccountIds,
        roundRobinIndex,
        campaign,
        historicalUsage,
        executionUsage,
        warmUpLimits
      );

      if (!selectedAccount) {
        const remainingRecipients = pendingRecipientIds.length - index;
        const warmUpSummary = availableAccountIds
          .map(accountId => {
            const warmUp = warmUpLimits.get(accountId);
            return warmUp ? `${accountId}: day ${warmUp.currentDay} / limit ${warmUp.dailyLimit}` : null;
          })
          .filter(Boolean)
          .join(', ');
        const limitError = `All execution accounts reached campaign limits for campaign ${campaignId}. Remaining recipients not sent: ${remainingRecipients}${warmUpSummary ? ` | Warm-up: ${warmUpSummary}` : ''}`;
        logger.warn(limitError);
        result.errors.push(limitError);
        appendCampaignEvent({
          campaignId,
          level: 'warn',
          eventType: 'limits-exhausted',
          message: limitError,
          payload: { remainingRecipients, warmUpSummary },
        });

        for (let remainingIndex = index; remainingIndex < pendingRecipientIds.length; remainingIndex++) {
          createCampaignMessageLog({
            campaignId,
            contactId: pendingRecipientIds[remainingIndex],
            status: 'failed',
            content: campaign.messageTemplate || '',
            mediaPath: campaign.mediaPath || null,
            messageType: campaign.mediaPath ? 'document' : 'text',
            parsedData: { reason: 'limits-exhausted', message: limitError },
          });
        }

        const updatedProgress = syncCampaignCounters(campaignId);
        result.sentCount = updatedProgress?.sentCount || result.sentCount;
        result.failedCount = updatedProgress?.failedCount || result.failedCount;
        break;
      }

      const targetAccountId = selectedAccount.accountId;
      roundRobinIndex = selectedAccount.nextIndex;
      
      if (!contact) {
        logger.warn(`Contact ${recipientId} not found for campaign ${campaignId}`);
        createCampaignMessageLog({
          campaignId,
          accountId: targetAccountId,
          contactId: recipientId,
          status: 'failed',
          content: campaign.messageTemplate || '',
          mediaPath: campaign.mediaPath || null,
          messageType: campaign.mediaPath ? 'document' : 'text',
          parsedData: { reason: 'missing-contact' },
        });
        appendCampaignEvent({
          campaignId,
          level: 'error',
          eventType: 'missing-contact',
          message: `Contact ${recipientId} not found for campaign execution.`,
          accountId: targetAccountId,
          contactId: recipientId,
        });
        const updatedProgress = syncCampaignCounters(campaignId);
        result.sentCount = updatedProgress?.sentCount || result.sentCount;
        result.failedCount = updatedProgress?.failedCount || result.failedCount;
        continue;
      }

      // Validate contact has phone number
      if (!contact.phone || contact.phone.trim() === '') {
        logger.warn(`Contact ${contact.fullName || recipientId} has no phone number`);
        createCampaignMessageLog({
          campaignId,
          accountId: targetAccountId,
          contactId: contact.id,
          status: 'failed',
          content: campaign.messageTemplate || '',
          mediaPath: campaign.mediaPath || null,
          messageType: campaign.mediaPath ? 'document' : 'text',
          parsedData: { reason: 'missing-phone' },
        });
        appendCampaignEvent({
          campaignId,
          level: 'warn',
          eventType: 'missing-phone',
          message: `Contact ${contact.fullName || recipientId} has no phone number.`,
          accountId: targetAccountId,
          contactId: contact.id,
        });
        const updatedProgress = syncCampaignCounters(campaignId);
        result.sentCount = updatedProgress?.sentCount || result.sentCount;
        result.failedCount = updatedProgress?.failedCount || result.failedCount;
        continue;
      }

      let personalizedMessage = '';

      try {
        // Personalize the message template
        personalizedMessage = campaign.messageTemplate
          ? personalizeMessage(campaign.messageTemplate, contact)
          : '';
        
        logger.info(`Sending message to ${contact.phone} (${contact.fullName}) using account ${targetAccountId}`);
        
        // Send the message via WhatsApp
        const sendResult: any = campaign.mediaPath
          ? await sendMediaMessage(targetAccountId, contact.phone, {
              mediaPath: campaign.mediaPath,
              caption: personalizedMessage,
            })
          : await sendMessage(targetAccountId, contact.phone, personalizedMessage);
        
        createCampaignMessageLog({
          campaignId,
          accountId: targetAccountId,
          contactId: contact.id,
          status: 'sent',
          content: personalizedMessage,
          mediaPath: campaign.mediaPath || null,
          messageType: campaign.mediaPath ? String(sendResult.mediaType || 'document') : 'text',
          parsedData: sendResult ? { sendResult } : null,
        });

        appendCampaignEvent({
          campaignId,
          level: 'success',
          eventType: 'message-sent',
          message: `Message sent to ${contact.phone} using account ${targetAccountId}.`,
          accountId: targetAccountId,
          contactId: contact.id,
          payload: {
            phone: contact.phone,
            mediaPath: campaign.mediaPath || null,
            messageType: campaign.mediaPath ? String(sendResult.mediaType || 'document') : 'text',
          },
        });

        incrementExecutionUsage(targetAccountId, executionUsage);
        const updatedProgress = syncCampaignCounters(campaignId);
        result.sentCount = updatedProgress?.sentCount || result.sentCount;
        result.failedCount = updatedProgress?.failedCount || result.failedCount;

      } catch (error: any) {
        logger.error(`Failed to send message to ${contact.phone}:`, error);
        result.errors.push(`Failed to send to ${contact.phone}: ${error.message}`);

        createCampaignMessageLog({
          campaignId,
          accountId: targetAccountId,
          contactId: contact.id,
          status: 'failed',
          content: personalizedMessage,
          mediaPath: campaign.mediaPath || null,
          messageType: campaign.mediaPath ? 'document' : 'text',
          parsedData: { error: error.message },
        });

        appendCampaignEvent({
          campaignId,
          level: 'error',
          eventType: 'message-failed',
          message: `Failed to send message to ${contact.phone} using account ${targetAccountId}: ${error.message}`,
          accountId: targetAccountId,
          contactId: contact.id,
          payload: { error: error.message, phone: contact.phone },
        });

        const updatedProgress = syncCampaignCounters(campaignId);
        result.sentCount = updatedProgress?.sentCount || result.sentCount;
        result.failedCount = updatedProgress?.failedCount || result.failedCount;
      }

      if (index < pendingRecipientIds.length - 1) {
        await waitForCampaignDelay(campaign);
      }
    }

    const finalCampaign = getCampaignById(campaignId);
    const finalProgress = syncCampaignCounters(campaignId);
    result.sentCount = finalProgress?.sentCount || result.sentCount;
    result.failedCount = finalProgress?.failedCount || result.failedCount;

    if (finalCampaign?.status === 'paused') {
      result.executionState = 'paused';
      return result;
    }

    if (finalCampaign?.status !== 'cancelled') {
      db.update(campaigns)
        .set({ 
          status: 'completed',
          completedAt: new Date().toISOString()
        })
        .where(eq(campaigns.id, campaignId))
        .run();

      appendCampaignEvent({
        campaignId,
        level: result.failedCount > 0 ? 'warn' : 'success',
        eventType: 'execution-completed',
        message: `Campaign execution completed. Sent: ${result.sentCount}, Failed: ${result.failedCount}.`,
        payload: { sentCount: result.sentCount, failedCount: result.failedCount, totalRecipients: result.totalRecipients },
      });
    }

    logger.info(
      `Campaign execution completed: ${campaignId} | Sent: ${result.sentCount}/${result.totalRecipients} | Failed: ${result.failedCount}`
    );

    result.executionState = finalCampaign?.status === 'cancelled' ? 'cancelled' : 'completed';

    return result;

  } catch (error: any) {
    logger.error(`Campaign execution failed for ${campaignId}:`, error);
    
    // Mark campaign as failed
    db.update(campaigns)
      .set({ status: 'failed' })
      .where(eq(campaigns.id, campaignId))
      .run();

    appendCampaignEvent({
      campaignId,
      level: 'error',
      eventType: 'execution-crashed',
      message: `Campaign execution crashed: ${error.message}`,
      payload: { error: error.message },
    });

    result.errors.push(`Campaign execution error: ${error.message}`);
    result.executionState = 'failed';
    return result;
  }
}

/**
 * Processes a campaign execution job from the queue
 */
export async function processCampaignJob(jobData: any): Promise<any> {
  try {
    const { campaignId, accountId, accountIds } = jobData;

    const executionAccounts = Array.isArray(accountIds) && accountIds.length > 0
      ? accountIds
      : accountId
        ? [accountId]
        : [];

    if (!campaignId || executionAccounts.length === 0) {
      throw new Error('Missing campaignId or execution accounts in job data');
    }

    const result = await executeCampaign(campaignId, executionAccounts);
    return {
      success: result.executionState === 'paused' || result.executionState === 'cancelled'
        ? true
        : result.failedCount === 0,
      data: result
    };

  } catch (error: any) {
    logger.error('Campaign job processing failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
