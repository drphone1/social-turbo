import { desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database';
import { aiGovernanceLogs, campaigns, contacts, conversations, whatsappAccounts } from '../database/schema';
import { rateLimiter } from '../modules/whatsapp/rate-limiter';
import { collectCampaignTextWarnings } from '../utils/text-integrity';

function parseStringList(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function asBoolean(value: unknown, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function isSensitiveAction(actionType: string) {
  return [
    'reply_to_conversation',
    'create_account',
    'connect_account',
    'disconnect_account',
    'request_pairing_code',
    'extract_group_members',
    'create_campaign',
    'execute_campaign',
    'pause_campaign',
    'resume_campaign',
    'apply_suggested_stage_updates',
  ].includes(actionType);
}

function getContactRisk(contact: any) {
  if (!contact) return { blocked: false, warnings: [] as string[] };
  const tags = parseStringList(contact.tags).map((tag) => tag.toLowerCase());
  const consent = String(contact.consentStatus || '').toLowerCase();
  const warnings: string[] = [];
  let blocked = false;

  if (['opted_out', 'blocked', 'unsubscribed'].includes(consent)) {
    warnings.push('وضعیت consent این مخاطب اجازه تماس یا ارسال خودکار نمی‌دهد.');
    blocked = true;
  }
  if (tags.some((tag) => ['blocked', 'do_not_contact', 'blacklist'].includes(tag))) {
    warnings.push('این مخاطب در لیست عدم تماس یا بلاک قرار دارد.');
    blocked = true;
  }

  return { blocked, warnings };
}

export function previewAiGovernance(input: { type: string; params?: Record<string, unknown> }) {
  const actionType = String(input.type || '');
  const params = input.params || {};
  const dryRun = asBoolean(params.dryRun, false);
  const approved = asBoolean(params.approved, false);
  const warnings: Array<{ level: 'info' | 'warn' | 'critical'; message: string }> = [];
  const targetSummary: Record<string, unknown> = {};

  if (!isSensitiveAction(actionType)) {
    return {
      actionType,
      sensitive: false,
      dryRun,
      approved,
      approvalState: 'approved',
      requiresApproval: false,
      blocked: false,
      riskLevel: 'low',
      warnings,
      targetSummary,
    };
  }

  if (dryRun) {
    warnings.push({ level: 'info', message: 'این action در حالت dry-run اجرا می‌شود و mutation واقعی انجام نمی‌دهد.' });
  }

  if (actionType === 'reply_to_conversation') {
    const conversationId = String(params.conversationId || '');
    const conversation = conversationId ? db.select().from(conversations).where(eq(conversations.id, conversationId)).get() : null;
    const contact = conversation?.contactId ? db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get() : null;
    const contactRisk = getContactRisk(contact);
    targetSummary.conversationId = conversationId || null;
    targetSummary.contactId = conversation?.contactId || null;
    targetSummary.phone = contact?.phone || null;
    contactRisk.warnings.forEach((message) => warnings.push({ level: 'critical', message }));
  }

  if (actionType === 'create_campaign') {
    const contactIds = Array.isArray(params.contactIds) ? params.contactIds.map(String) : [];
    const accountIds = Array.isArray(params.accountIds) ? params.accountIds.map(String) : [];
    const messageTemplate = String(params.messageTemplate || '');
    const flaggedContacts = db.select().from(contacts).all().filter((contact: any) => contactIds.includes(contact.id)).filter((contact: any) => getContactRisk(contact).blocked);
    targetSummary.contactCount = contactIds.length;
    targetSummary.accountCount = accountIds.length;

    if (flaggedContacts.length > 0) {
      warnings.push({ level: 'critical', message: `${flaggedContacts.length} گیرنده در وضعیت do-not-contact یا بدون opt-in معتبر هستند.` });
    }
    if (contactIds.length >= 50) {
      warnings.push({ level: 'warn', message: 'حجم audience بالاست و قبل از ارسال باید approval انسانی انجام شود.' });
    }
    collectCampaignTextWarnings({ name: String(params.name || ''), messageTemplate }).forEach((warning) => {
      warnings.push({ level: 'warn', message: warning.message });
    });

    accountIds.forEach((accountId) => {
      const config = rateLimiter.getAccountDelayConfig(accountId);
      if (!config.enabled || config.minMs < 4000) {
        warnings.push({ level: 'warn', message: `delay config اکانت ${accountId} تهاجمی است و برای launch نیاز به review دارد.` });
      }
    });
  }

  if (actionType === 'execute_campaign' || actionType === 'pause_campaign' || actionType === 'resume_campaign') {
    const campaignId = String(params.campaignId || '');
    const campaign = campaignId ? db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get() : null;
    targetSummary.campaignId = campaignId || null;
    targetSummary.campaignName = campaign?.name || null;
    if (campaign) {
      const accountIds = parseStringList(campaign.accountIds);
      const contactIds = parseStringList(campaign.contactIds);
      const riskyContacts = db.select().from(contacts).all().filter((contact: any) => contactIds.includes(contact.id)).filter((contact: any) => getContactRisk(contact).blocked);
      if (riskyContacts.length > 0) {
        warnings.push({ level: 'critical', message: `${riskyContacts.length} گیرنده کمپین در وضعیت blocked/do-not-contact هستند.` });
      }
      if (contactIds.length >= 50) {
        warnings.push({ level: 'warn', message: 'کمپین audience بزرگی دارد و برای اجرا به approval انسانی نیاز دارد.' });
      }
      accountIds.forEach((accountId) => {
        const account = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, accountId)).get();
        const config = rateLimiter.getAccountDelayConfig(accountId);
        if (account?.warmUpProfileId) {
          warnings.push({ level: 'info', message: `اکانت ${accountId} در warm-up است و باید launch محافظه‌کارانه بماند.` });
        }
        if (!config.enabled || config.minMs < 4000) {
          warnings.push({ level: 'warn', message: `rate-limit اکانت ${accountId} برای launch تهاجمی است.` });
        }
      });
    }
  }

  if (actionType === 'create_account' || actionType === 'connect_account' || actionType === 'disconnect_account' || actionType === 'request_pairing_code' || actionType === 'extract_group_members') {
    warnings.push({ level: 'warn', message: 'این action روی اتصال، session یا data extraction اثر مستقیم دارد و approval انسانی می‌خواهد.' });
  }

  if (actionType === 'apply_suggested_stage_updates') {
    warnings.push({ level: 'warn', message: 'به‌روزرسانی stage برای چند لید به‌صورت batch است و باید بعد از preview تایید شود.' });
  }

  const blocked = warnings.some((warning) => warning.level === 'critical');
  const requiresApproval = !dryRun && (warnings.some((warning) => warning.level === 'warn') || isSensitiveAction(actionType));
  const approvalState = blocked ? 'blocked' : requiresApproval && !approved ? 'needs-approval' : 'approved';
  const riskLevel = blocked ? 'critical' : warnings.some((warning) => warning.level === 'warn') ? 'high' : dryRun ? 'low' : 'medium';

  return {
    actionType,
    sensitive: true,
    dryRun,
    approved,
    approvalState,
    requiresApproval,
    blocked,
    riskLevel,
    warnings,
    targetSummary,
  };
}

export function persistAiGovernanceLog(input: {
  actionType: string;
  params?: unknown;
  approvalState: string;
  requiresApproval: boolean;
  riskLevel: string;
  blocked: boolean;
  executed: boolean;
  warnings: unknown;
  targetSummary?: unknown;
}) {
  db.insert(aiGovernanceLogs).values({
    id: uuidv4(),
    actionType: input.actionType,
    actionParams: safeJsonStringify(input.params || {}),
    approvalState: input.approvalState,
    requiresApproval: input.requiresApproval ? 1 : 0,
    riskLevel: input.riskLevel,
    blocked: input.blocked ? 1 : 0,
    executed: input.executed ? 1 : 0,
    warnings: safeJsonStringify(input.warnings),
    targetSummary: safeJsonStringify(input.targetSummary || {}),
    createdAt: new Date().toISOString(),
  }).run();
}

export function listAiGovernanceLogs(limit = 50) {
  return db.select().from(aiGovernanceLogs).orderBy(desc(aiGovernanceLogs.createdAt)).all().slice(0, Math.max(1, Math.min(200, limit)));
}

export function getAiGovernanceOverview() {
  const logs = listAiGovernanceLogs(200);
  return {
    summary: {
      totalLogs: logs.length,
      blockedActions: logs.filter((item: any) => item.blocked === 1).length,
      approvalRequiredActions: logs.filter((item: any) => item.requiresApproval === 1).length,
      executedActions: logs.filter((item: any) => item.executed === 1).length,
      pendingHumanReview: logs.filter((item: any) => item.approvalState === 'needs-approval').length,
    },
    recentLogs: logs.slice(0, 20),
  };
}