import { desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database';
import { aiControlLogs, apiKeys, autoReplyLogs, autoReplyRules, campaigns, contactActivities, contacts, contactTasks, conversations, groups, messageLogs, networkDiagnostics, proxyProfiles, queueJobs, whatsappAccounts } from '../database/schema';
import { connectAccount, disconnectAccount, extractGroupMembers, getGroups, latestQrs, requestPairingCode, sendMessage } from '../modules/whatsapp/baileys.service';
import { appendCampaignEvent, getCampaignExecutionSnapshot } from './campaign.executor';
import { buildAnalyticsOptimizerOverview } from './analytics-optimizer.service';
import { getAiGovernanceOverview, persistAiGovernanceLog, previewAiGovernance } from './ai-governance.service';
import { getLeadScoringOverview } from './lead-scoring.service';
import { buildMarketingStrategistOverview } from './marketing-strategist.service';
import { getOperationalHealthOverview } from './operational-health.service';
import { logger } from '../utils/logger';
import { decryptSecret } from '../utils/secret-crypto';
import { collectCampaignTextWarnings } from '../utils/text-integrity';

type AIProvider = 'openai' | 'gemini' | 'claude';

type AIControlActionType =
  | 'health_overview'
  | 'list_accounts'
  | 'list_contacts'
  | 'get_contact_profile'
  | 'get_contact_activities'
  | 'list_contact_tasks'
  | 'create_contact_task'
  | 'complete_contact_task'
  | 'add_contact_note'
  | 'segment_contacts'
  | 'get_campaign_snapshot'
  | 'list_hot_leads'
  | 'recommend_campaign_contacts'
  | 'get_auto_reply_insights'
  | 'list_auto_reply_logs'
  | 'toggle_auto_reply_rule'
  | 'recommend_followups'
  | 'create_followup_task'
  | 'get_sales_pipeline_overview'
  | 'list_pipeline_contacts'
  | 'get_contact_next_best_action'
  | 'suggest_stage_updates'
  | 'set_contact_pipeline_stage'
  | 'preview_conversion_queue'
  | 'execute_contact_next_best_action'
  | 'create_conversion_campaign'
  | 'apply_suggested_stage_updates'
  | 'list_groups'
  | 'extract_group_members'
  | 'list_conversations'
  | 'get_conversation_messages'
  | 'reply_to_conversation'
  | 'list_auto_reply_rules'
  | 'create_account'
  | 'connect_account'
  | 'disconnect_account'
  | 'get_account_qr'
  | 'request_pairing_code'
  | 'assign_proxy_profile'
  | 'list_campaigns'
  | 'create_campaign'
  | 'design_campaign_agent_plan'
  | 'evaluate_campaign_launch'
  | 'create_campaign_followup'
  | 'review_campaign_kpis'
  | 'summarize_campaign_learnings'
  | 'execute_campaign'
  | 'pause_campaign'
  | 'resume_campaign';

interface AIControlAction {
  type: AIControlActionType | string;
  params?: Record<string, unknown>;
}

interface AIControlPlan {
  summary: string;
  actions: AIControlAction[];
}

interface AIControlExecutionResult {
  action: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function persistAiControlLog(input: {
  provider: AIProvider;
  model: string;
  instruction: string;
  planningMode: 'provider' | 'local-fallback';
  planSummary: string;
  actionType: string;
  actionParams?: unknown;
  success: boolean;
  error?: string | null;
  resultData?: unknown;
}) {
  try {
    db.insert(aiControlLogs).values({
      id: uuidv4(),
      provider: input.provider,
      model: input.model,
      instruction: input.instruction,
      planningMode: input.planningMode,
      planSummary: input.planSummary,
      actionType: input.actionType,
      actionParams: safeJsonStringify(input.actionParams || {}),
      success: input.success ? 1 : 0,
      error: input.error || null,
      resultData: safeJsonStringify(input.resultData ?? null),
      createdAt: new Date().toISOString(),
    }).run();
  } catch (error: any) {
    logger.warn(`Failed to persist AI control log: ${error.message}`);
  }
}

const AI_ACTION_CATALOG = [
  {
    type: 'health_overview',
    description: 'نمای کلی سلامت سیستم، اکانت‌ها، کمپین‌ها، پروکسی و شبکه را برمی‌گرداند.',
    params: {},
  },
  {
    type: 'list_accounts',
    description: 'لیست کامل اکانت‌های واتساپ را برمی‌گرداند.',
    params: {},
  },
  {
    type: 'list_contacts',
    description: 'لیست مخاطبین CRM را برمی‌گرداند.',
    params: {
      limit: 'number | optional',
      search: 'string | optional',
    },
  },
  {
    type: 'get_contact_profile',
    description: 'پروفایل کامل یک مخاطب شامل فعالیت‌ها، تسک‌ها، پیام‌ها و مکالمات را برمی‌گرداند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
    },
  },
  {
    type: 'get_contact_activities',
    description: 'فعالیت‌های یک مخاطب را برمی‌گرداند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
      limit: 'number | optional',
    },
  },
  {
    type: 'list_contact_tasks',
    description: 'تسک‌های CRM را برای همه یا یک مخاطب برمی‌گرداند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
      status: 'pending | in-progress | completed | optional',
      limit: 'number | optional',
    },
  },
  {
    type: 'create_contact_task',
    description: 'برای یک مخاطب تسک جدید می‌سازد و فعالیت مربوطه را ثبت می‌کند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
      title: 'string',
      description: 'string | optional',
      priority: 'low | medium | high | optional',
      dueDate: 'ISO date string | optional',
    },
  },
  {
    type: 'complete_contact_task',
    description: 'یک تسک CRM را تکمیل می‌کند و فعالیت مربوطه را ثبت می‌کند.',
    params: {
      taskId: 'string',
    },
  },
  {
    type: 'add_contact_note',
    description: 'یادداشت جدید به مخاطب اضافه می‌کند و در فعالیت‌ها ثبت می‌کند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
      note: 'string',
    },
  },
  {
    type: 'segment_contacts',
    description: 'مخاطبین را بر اساس tag، source، country یا activity فیلتر می‌کند.',
    params: {
      mode: 'tag | source | country | activity',
      value: 'string',
      limit: 'number | optional',
    },
  },
  {
    type: 'get_campaign_snapshot',
    description: 'نمای عمیق یک کمپین شامل پیشرفت، لاگ‌ها و breakdown اکانت‌ها را برمی‌گرداند.',
    params: {
      campaignId: 'string',
    },
  },
  {
    type: 'list_hot_leads',
    description: 'داغ‌ترین لیدها را بر اساس تعامل، فعالیت و پاسخ‌گویی برمی‌گرداند.',
    params: {
      limit: 'number | optional',
      minScore: 'number | optional',
    },
  },
  {
    type: 'recommend_campaign_contacts',
    description: 'برای یک هدف کمپینی، بهترین مخاطبین پیشنهادی را با دلیل انتخاب برمی‌گرداند.',
    params: {
      campaignId: 'string | optional',
      goal: 'engaged | reengage | warm | cold | optional',
      limit: 'number | optional',
      excludeExistingRecipients: 'boolean | optional',
    },
  },
  {
    type: 'get_auto_reply_insights',
    description: 'نمای تحلیلی از سلامت، پوشش و کیفیت auto-reply را برمی‌گرداند.',
    params: {},
  },
  {
    type: 'list_auto_reply_logs',
    description: 'لاگ‌های auto-reply را با فیلتر rule یا status برمی‌گرداند.',
    params: {
      ruleId: 'string | optional',
      status: 'sent | failed | optional',
      limit: 'number | optional',
    },
  },
  {
    type: 'toggle_auto_reply_rule',
    description: 'وضعیت فعال/غیرفعال یک قانون auto-reply را تغییر می‌دهد.',
    params: {
      ruleId: 'string',
      isActive: 'boolean',
    },
  },
  {
    type: 'recommend_followups',
    description: 'بهترین مخاطبین و مکالمات برای پیگیری فروش را با دلیل پیشنهاد می‌دهد.',
    params: {
      limit: 'number | optional',
      minScore: 'number | optional',
      status: 'open | pending | optional',
    },
  },
  {
    type: 'create_followup_task',
    description: 'برای پیگیری فروش یک تسک CRM از روی مخاطب یا مکالمه ایجاد می‌کند.',
    params: {
      contactId: 'string | optional',
      conversationId: 'string | optional',
      search: 'string | optional',
      title: 'string | optional',
      description: 'string | optional',
      priority: 'low | medium | high | optional',
      dueDate: 'ISO date string | optional',
    },
  },
  {
    type: 'get_sales_pipeline_overview',
    description: 'نمای کلی پایپ‌لاین فروش، مراحل مخاطبین و اکشن‌های پیشنهادی را برمی‌گرداند.',
    params: {},
  },
  {
    type: 'list_pipeline_contacts',
    description: 'لیست مخاطبین پایپ‌لاین فروش را با stage و score برمی‌گرداند.',
    params: {
      stage: 'cold | warm | qualified | opportunity | customer | optional',
      minScore: 'number | optional',
      limit: 'number | optional',
    },
  },
  {
    type: 'get_contact_next_best_action',
    description: 'بهترین اقدام بعدی فروش برای یک مخاطب را برمی‌گرداند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
    },
  },
  {
    type: 'suggest_stage_updates',
    description: 'اختلاف stage ذخیره‌شده و stage پیشنهادی AI را برای مخاطبین برمی‌گرداند.',
    params: {
      limit: 'number | optional',
    },
  },
  {
    type: 'set_contact_pipeline_stage',
    description: 'stage فروش یک مخاطب را داخل parsedData ذخیره می‌کند و activity ثبت می‌کند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
      stage: 'cold | warm | qualified | opportunity | customer',
      reason: 'string | optional',
    },
  },
  {
    type: 'preview_conversion_queue',
    description: 'صف اقدام‌های تبدیل را به‌صورت پیشنهادی و بدون اجرا برمی‌گرداند.',
    params: {
      limit: 'number | optional',
      minScore: 'number | optional',
    },
  },
  {
    type: 'execute_contact_next_best_action',
    description: 'اقدام بعدی یک مخاطب را به‌صورت کنترل‌شده اجرا یا dry-run می‌کند.',
    params: {
      contactId: 'string | optional',
      search: 'string | optional',
      dryRun: 'boolean | optional',
    },
  },
  {
    type: 'create_conversion_campaign',
    description: 'بر اساس stage/goal یک کمپین conversion/re-engagement می‌سازد یا dry-run می‌کند.',
    params: {
      stage: 'cold | warm | qualified | opportunity | customer | optional',
      goal: 'engaged | reengage | warm | cold | optional',
      limit: 'number | optional',
      name: 'string | optional',
      messageTemplate: 'string | optional',
      accountIds: 'string[] | optional',
      startNow: 'boolean | optional',
      dryRun: 'boolean | optional',
    },
  },
  {
    type: 'apply_suggested_stage_updates',
    description: 'stageهای پیشنهادی AI را به‌صورت گروهی apply یا dry-run می‌کند.',
    params: {
      limit: 'number | optional',
      dryRun: 'boolean | optional',
    },
  },
  {
    type: 'list_groups',
    description: 'گروه‌های یک اکانت را برمی‌گرداند.',
    params: { accountId: 'string' },
  },
  {
    type: 'extract_group_members',
    description: 'اعضای گروه را استخراج و داخل CRM ذخیره می‌کند.',
    params: { accountId: 'string', groupId: 'string' },
  },
  {
    type: 'list_conversations',
    description: 'لیست مکالمات اینباکس را برمی‌گرداند.',
    params: {
      status: 'open | closed | pending | optional',
      limit: 'number | optional',
    },
  },
  {
    type: 'get_conversation_messages',
    description: 'پیام‌های یک مکالمه را برمی‌گرداند.',
    params: { conversationId: 'string', limit: 'number | optional' },
  },
  {
    type: 'reply_to_conversation',
    description: 'به یک مکالمه اینباکس از طریق واتساپ پاسخ می‌دهد.',
    params: { conversationId: 'string', content: 'string' },
  },
  {
    type: 'list_auto_reply_rules',
    description: 'قوانین پاسخ‌گویی خودکار را برمی‌گرداند.',
    params: {
      accountId: 'string | optional',
      activeOnly: 'boolean | optional',
    },
  },
  {
    type: 'create_account',
    description: 'اکانت جدید می‌سازد. اگر customId داده شود همان شناسه استفاده می‌شود.',
    params: {
      displayName: 'string',
      phone: 'string | optional',
      customId: 'string | optional',
      proxyProfileId: 'string | optional',
      autoConnect: 'boolean | optional',
      pairingPhone: 'string | optional',
    },
  },
  {
    type: 'connect_account',
    description: 'یک اکانت را متصل می‌کند.',
    params: { accountId: 'string' },
  },
  {
    type: 'disconnect_account',
    description: 'یک اکانت را قطع می‌کند.',
    params: { accountId: 'string' },
  },
  {
    type: 'get_account_qr',
    description: 'آخرین QR اکانت را برمی‌گرداند.',
    params: { accountId: 'string' },
  },
  {
    type: 'request_pairing_code',
    description: 'برای اکانت موردنظر کد Pairing برمی‌گرداند.',
    params: { accountId: 'string', phoneNumber: 'string' },
  },
  {
    type: 'assign_proxy_profile',
    description: 'پروکسی یک اکانت را تنظیم می‌کند.',
    params: { accountId: 'string', proxyProfileId: 'string | null' },
  },
  {
    type: 'list_campaigns',
    description: 'لیست کمپین‌ها را برمی‌گرداند.',
    params: {},
  },
  {
    type: 'create_campaign',
    description: 'کمپین جدید می‌سازد و در صورت startNow آن را صف می‌کند.',
    params: {
      name: 'string',
      accountIds: 'string[]',
      contactIds: 'string[]',
      messageTemplate: 'string | optional',
      mediaPath: 'string | optional',
      scheduleType: 'immediate | scheduled | optional',
      scheduledAt: 'ISO date string | optional',
      maxPerHour: 'number | optional',
      maxPerDay: 'number | optional',
      delayMinMs: 'number | optional',
      delayMaxMs: 'number | optional',
      startNow: 'boolean | optional',
    },
  },
  {
    type: 'design_campaign_agent_plan',
    description: 'برای کمپین یک پلن حرفه‌ای شامل audience، offer، tone، variant، زمان‌بندی، توزیع اکانت و preflight می‌سازد.',
    params: {
      goal: 'engaged | reengage | warm | cold | optional',
      objective: 'string | optional',
      limit: 'number | optional',
      accountIds: 'string[] | optional',
      minScore: 'number | optional',
    },
  },
  {
    type: 'evaluate_campaign_launch',
    description: 'آمادگی launch یک کمپین موجود را با warm-up و rate-limit و preflight warnings ارزیابی می‌کند.',
    params: {
      campaignId: 'string',
    },
  },
  {
    type: 'create_campaign_followup',
    description: 'از روی یک کمپین پایه، follow-up پیشنهادی یا واقعی می‌سازد.',
    params: {
      campaignId: 'string',
      mode: 'failed | sent | all | optional',
      name: 'string | optional',
      messageTemplate: 'string | optional',
      scheduledAt: 'ISO date string | optional',
      startNow: 'boolean | optional',
      dryRun: 'boolean | optional',
    },
  },
  {
    type: 'review_campaign_kpis',
    description: 'برای کمپین بر اساس KPI و failure rate پیشنهاد pause، resume یا ادامه می‌دهد.',
    params: {
      campaignId: 'string',
    },
  },
  {
    type: 'summarize_campaign_learnings',
    description: 'خلاصه عملکرد، درس‌آموخته‌ها و پیشنهاد iteration بعدی کمپین را برمی‌گرداند.',
    params: {
      campaignId: 'string',
    },
  },
  {
    type: 'execute_campaign',
    description: 'یک کمپین موجود را در صف اجرا قرار می‌دهد.',
    params: { campaignId: 'string' },
  },
  {
    type: 'pause_campaign',
    description: 'کمپین در حال اجرا یا صف را pause می‌کند.',
    params: { campaignId: 'string' },
  },
  {
    type: 'resume_campaign',
    description: 'کمپین pause شده را دوباره در صف می‌گذارد.',
    params: { campaignId: 'string' },
  },
] as const;

function asArray(value: unknown) {
  return Array.isArray(value) ? value.filter(Boolean).map((item) => String(item)) : [];
}

function asOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asOptionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }

  return defaultValue;
}

function sanitizeCustomId(value: string | null) {
  if (!value) {
    return null;
  }

  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  return sanitized || null;
}

function normalizePhone(value: string | null) {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/[^\d+]/g, '');
  return normalized || null;
}

function parseStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((item) => String(item));
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter(Boolean).map((item) => String(item));
    }
  } catch {
    // Fallback to delimiter parsing below.
  }

  return value
    .split(/[;,،]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findContactReference(instruction: string, overview: ReturnType<typeof getAiControlOverview>) {
  const lowerInstruction = instruction.toLowerCase();
  const normalizedInstructionPhone = normalizePhone(instruction);

  return overview.contacts.find((contact: any) => {
    const id = String(contact.id || '').toLowerCase();
    const fullName = String(contact.fullName || '').toLowerCase();
    const phone = String(contact.phone || '').toLowerCase();
    const normalizedPhone = normalizePhone(contact.phone || null);

    return (id && lowerInstruction.includes(id))
      || (fullName && lowerInstruction.includes(fullName))
      || (phone && lowerInstruction.includes(phone))
      || (!!normalizedInstructionPhone && !!normalizedPhone && normalizedInstructionPhone.includes(normalizedPhone));
  }) || null;
}

function resolveContact(params: Record<string, unknown>, overview?: ReturnType<typeof getAiControlOverview>) {
  const contactId = asOptionalString(params.contactId);
  if (contactId) {
    const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
    if (!contact) {
      throw new Error('contact not found');
    }
    return contact;
  }

  const search = asOptionalString(params.search);
  if (search) {
    const lowerSearch = search.toLowerCase();
    const normalizedSearch = normalizePhone(search);
    const items = db.select().from(contacts).all();
    const matched = items.find((contact: any) => {
      const haystack = [contact.id, contact.fullName, contact.phone, contact.email, contact.tags, contact.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const normalizedPhone = normalizePhone(contact.phone || null);
      return haystack.includes(lowerSearch)
        || (!!normalizedSearch && !!normalizedPhone && normalizedPhone.includes(normalizedSearch));
    });

    if (!matched) {
      throw new Error('contact not found');
    }

    return matched;
  }

  if (overview?.contacts?.length === 1) {
    const onlyContactId = overview.contacts[0]?.id;
    if (onlyContactId) {
      const contact = db.select().from(contacts).where(eq(contacts.id, onlyContactId)).get();
      if (contact) {
        return contact;
      }
    }
  }

  throw new Error('contactId or search is required');
}

function buildContactProfile(contact: any) {
  const activities = db.select().from(contactActivities)
    .where(eq(contactActivities.contactId, contact.id))
    .orderBy(desc(contactActivities.createdAt))
    .all();
  const tasks = db.select().from(contactTasks)
    .where(eq(contactTasks.contactId, contact.id))
    .orderBy(desc(contactTasks.createdAt))
    .all();
  const relatedConversations = db.select().from(conversations)
    .where(eq(conversations.contactId, contact.id))
    .orderBy(desc(conversations.updatedAt))
    .all();
  const relatedMessages = db.select().from(messageLogs)
    .where(eq(messageLogs.contactId, contact.id))
    .orderBy(desc(messageLogs.createdAt))
    .all();

  return {
    ...contact,
    parsedTags: parseStringList(contact.tags),
    parsedSegments: parseStringList(contact.segments),
    stats: {
      totalActivities: activities.length,
      openTasks: tasks.filter((task: any) => task.status !== 'completed').length,
      completedTasks: tasks.filter((task: any) => task.status === 'completed').length,
      totalConversations: relatedConversations.length,
      totalMessages: relatedMessages.length,
      inboundMessages: relatedMessages.filter((item: any) => item.direction === 'inbound').length,
      outboundMessages: relatedMessages.filter((item: any) => item.direction === 'outbound').length,
      lastMessageAt: relatedMessages[0]?.createdAt || null,
      lastActivityAt: activities[0]?.createdAt || null,
    },
    recentActivities: activities.slice(0, 20),
    tasks: tasks.slice(0, 20),
    conversations: relatedConversations.slice(0, 10),
    recentMessages: relatedMessages.slice(0, 20).reverse(),
  };
}

function getDaysSince(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
}

function getContactCampaignStats(contactId: string) {
  const logs = db.select().from(messageLogs).all().filter((log: any) => log.contactId === contactId);
  const campaignLogs = logs.filter((log: any) => !!log.campaignId);
  const inboundMessages = logs.filter((log: any) => log.direction === 'inbound').length;
  const outboundMessages = logs.filter((log: any) => log.direction === 'outbound').length;
  const sentCampaignMessages = campaignLogs.filter((log: any) => log.status === 'sent').length;
  const failedCampaignMessages = campaignLogs.filter((log: any) => log.status === 'failed').length;
  const uniqueCampaignIds = Array.from(new Set(campaignLogs.map((log: any) => log.campaignId).filter(Boolean)));

  return {
    inboundMessages,
    outboundMessages,
    sentCampaignMessages,
    failedCampaignMessages,
    uniqueCampaignIds,
    totalMessages: logs.length,
    lastMessageAt: logs.length > 0 ? logs.sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0]?.createdAt || null : null,
  };
}

function scoreContactForCampaign(contact: any) {
  const tasks = db.select().from(contactTasks).where(eq(contactTasks.contactId, contact.id)).all();
  const activities = db.select().from(contactActivities).where(eq(contactActivities.contactId, contact.id)).all();
  const conversationsForContact = db.select().from(conversations).where(eq(conversations.contactId, contact.id)).all();
  const messageStats = getContactCampaignStats(contact.id);
  const daysSinceInteraction = getDaysSince(contact.lastInteraction || messageStats.lastMessageAt);
  const openTasks = tasks.filter((task: any) => task.status !== 'completed').length;
  const completedTasks = tasks.filter((task: any) => task.status === 'completed').length;
  const openConversations = conversationsForContact.filter((conversation: any) => conversation.status === 'open').length;
  const unreadMessages = conversationsForContact.reduce((sum: number, conversation: any) => sum + Number(conversation.unreadCount || 0), 0);

  let score = 0;
  const reasons: string[] = [];

  if (messageStats.inboundMessages > 0) {
    score += Math.min(35, messageStats.inboundMessages * 6);
    reasons.push(`دارای ${messageStats.inboundMessages} پیام ورودی`);
  }

  if (messageStats.sentCampaignMessages > 0) {
    score += Math.min(20, messageStats.sentCampaignMessages * 2);
    reasons.push(`تعامل کمپینی موفق: ${messageStats.sentCampaignMessages}`);
  }

  if (messageStats.failedCampaignMessages > 0) {
    score -= Math.min(18, messageStats.failedCampaignMessages * 6);
    reasons.push(`دارای شکست کمپینی: ${messageStats.failedCampaignMessages}`);
  }

  if (daysSinceInteraction !== null) {
    if (daysSinceInteraction <= 3) {
      score += 25;
      reasons.push('تعامل بسیار اخیر');
    } else if (daysSinceInteraction <= 7) {
      score += 18;
      reasons.push('تعامل اخیر');
    } else if (daysSinceInteraction <= 30) {
      score += 8;
      reasons.push('تعامل ماه اخیر');
    } else {
      score -= 10;
      reasons.push('تعامل قدیمی');
    }
  }

  if (openConversations > 0 || unreadMessages > 0) {
    score += 12;
    reasons.push('دارای مکالمه باز/خوانده‌نشده');
  }

  if (completedTasks > 0) {
    score += Math.min(10, completedTasks * 2);
    reasons.push(`پیگیری تکمیل‌شده: ${completedTasks}`);
  }

  if (openTasks > 0) {
    score += Math.min(8, openTasks * 2);
    reasons.push(`نیازمند پیگیری باز: ${openTasks}`);
  }

  const tags = parseStringList(contact.tags).map((tag) => tag.toLowerCase());
  if (tags.some((tag) => ['vip', 'lead', 'customer', 'buyer'].includes(tag))) {
    score += 10;
    reasons.push('دارای تگ ارزشمند');
  }

  if ((contact.notes || '').trim()) {
    score += 4;
    reasons.push('دارای یادداشت CRM');
  }

  if (activities.length >= 3) {
    score += 6;
    reasons.push('دارای سابقه فعالیت CRM');
  }

  return {
    contactId: contact.id,
    fullName: contact.fullName,
    phone: contact.phone,
    source: contact.source,
    score,
    reasons,
    lastInteraction: contact.lastInteraction || messageStats.lastMessageAt || null,
    stats: {
      inboundMessages: messageStats.inboundMessages,
      outboundMessages: messageStats.outboundMessages,
      sentCampaignMessages: messageStats.sentCampaignMessages,
      failedCampaignMessages: messageStats.failedCampaignMessages,
      openTasks,
      completedTasks,
      openConversations,
      unreadMessages,
      campaignCount: messageStats.uniqueCampaignIds.length,
      daysSinceInteraction,
    },
  };
}

function rankContactsForGoal(goal: string, items: Array<ReturnType<typeof scoreContactForCampaign>>) {
  const normalizedGoal = goal.trim().toLowerCase();

  return items
    .map((item) => {
      let adjustedScore = item.score;
      const reasons = [...item.reasons];

      if (normalizedGoal === 'reengage') {
        if (item.stats.daysSinceInteraction !== null && item.stats.daysSinceInteraction > 30) {
          adjustedScore += 20;
          reasons.push('مناسب برای re-engagement');
        }
        if (item.stats.failedCampaignMessages > 0) {
          adjustedScore -= 12;
        }
      }

      if (normalizedGoal === 'engaged') {
        adjustedScore += item.stats.inboundMessages * 2 + item.stats.openConversations * 3;
        reasons.push('اولویت برای مخاطب engaged');
      }

      if (normalizedGoal === 'warm') {
        if (item.stats.daysSinceInteraction !== null && item.stats.daysSinceInteraction <= 30) {
          adjustedScore += 12;
          reasons.push('مناسب برای لید warm');
        }
      }

      if (normalizedGoal === 'cold') {
        if (item.stats.inboundMessages === 0 && (item.stats.daysSinceInteraction === null || item.stats.daysSinceInteraction > 30)) {
          adjustedScore += 10;
          reasons.push('مناسب برای cold outreach');
        }
      }

      return {
        ...item,
        score: adjustedScore,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function getLatestMessageStatsForConversation(conversationId: string, contactId: string | null) {
  const logs = db.select().from(messageLogs).all()
    .filter((log: any) => log.conversationId === conversationId || (!!contactId && log.contactId === contactId))
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const latestInbound = logs.find((log: any) => log.direction === 'inbound') || null;
  const latestOutbound = logs.find((log: any) => log.direction === 'outbound') || null;

  return {
    totalMessages: logs.length,
    inboundCount: logs.filter((log: any) => log.direction === 'inbound').length,
    outboundCount: logs.filter((log: any) => log.direction === 'outbound').length,
    latestInboundAt: latestInbound?.createdAt || null,
    latestOutboundAt: latestOutbound?.createdAt || null,
    latestInboundText: latestInbound?.content || null,
    latestOutboundText: latestOutbound?.content || null,
  };
}

function scoreFollowupCandidate(conversation: any) {
  if (!conversation.contactId) {
    return null;
  }

  const contact = db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get();
  if (!contact) {
    return null;
  }

  const tasks = db.select().from(contactTasks).where(eq(contactTasks.contactId, contact.id)).all();
  const messageStats = getLatestMessageStatsForConversation(conversation.id, contact.id);
  const daysSinceConversation = getDaysSince(conversation.lastMessageAt || contact.lastInteraction);
  const pendingTasks = tasks.filter((task: any) => task.status !== 'completed').length;
  const followupTasks = tasks.filter((task: any) => /پیگیری|follow.?up|sales/i.test(String(task.title || '')) && task.status !== 'completed').length;
  const reasons: string[] = [];
  let score = 0;

  if (conversation.status === 'pending') {
    score += 24;
    reasons.push('مکالمه در وضعیت pending است');
  }

  if (Number(conversation.unreadCount || 0) > 0) {
    score += Math.min(25, Number(conversation.unreadCount || 0) * 6);
    reasons.push(`دارای ${conversation.unreadCount} پیام خوانده‌نشده`);
  }

  if (messageStats.latestInboundAt && (!messageStats.latestOutboundAt || new Date(messageStats.latestInboundAt).getTime() > new Date(messageStats.latestOutboundAt).getTime())) {
    score += 20;
    reasons.push('آخرین پیام از سمت مخاطب بوده است');
  }

  if (daysSinceConversation !== null) {
    if (daysSinceConversation >= 1 && daysSinceConversation <= 3) {
      score += 14;
      reasons.push('زمان مناسب برای follow-up نزدیک است');
    } else if (daysSinceConversation > 3 && daysSinceConversation <= 14) {
      score += 20;
      reasons.push('پیگیری فروش به تعویق افتاده');
    } else if (daysSinceConversation > 14) {
      score += 10;
      reasons.push('مکالمه قدیمی نیازمند احیا است');
    }
  }

  if (pendingTasks > 0) {
    score += Math.min(10, pendingTasks * 2);
    reasons.push(`دارای ${pendingTasks} تسک باز CRM`);
  }

  if (followupTasks > 0) {
    score -= 8;
    reasons.push('برای این مخاطب قبلاً تسک پیگیری باز وجود دارد');
  }

  const tags = parseStringList(contact.tags).map((tag) => tag.toLowerCase());
  if (tags.some((tag) => ['vip', 'lead', 'customer', 'buyer'].includes(tag))) {
    score += 8;
    reasons.push('دارای تگ فروش/ارزشمند');
  }

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    fullName: contact.fullName,
    phone: contact.phone,
    conversationStatus: conversation.status,
    unreadCount: conversation.unreadCount,
    score,
    reasons,
    lastMessageAt: conversation.lastMessageAt,
    latestInboundText: messageStats.latestInboundText,
    latestOutboundText: messageStats.latestOutboundText,
  };
}

function buildAutoReplyInsights() {
  const rules = db.select().from(autoReplyRules).all();
  const logs = db.select().from(autoReplyLogs).orderBy(desc(autoReplyLogs.createdAt)).all();
  const recentLogs = logs.slice(0, 100);
  const failedLogs = recentLogs.filter((log: any) => String(log.status || '').toLowerCase() === 'failed');
  const sentLogs = recentLogs.filter((log: any) => String(log.status || '').toLowerCase() === 'sent');
  const logsByRule = new Map<string, any[]>();

  recentLogs.forEach((log: any) => {
    const ruleId = String(log.ruleId || 'unknown');
    if (!logsByRule.has(ruleId)) {
      logsByRule.set(ruleId, []);
    }
    logsByRule.get(ruleId)?.push(log);
  });

  return {
    summary: {
      totalRules: rules.length,
      activeRules: rules.filter((rule: any) => rule.isActive === 1).length,
      totalRecentLogs: recentLogs.length,
      failedRecentLogs: failedLogs.length,
      sentRecentLogs: sentLogs.length,
      successRate: recentLogs.length > 0 ? Number(((sentLogs.length / recentLogs.length) * 100).toFixed(1)) : null,
    },
    topFailingRules: rules.map((rule: any) => {
      const ruleLogs = logsByRule.get(String(rule.id)) || [];
      const failureCount = ruleLogs.filter((log: any) => String(log.status || '').toLowerCase() === 'failed').length;
      return {
        ruleId: rule.id,
        name: rule.name,
        accountId: rule.accountId,
        triggerType: rule.triggerType,
        isActive: rule.isActive,
        failureCount,
      };
    }).sort((a, b) => b.failureCount - a.failureCount).slice(0, 10),
    recentLogs: recentLogs.slice(0, 20),
  };
}

function parseJsonRecord(value: unknown) {
  if (!value || typeof value !== 'string') {
    return {} as Record<string, any>;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {} as Record<string, any>;
  }
}

function getStoredPipelineStage(contact: any) {
  const parsedData = parseJsonRecord(contact?.parsedData);
  const stage = String(parsedData?.aiPipeline?.stage || '').trim().toLowerCase();
  return ['cold', 'warm', 'qualified', 'opportunity', 'customer'].includes(stage) ? stage : null;
}

function inferPipelineStage(contact: any) {
  const storedStage = getStoredPipelineStage(contact);
  if (storedStage) {
    return storedStage;
  }

  const leadScore = scoreContactForCampaign(contact);
  const conversationsForContact = db.select().from(conversations).where(eq(conversations.contactId, contact.id)).all();
  const hasPendingConversation = conversationsForContact.some((conversation: any) => conversation.status === 'pending');
  const hasOpenConversation = conversationsForContact.some((conversation: any) => conversation.status === 'open');
  const tags = parseStringList(contact.tags).map((tag) => tag.toLowerCase());

  if (tags.some((tag) => ['customer', 'buyer'].includes(tag))) {
    return 'customer';
  }

  if (hasPendingConversation || leadScore.stats.inboundMessages >= 3 || leadScore.score >= 65) {
    return 'opportunity';
  }

  if (hasOpenConversation || leadScore.score >= 40) {
    return 'qualified';
  }

  if (leadScore.score >= 18 || (leadScore.stats.daysSinceInteraction !== null && leadScore.stats.daysSinceInteraction <= 30)) {
    return 'warm';
  }

  return 'cold';
}

function getNextBestActionForContact(contact: any) {
  const leadScore = scoreContactForCampaign(contact);
  const stage = inferPipelineStage(contact);
  const openConversations = db.select().from(conversations).where(eq(conversations.contactId, contact.id)).all();
  const latestConversation = openConversations.sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())[0] || null;
  const openTasks = db.select().from(contactTasks).where(eq(contactTasks.contactId, contact.id)).all().filter((task: any) => task.status !== 'completed');
  const latestMessageAt = leadScore.lastInteraction;
  const daysSinceInteraction = leadScore.stats.daysSinceInteraction;

  if (latestConversation && Number(latestConversation.unreadCount || 0) > 0) {
    return {
      type: 'reply_to_conversation',
      priority: 'high',
      reason: 'مخاطب پیام خوانده‌نشده دارد و نیاز به پاسخ فوری دارد',
      payload: { conversationId: latestConversation.id },
      stage,
    };
  }

  if (stage === 'opportunity' && openTasks.length === 0) {
    return {
      type: 'create_followup_task',
      priority: 'high',
      reason: 'مخاطب در مرحله فرصت فروش است و تسک پیگیری باز ندارد',
      payload: { contactId: contact.id, title: 'پیگیری فرصت فروش' },
      stage,
    };
  }

  if (stage === 'qualified' && (daysSinceInteraction === null || daysSinceInteraction >= 3)) {
    return {
      type: 'create_followup_task',
      priority: 'medium',
      reason: 'مخاطب qualified است و زمان پیگیری رسیده است',
      payload: { contactId: contact.id, title: 'پیگیری لید qualified' },
      stage,
    };
  }

  if (stage === 'warm' && (daysSinceInteraction === null || daysSinceInteraction > 14)) {
    return {
      type: 'recommend_campaign_contacts',
      priority: 'medium',
      reason: 'مخاطب warm است و برای re-engagement مناسب است',
      payload: { goal: 'reengage', contactId: contact.id },
      stage,
    };
  }

  if (stage === 'cold') {
    return {
      type: 'recommend_campaign_contacts',
      priority: 'low',
      reason: 'مخاطب cold است و بهتر است ابتدا با کمپین گرم شود',
      payload: { goal: 'cold', contactId: contact.id },
      stage,
    };
  }

  return {
    type: 'monitor_contact',
    priority: 'low',
    reason: latestMessageAt ? 'در حال حاضر اقدام فوری لازم نیست، فقط مانیتور شود' : 'مخاطب داده کافی برای اقدام فوری ندارد',
    payload: { contactId: contact.id },
    stage,
  };
}

function buildPipelineContactEntry(contact: any) {
  const leadScore = scoreContactForCampaign(contact);
  const storedStage = getStoredPipelineStage(contact);
  const inferredStage = inferPipelineStage(contact);
  const nextBestAction = getNextBestActionForContact(contact);

  return {
    contactId: contact.id,
    fullName: contact.fullName,
    phone: contact.phone,
    source: contact.source,
    score: leadScore.score,
    reasons: leadScore.reasons,
    storedStage,
    inferredStage,
    effectiveStage: inferredStage,
    nextBestAction,
    lastInteraction: leadScore.lastInteraction,
    stats: leadScore.stats,
  };
}

function buildSalesPipelineOverview() {
  const items = db.select().from(contacts).all().map((contact: any) => buildPipelineContactEntry(contact));
  const stageBuckets = {
    cold: 0,
    warm: 0,
    qualified: 0,
    opportunity: 0,
    customer: 0,
  } as Record<string, number>;

  items.forEach((item) => {
    stageBuckets[item.effectiveStage] = (stageBuckets[item.effectiveStage] || 0) + 1;
  });

  const stageDrift = items.filter((item) => item.storedStage && item.storedStage !== item.inferredStage);

  return {
    summary: {
      totalContacts: items.length,
      cold: stageBuckets.cold,
      warm: stageBuckets.warm,
      qualified: stageBuckets.qualified,
      opportunity: stageBuckets.opportunity,
      customer: stageBuckets.customer,
      stageDriftCount: stageDrift.length,
      highPriorityActions: items.filter((item) => item.nextBestAction.priority === 'high').length,
    },
    stageBreakdown: stageBuckets,
    topPipelineContacts: items.sort((a, b) => b.score - a.score).slice(0, 20),
    stageDrift: stageDrift.slice(0, 20),
  };
}

function persistPipelineStage(contact: any, stage: string, reason: string | null) {
  const parsedData = parseJsonRecord(contact.parsedData);
  const updatedParsedData = {
    ...parsedData,
    aiPipeline: {
      ...(parsedData.aiPipeline || {}),
      stage,
      reason: reason || null,
      updatedAt: new Date().toISOString(),
    },
  };

  db.update(contacts).set({
    parsedData: safeJsonStringify(updatedParsedData),
    updatedAt: new Date().toISOString(),
  }).where(eq(contacts.id, contact.id)).run();

  db.insert(contactActivities).values({
    id: uuidv4(),
    contactId: contact.id,
    action: 'مرحله فروش بروزرسانی شد',
    description: `AI مرحله فروش مخاطب را روی ${stage} تنظیم کرد`,
    details: reason || null,
    type: 'pipeline_stage_updated',
    activityData: safeJsonStringify({ stage, reason: reason || null }),
    createdAt: new Date().toISOString(),
  }).run();

  return {
    ...updatedParsedData.aiPipeline,
    contactId: contact.id,
  };
}

function getDefaultCampaignAccountIds() {
  const accounts = db.select().from(whatsappAccounts).all();
  const connected = accounts.filter((account: any) => account.status === 'connected').map((account: any) => String(account.id));
  if (connected.length > 0) {
    return connected;
  }

  return accounts.map((account: any) => String(account.id)).filter(Boolean);
}

function createFollowupTaskRecord(input: {
  contact: any;
  conversation?: any | null;
  title?: string | null;
  description?: string | null;
  priority?: string | null;
  dueDate?: string | null;
}) {
  const priority = input.priority || 'high';
  if (!['low', 'medium', 'high'].includes(priority)) {
    throw new Error('priority must be low, medium or high');
  }

  const task = {
    id: uuidv4(),
    contactId: input.contact.id,
    title: input.title || 'پیگیری فروش',
    description: input.description || (input.conversation
      ? `پیگیری مکالمه ${input.conversation.id} برای ${input.contact.fullName || input.contact.phone}`
      : `پیگیری فروش برای ${input.contact.fullName || input.contact.phone}`),
    priority,
    status: 'pending',
    dueDate: input.dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  db.insert(contactTasks).values(task).run();
  db.insert(contactActivities).values({
    id: uuidv4(),
    contactId: input.contact.id,
    action: 'تسک پیگیری اضافه شد',
    description: `AI تسک پیگیری «${task.title}» را ثبت کرد`,
    details: input.conversation ? `conversationId: ${input.conversation.id}` : null,
    type: 'followup_task_added',
    activityData: safeJsonStringify({ conversationId: input.conversation?.id || null, dueDate: task.dueDate, priority: task.priority }),
    createdAt: new Date().toISOString(),
  }).run();

  if (input.conversation?.id) {
    db.update(conversations).set({ status: 'pending', updatedAt: new Date().toISOString() }).where(eq(conversations.id, input.conversation.id)).run();
  }

  return {
    ...task,
    conversationId: input.conversation?.id || null,
  };
}

function buildConversionQueue(limit: number, minScore: number) {
  return db.select().from(contacts).all()
    .map((contact: any) => {
      const pipelineEntry = buildPipelineContactEntry(contact);
      return {
        contactId: pipelineEntry.contactId,
        fullName: pipelineEntry.fullName,
        phone: pipelineEntry.phone,
        score: pipelineEntry.score,
        stage: pipelineEntry.effectiveStage,
        nextBestAction: pipelineEntry.nextBestAction,
        reasons: pipelineEntry.reasons.slice(0, 4),
      };
    })
    .filter((item) => item.score >= minScore)
    .sort((a, b) => {
      const priorityWeight = { high: 3, medium: 2, low: 1 } as Record<string, number>;
      const diff = (priorityWeight[b.nextBestAction.priority] || 0) - (priorityWeight[a.nextBestAction.priority] || 0);
      return diff !== 0 ? diff : b.score - a.score;
    })
    .slice(0, limit);
}

function executeNextBestActionForContact(contact: any, dryRun: boolean) {
  const nextBestAction = getNextBestActionForContact(contact);
  const inferredStage = inferPipelineStage(contact);

  if (dryRun) {
    return {
      dryRun: true,
      contactId: contact.id,
      stage: inferredStage,
      nextBestAction,
    };
  }

  if (nextBestAction.type === 'create_followup_task') {
    return {
      dryRun: false,
      executedAction: 'create_followup_task',
      result: createFollowupTaskRecord({
        contact,
        title: asOptionalString(nextBestAction.payload?.title) || 'پیگیری تبدیل',
      }),
      nextBestAction,
    };
  }

  if (nextBestAction.type === 'reply_to_conversation') {
    const conversationId = asOptionalString(nextBestAction.payload?.conversationId);
    const conversation = conversationId
      ? db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
      : null;

    return {
      dryRun: false,
      executedAction: 'create_followup_task',
      result: createFollowupTaskRecord({
        contact,
        conversation,
        title: 'بررسی و پاسخ به مکالمه',
        description: 'AI تشخیص داد که این مکالمه نیازمند بررسی و پاسخ انسانی/عملیاتی است.',
      }),
      nextBestAction,
    };
  }

  if (nextBestAction.type === 'recommend_campaign_contacts') {
    const promotedStage = inferredStage === 'cold' ? 'warm' : inferredStage;
    return {
      dryRun: false,
      executedAction: 'set_contact_pipeline_stage',
      result: persistPipelineStage(contact, promotedStage, 'AI next-best-action promoted pipeline stage for conversion readiness'),
      nextBestAction,
    };
  }

  return {
    dryRun: false,
    executedAction: 'monitor_contact',
    result: {
      contactId: contact.id,
      message: 'No immediate automated action was executed for this contact.',
    },
    nextBestAction,
  };
}

function createConversionCampaignDraft(input: {
  stage?: string | null;
  goal?: string | null;
  limit: number;
  name?: string | null;
  messageTemplate?: string | null;
  accountIds?: string[];
  startNow: boolean;
  dryRun: boolean;
}) {
  const goal = input.goal || 'reengage';
  const ranked = rankContactsForGoal(goal, db.select().from(contacts).all().map((contact: any) => scoreContactForCampaign(contact)));
  let candidates = ranked.map((item) => {
    const contact = db.select().from(contacts).where(eq(contacts.id, item.contactId)).get();
    const effectiveStage = contact ? inferPipelineStage(contact) : null;
    return {
      ...item,
      effectiveStage,
    };
  });

  if (input.stage) {
    candidates = candidates.filter((item) => item.effectiveStage === input.stage);
  }

  const selected = candidates.slice(0, input.limit);
  const accountIds = (input.accountIds && input.accountIds.length > 0 ? input.accountIds : getDefaultCampaignAccountIds()).filter(Boolean);
  const messageTemplate = input.messageTemplate
    || (goal === 'reengage'
      ? 'سلام {{firstName}}، مدتی از آخرین گفت‌وگوی ما گذشته. اگر هنوز مایل باشید خوشحال می‌شویم ادامه دهیم.'
      : goal === 'warm'
        ? 'سلام {{firstName}}، خواستم پیگیری کنم اگر سوالی دارید با کمال میل در خدمت هستیم.'
        : 'سلام {{firstName}}، خوشحال می‌شویم بیشتر با شما آشنا شویم و ببینیم چگونه می‌توانیم کمک کنیم.');
  const name = input.name || `AI Conversion ${goal} ${new Date().toISOString().slice(0, 10)}`;

  const payload = {
    name,
    accountIds,
    contactIds: selected.map((item) => item.contactId),
    goal,
    stage: input.stage || null,
    messageTemplate,
    selectedContacts: selected,
    startNow: input.startNow,
  };

  if (input.dryRun) {
    return {
      dryRun: true,
      ...payload,
    };
  }

  if (accountIds.length === 0) {
    throw new Error('No WhatsApp account available for conversion campaign');
  }

  if (payload.contactIds.length === 0) {
    throw new Error('No contacts matched the conversion campaign criteria');
  }

  const warnings = collectCampaignTextWarnings({ name, messageTemplate });
  const id = uuidv4();
  db.insert(campaigns).values({
    id,
    name,
    accountIds: JSON.stringify(accountIds),
    contactIds: JSON.stringify(payload.contactIds),
    segmentId: null,
    messageTemplate,
    mediaPath: null,
    scheduleType: 'immediate',
    scheduledAt: null,
    maxPerHour: null,
    maxPerDay: null,
    delayMinMs: null,
    delayMaxMs: null,
    status: 'draft',
    createdAt: new Date().toISOString(),
  }).run();

  let queueResult: Record<string, unknown> | null = null;
  if (input.startNow) {
    queueResult = queueCampaign(id, accountIds);
  }

  return {
    dryRun: false,
    id,
    ...payload,
    warnings,
    queueResult,
    status: queueResult?.status || 'draft',
  };
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return withoutFence.slice(firstBrace, lastBrace + 1);
  }

  return withoutFence;
}

function normalizeActionType(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

async function getProviderApiKey(provider: string) {
  const record = db.select().from(apiKeys).where(eq(apiKeys.provider, provider)).get();

  if (!record?.apiKey) {
    throw new Error(`No API key configured for ${provider}`);
  }

  return decryptSecret(record.apiKey);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Provider request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callAiProvider(provider: AIProvider, model: string, prompt: string) {
  const apiKey = await getProviderApiKey(provider);

  if (provider === 'openai') {
    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a safe JSON-only automation planner for a WhatsApp CRM app. Always return valid JSON only.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI planning failed: ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'claude') {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system: 'You are a safe JSON-only automation planner for a WhatsApp CRM app. Always return valid JSON only.',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude planning failed: ${errorText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini planning failed: ${errorText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function getQueueJobsForCampaign(campaignId: string) {
  return db.select().from(queueJobs).all().filter((job: any) => {
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

function queueCampaign(campaignId: string, accountIds: string[]) {
  if (!accountIds.length) {
    throw new Error('Campaign must have at least one execution account.');
  }

  const jobId = uuidv4();
  db.insert(queueJobs).values({
    id: jobId,
    type: 'campaign_execution',
    status: 'pending',
    priority: 1,
    payload: JSON.stringify({ campaignId, accountId: accountIds[0], accountIds }),
    createdAt: new Date().toISOString(),
  }).run();

  db.update(campaigns)
    .set({
      status: 'queued',
      completedAt: null,
    })
    .where(eq(campaigns.id, campaignId))
    .run();

  appendCampaignEvent({
    campaignId,
    level: 'info',
    eventType: 'queued-by-ai',
    message: `Campaign queued by AI control with ${accountIds.length} account(s).`,
    payload: { jobId, accountIds },
  });

  return { jobId, status: 'queued' };
}

function pauseCampaign(campaignId: string) {
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  if (!['queued', 'in-progress'].includes(campaign.status || '')) {
    throw new Error('Only queued or in-progress campaigns can be paused');
  }

  db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, campaignId)).run();

  const relatedJobs = getQueueJobsForCampaign(campaignId);
  relatedJobs
    .filter((job: any) => ['pending', 'retry'].includes(job.status))
    .forEach((job: any) => {
      db.update(queueJobs)
        .set({
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          errorMessage: 'Paused by AI control before execution started',
        })
        .where(eq(queueJobs.id, job.id))
        .run();
    });

  appendCampaignEvent({
    campaignId,
    level: 'warn',
    eventType: 'paused-by-ai',
    message: 'Campaign paused by AI control.',
    payload: { relatedJobs: relatedJobs.map((job: any) => ({ id: job.id, status: job.status })) },
  });

  return { status: 'paused', cancelledJobs: relatedJobs.length };
}

function resumeCampaign(campaignId: string) {
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  if (campaign.status !== 'paused') {
    throw new Error('Only paused campaigns can be resumed');
  }

  let accountIds: string[] = [];
  try {
    const parsed = JSON.parse(campaign.accountIds || '[]');
    accountIds = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    accountIds = [];
  }

  return queueCampaign(campaignId, accountIds);
}

function getAccountRecentUsage(accountId: string) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const outboundLogs = db.select().from(messageLogs).all().filter((log: any) => {
    if (log.whatsappAccountId !== accountId || log.direction !== 'outbound' || !log.createdAt) {
      return false;
    }

    const createdAt = new Date(log.createdAt).getTime();
    return Number.isFinite(createdAt);
  });

  return {
    lastHour: outboundLogs.filter((log: any) => new Date(log.createdAt).getTime() >= oneHourAgo).length,
    lastDay: outboundLogs.filter((log: any) => new Date(log.createdAt).getTime() >= oneDayAgo).length,
  };
}

function inferCampaignGoal(goal: string | null, objective: string | null) {
  if (goal) {
    return goal;
  }

  const normalized = String(objective || '').toLowerCase();
  if (/reengage|بازگشت|inactive|سرد/.test(normalized)) return 'reengage';
  if (/warm|qualified|demo|مشاوره|گرم/.test(normalized)) return 'warm';
  if (/cold|new|prospect|اولیه/.test(normalized)) return 'cold';
  return 'engaged';
}

function buildCampaignAudienceRecommendation(input: {
  goal: string;
  limit: number;
  minScore: number;
  excludeContactIds?: string[];
}) {
  const excludedContactIds = new Set((input.excludeContactIds || []).filter(Boolean));
  const contactMap = new Map(db.select().from(contacts).all().map((contact: any) => [contact.id, contact]));
  const ranked = rankContactsForGoal(
    input.goal,
    db.select().from(contacts).all().map((contact: any) => scoreContactForCampaign(contact)),
  )
    .filter((item) => item.score >= input.minScore && !excludedContactIds.has(item.contactId))
    .slice(0, input.limit);

  const tagCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();

  ranked.forEach((item) => {
    const contact = contactMap.get(item.contactId);
    parseStringList(contact?.tags).forEach((tag) => {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    });

    const source = item.source || 'manual';
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  });

  const topTag = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1])[0] || null;
  const topSource = Array.from(sourceCounts.entries()).sort((a, b) => b[1] - a[1])[0] || null;

  return {
    goal: input.goal,
    totalSelected: ranked.length,
    suggestedSegment: topTag ? { tag: topTag[0], count: topTag[1] } : null,
    suggestedSource: topSource ? { source: topSource[0], count: topSource[1] } : null,
    contacts: ranked.map((item) => ({
      contactId: item.contactId,
      fullName: item.fullName || null,
      phone: item.phone || null,
      score: item.score,
      reasons: item.reasons,
      stage: buildPipelineContactEntry(contactMap.get(item.contactId) || {}).inferredStage || null,
      source: item.source || null,
      tags: parseStringList(contactMap.get(item.contactId)?.tags),
    })),
  };
}

function buildCampaignAccountDistribution(accountIds?: string[]) {
  const availableAccounts = db.select().from(whatsappAccounts).all();
  const requestedIds = (accountIds && accountIds.length > 0 ? accountIds : getDefaultCampaignAccountIds()).filter(Boolean);
  const uniqueRequestedIds = Array.from(new Set(requestedIds));

  const breakdown = uniqueRequestedIds.map((accountId) => {
    const account = availableAccounts.find((item: any) => item.id === accountId) || null;
    const usage = getAccountRecentUsage(accountId);
    const isConnected = account?.status === 'connected';
    const recommendedMaxPerHour = Math.max(6, Math.min(30, (account?.warmUpProfileId ? 12 : 24) - usage.lastHour));
    const recommendedMaxPerDay = Math.max(20, Math.min(180, (account?.warmUpProfileId ? 70 : 120) - usage.lastDay));
    const healthScore = Math.max(0, (isConnected ? 100 : 30) - usage.lastHour * 4 - Math.floor(usage.lastDay / 10) * 2);

    return {
      accountId,
      displayName: account?.displayName || account?.phoneNumber || accountId,
      status: account?.status || 'missing',
      warmUpProfileId: account?.warmUpProfileId || null,
      recentUsage: usage,
      recommendedMaxPerHour,
      recommendedMaxPerDay,
      healthScore,
      eligibleForLaunch: isConnected,
    };
  }).sort((a, b) => b.healthScore - a.healthScore);

  const selectedAccounts = breakdown.filter((item) => item.eligibleForLaunch);
  const selected = (selectedAccounts.length > 0 ? selectedAccounts : breakdown).map((item) => item.accountId);
  const totalWeight = (selectedAccounts.length > 0 ? selectedAccounts : breakdown).reduce((sum, item) => sum + Math.max(1, item.healthScore), 0) || 1;

  return {
    selectedAccountIds: selected,
    blockedAccountIds: breakdown.filter((item) => !item.eligibleForLaunch).map((item) => item.accountId),
    distribution: (selectedAccounts.length > 0 ? selectedAccounts : breakdown).map((item) => ({
      accountId: item.accountId,
      sharePercent: Math.round((Math.max(1, item.healthScore) / totalWeight) * 100),
    })),
    recommendedDelayMinMs: selected.length > 1 ? 12000 : 18000,
    recommendedDelayMaxMs: selected.length > 1 ? 40000 : 55000,
    recommendedMaxPerHour: (selectedAccounts.length > 0 ? selectedAccounts : breakdown).reduce((sum, item) => sum + item.recommendedMaxPerHour, 0),
    recommendedMaxPerDay: (selectedAccounts.length > 0 ? selectedAccounts : breakdown).reduce((sum, item) => sum + item.recommendedMaxPerDay, 0),
    breakdown,
  };
}

function buildCampaignMessageVariants(input: {
  goal: string;
  objective: string | null;
  tone: string;
  offer: string;
}) {
  const objectiveSuffix = input.objective ? ` ${input.objective}` : '';

  return [
    {
      id: 'soft-value',
      tone: input.tone,
      angle: 'ارزش‌آفرینی ملایم',
      messageTemplate: `سلام {{name}}، وقت بخیر. ${input.offer} اگر مایل باشید${objectiveSuffix} خوشحال می‌شوم خیلی کوتاه توضیح بدهم.`,
    },
    {
      id: 'direct-offer',
      tone: 'مستقیم و واضح',
      angle: 'دعوت مستقیم',
      messageTemplate: `سلام {{name}}، ${input.offer} اگر تمایل دارید همین امروز یک توضیح کوتاه و عملی برای شما ارسال کنم.`,
    },
    {
      id: 'social-proof',
      tone: 'اعتمادساز',
      angle: 'اعتمادسازی و نتیجه',
      messageTemplate: `سلام {{name}}، ما برای کسب‌وکارهای مشابه هم از همین مسیر نتیجه گرفتیم. ${input.offer} اگر دوست داشته باشید نمونه اجرای مناسب شما را هم می‌فرستم.`,
    },
  ];
}

function designCampaignAgentPlan(input: {
  goal?: string | null;
  objective?: string | null;
  limit?: number | null;
  minScore?: number | null;
  accountIds?: string[];
}) {
  const goal = inferCampaignGoal(input.goal || null, input.objective || null);
  const limit = Math.max(5, Math.min(150, Number(input.limit || 30)));
  const minScore = Number(input.minScore || 0);
  const audience = buildCampaignAudienceRecommendation({ goal, limit, minScore });
  const accountPlan = buildCampaignAccountDistribution(input.accountIds);
  const tone = goal === 'cold'
    ? 'مشورتی و کم‌فشار'
    : goal === 'reengage'
      ? 'گرم و یادآور'
      : 'نتیجه‌محور و حرفه‌ای';
  const offer = goal === 'reengage'
    ? 'یک پیشنهاد کوتاه برای فعال‌سازی دوباره و شروع گفتگو داریم.'
    : goal === 'warm'
      ? 'می‌توانیم یک دمو یا جمع‌بندی کوتاه و کاربردی برای شما آماده کنیم.'
      : goal === 'cold'
        ? 'یک معرفی کوتاه و مفید داریم که می‌تواند برای شما ارزش‌ساز باشد.'
        : 'یک پیشنهاد مشخص برای افزایش تعامل و تبدیل لیدها آماده است.';
  const variants = buildCampaignMessageVariants({
    goal,
    objective: input.objective || null,
    tone,
    offer,
  });

  const preflightWarnings: Array<{ level: 'info' | 'warn' | 'critical'; message: string }> = [];

  if (audience.totalSelected === 0) {
    preflightWarnings.push({ level: 'critical', message: 'هیچ audience مناسبی برای این هدف پیدا نشد.' });
  }

  if (accountPlan.selectedAccountIds.length === 0) {
    preflightWarnings.push({ level: 'critical', message: 'هیچ اکانت قابل اجرای سالم برای launch پیدا نشد.' });
  }

  if (accountPlan.blockedAccountIds.length > 0) {
    preflightWarnings.push({ level: 'warn', message: `بعضی اکانت‌ها برای launch مناسب نیستند: ${accountPlan.blockedAccountIds.join(', ')}` });
  }

  const variantWarnings = variants.flatMap((variant) => collectCampaignTextWarnings({
    name: variant.id,
    messageTemplate: variant.messageTemplate,
  }).map((warning) => ({
    level: 'warn' as const,
    message: `variant ${variant.id}: ${warning.message}`,
  })));
  preflightWarnings.push(...variantWarnings);

  const approvalState = preflightWarnings.some((warning) => warning.level === 'critical')
    ? 'blocked'
    : preflightWarnings.length > 0
      ? 'needs-review'
      : 'approved';
  const scheduledAt = approvalState === 'approved'
    ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
    : new Date(Date.now() + 60 * 60 * 1000).toISOString();

  return {
    goal,
    objective: input.objective || null,
    audience,
    offer,
    tone,
    variants,
    accountDistribution: accountPlan,
    schedule: {
      recommendedMode: 'scheduled',
      scheduledAt,
      rationale: approvalState === 'approved'
        ? 'سیستم آماده launch کنترل‌شده است و یک فاصله کوتاه برای بازبینی کافی است.'
        : 'بهتر است launch بعد از رفع هشدارها و بازبینی دستی انجام شود.',
    },
    launchApproval: {
      state: approvalState,
      preflightWarnings,
      warmUpAware: true,
      rateLimitAware: true,
    },
    autoFollowupSuggestion: {
      suggestedDelayHours: 24,
      mode: 'failed',
      messageTemplate: 'سلام {{name}}، پیام قبلی را برای شما فرستادیم. اگر مایل باشید خلاصه کوتاه‌تری هم می‌فرستم تا سریع‌تر بررسی کنید.',
    },
  };
}

function evaluateCampaignLaunch(campaignId: string) {
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  const accountIds = parseStringList(campaign.accountIds);
  const contactIds = parseStringList(campaign.contactIds);
  const accountPlan = buildCampaignAccountDistribution(accountIds);
  const warnings: Array<{ level: 'info' | 'warn' | 'critical'; message: string }> = [
    ...collectCampaignTextWarnings({
      name: campaign.name || '',
      messageTemplate: campaign.messageTemplate || '',
    }).map((warning) => ({ level: 'warn' as const, message: warning.message })),
  ];

  if (contactIds.length === 0) {
    warnings.push({ level: 'critical' as const, message: 'کمپین هیچ گیرنده‌ای ندارد.' });
  }

  if (accountPlan.selectedAccountIds.length === 0) {
    warnings.push({ level: 'critical' as const, message: 'هیچ اکانت متصل و مناسب برای launch پیدا نشد.' });
  }

  if (!campaign.messageTemplate && !campaign.mediaPath) {
    warnings.push({ level: 'critical' as const, message: 'کمپین نه متن دارد و نه مدیا.' });
  }

  if (campaign.status && ['queued', 'in-progress', 'completed'].includes(campaign.status)) {
    warnings.push({ level: 'info' as const, message: `وضعیت فعلی کمپین ${campaign.status} است.` });
  }

  const approvalState = warnings.some((warning) => warning.level === 'critical')
    ? 'blocked'
    : warnings.some((warning) => warning.level === 'warn')
      ? 'needs-review'
      : 'approved';

  return {
    campaignId,
    name: campaign.name,
    currentStatus: campaign.status,
    recipients: contactIds.length,
    accountPlan,
    preflightWarnings: warnings,
    launchApproval: {
      state: approvalState,
      canLaunch: approvalState === 'approved',
    },
  };
}

function reviewCampaignKpis(campaignId: string) {
  const snapshot = getCampaignExecutionSnapshot(campaignId);
  if (!snapshot) {
    throw new Error('Campaign not found');
  }

  const completedRecipients = Math.max(0, Number(snapshot.completedRecipients || 0));
  const failedCount = Math.max(0, Number(snapshot.failedCount || 0));
  const failureRate = completedRecipients > 0 ? failedCount / completedRecipients : 0;
  const connectedAccounts = (snapshot.accountBreakdown || []).filter((account: any) => account.connectionStatus === 'connected').length;
  const queueError = snapshot.queue?.errorMessage || null;
  const reasons: string[] = [];
  let recommendedAction: 'pause_campaign' | 'resume_campaign' | 'keep_running' | 'observe' = 'observe';

  if (queueError) {
    reasons.push(`خطای صف: ${queueError}`);
  }

  if (['queued', 'in-progress'].includes(snapshot.status || '') && failureRate >= 0.35 && failedCount >= 5) {
    recommendedAction = 'pause_campaign';
    reasons.push(`نرخ شکست ${Math.round(failureRate * 100)}٪ است و بهتر است کمپین متوقف و بررسی شود.`);
  } else if (snapshot.status === 'paused' && connectedAccounts > 0 && failureRate < 0.2) {
    recommendedAction = 'resume_campaign';
    reasons.push('کمپین pause است، اکانت متصل موجود است و شاخص شکست برای resume قابل قبول است.');
  } else if (['queued', 'in-progress'].includes(snapshot.status || '')) {
    recommendedAction = 'keep_running';
    reasons.push('شاخص‌های فعلی برای ادامه کنترل‌شده کمپین قابل قبول هستند.');
  } else {
    reasons.push('کمپین در وضعیت تحلیلی است و نیاز به observe دارد.');
  }

  return {
    campaignId,
    status: snapshot.status,
    progressPercent: snapshot.progressPercent,
    sentCount: snapshot.sentCount,
    failedCount: snapshot.failedCount,
    pendingCount: snapshot.pendingCount,
    failureRate: Number(failureRate.toFixed(3)),
    recommendedAction,
    reasons,
  };
}

function summarizeCampaignLearnings(campaignId: string) {
  const snapshot = getCampaignExecutionSnapshot(campaignId);
  if (!snapshot) {
    throw new Error('Campaign not found');
  }

  const totalRecipients = Math.max(0, Number(snapshot.totalRecipients || 0));
  const sentCount = Math.max(0, Number(snapshot.sentCount || 0));
  const failedCount = Math.max(0, Number(snapshot.failedCount || 0));
  const successRate = totalRecipients > 0 ? sentCount / totalRecipients : 0;
  const failureRate = totalRecipients > 0 ? failedCount / totalRecipients : 0;
  const bestAccount = (snapshot.accountBreakdown || []).slice().sort((a: any, b: any) => (b.sentCount || 0) - (a.sentCount || 0))[0] || null;
  const queueError = snapshot.queue?.errorMessage || null;

  return {
    campaignId,
    status: snapshot.status,
    summary: {
      totalRecipients,
      sentCount,
      failedCount,
      pendingCount: snapshot.pendingCount,
      successRate: Number(successRate.toFixed(3)),
      failureRate: Number(failureRate.toFixed(3)),
    },
    strengths: [
      bestAccount ? `بهترین اکانت اجرا: ${bestAccount.displayName}` : null,
      sentCount > 0 ? `ارسال موفق ثبت شده: ${sentCount}` : null,
      snapshot.progressPercent >= 80 ? 'پیشرفت کمپین در سطح بالا بوده است.' : null,
    ].filter(Boolean),
    risks: [
      failedCount > 0 ? `تعداد ارسال ناموفق: ${failedCount}` : null,
      queueError ? `خطای صف: ${queueError}` : null,
      snapshot.pendingCount > 0 ? `هنوز ${snapshot.pendingCount} گیرنده در انتظار هستند.` : null,
    ].filter(Boolean),
    nextIterations: [
      failureRate >= 0.2 ? 'قبل از تکرار، کیفیت audience و سلامت account distribution را بازبینی کنید.' : 'می‌توانید variant برنده را در iteration بعدی حفظ کنید.',
      'برای follow-up از گیرنده‌های ناموفق یا بی‌پاسخ یک کمپین کوتاه‌تر بسازید.',
      'زمان‌بندی و حجم ارسال را با warm-up هر اکانت هماهنگ نگه دارید.',
    ],
  };
}

function createCampaignFollowupDraft(input: {
  campaignId: string;
  mode: string;
  name?: string | null;
  messageTemplate?: string | null;
  scheduledAt?: string | null;
  startNow?: boolean;
  dryRun?: boolean;
}) {
  const campaign = db.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).get();
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  const baseContactIds = parseStringList(campaign.contactIds);
  const relatedLogs = db.select().from(messageLogs).all().filter((log: any) => log.campaignId === input.campaignId);
  const failedIds = Array.from(new Set(relatedLogs.filter((log: any) => log.status === 'failed').map((log: any) => log.contactId).filter(Boolean)));
  const sentIds = Array.from(new Set(relatedLogs.filter((log: any) => log.status === 'sent').map((log: any) => log.contactId).filter(Boolean)));

  const mode = input.mode || 'failed';
  const selectedContactIds = mode === 'sent'
    ? sentIds
    : mode === 'all'
      ? baseContactIds
      : failedIds;

  const followupContactIds = selectedContactIds.length > 0 ? selectedContactIds : baseContactIds;
  if (followupContactIds.length === 0) {
    throw new Error('No recipients available for follow-up campaign');
  }

  const accountIds = parseStringList(campaign.accountIds);
  const scheduledAt = input.scheduledAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const name = input.name || `${campaign.name || 'Campaign'} - Follow-up`;
  const messageTemplate = input.messageTemplate || 'سلام {{name}}، برای اطمینان دوباره پیام می‌دهم. اگر مایل باشید خلاصه کوتاه‌تری از پیشنهاد را همین‌جا می‌فرستم.';
  const warnings = collectCampaignTextWarnings({ name, messageTemplate });

  if (input.dryRun !== false) {
    return {
      dryRun: true,
      sourceCampaignId: input.campaignId,
      mode,
      accountIds,
      contactIds: followupContactIds,
      scheduledAt,
      name,
      messageTemplate,
      warnings,
    };
  }

  const id = uuidv4();
  db.insert(campaigns).values({
    id,
    name,
    accountIds: JSON.stringify(accountIds),
    contactIds: JSON.stringify(followupContactIds),
    segmentId: null,
    messageTemplate,
    mediaPath: null,
    scheduleType: input.startNow ? 'immediate' : 'scheduled',
    scheduledAt: input.startNow ? null : scheduledAt,
    maxPerHour: campaign.maxPerHour,
    maxPerDay: campaign.maxPerDay,
    delayMinMs: campaign.delayMinMs,
    delayMaxMs: campaign.delayMaxMs,
    status: 'draft',
    createdAt: new Date().toISOString(),
  }).run();

  let queueResult: Record<string, unknown> | null = null;
  if (input.startNow) {
    queueResult = queueCampaign(id, accountIds);
  }

  return {
    dryRun: false,
    id,
    sourceCampaignId: input.campaignId,
    mode,
    accountIds,
    contactIds: followupContactIds,
    scheduledAt: input.startNow ? null : scheduledAt,
    name,
    messageTemplate,
    warnings,
    queueResult,
  };
}

export function getAiActionCatalog() {
  return AI_ACTION_CATALOG;
}

export function getAiControlOverview() {
  const accounts = db.select().from(whatsappAccounts).all();
  const recentCampaigns = db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).all().slice(0, 15);
  const recentContacts = db.select().from(contacts).orderBy(desc(contacts.createdAt)).all().slice(0, 25);
  const recentConversations = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all().slice(0, 20);
  const recentGroups = db.select().from(groups).orderBy(desc(groups.updatedAt)).all().slice(0, 20);
  const recentActivities = db.select().from(contactActivities).orderBy(desc(contactActivities.createdAt)).all().slice(0, 20);
  const recentTasks = db.select().from(contactTasks).orderBy(desc(contactTasks.createdAt)).all().slice(0, 20);
  const leadRanking = db.select().from(contacts).all().map((contact: any) => scoreContactForCampaign(contact)).sort((a, b) => b.score - a.score).slice(0, 10);
  const autoReplyInsights = buildAutoReplyInsights();
  const followupCandidates = db.select().from(conversations).all().map((conversation: any) => scoreFollowupCandidate(conversation)).filter(Boolean).sort((a: any, b: any) => b.score - a.score).slice(0, 10);
  const salesPipeline = buildSalesPipelineOverview();
  const proxies = db.select().from(proxyProfiles).all();
  const diagnostics = db.select().from(networkDiagnostics).orderBy(desc(networkDiagnostics.checkedAt)).all().slice(0, 15);
  const activeAutoReplyRules = db.select().from(autoReplyRules).all();
  const providerKeys = db.select().from(apiKeys).all().map((item: any) => ({
    provider: item.provider,
    modelName: item.modelName,
    isActive: item.isActive,
    hasKey: !!item.apiKey,
  }));
  const leadScoring = getLeadScoringOverview();
  const analyticsOptimizer = buildAnalyticsOptimizerOverview();
  const governance = getAiGovernanceOverview();
  const marketingStrategist = buildMarketingStrategistOverview();
  const operationalHealth = getOperationalHealthOverview('7days');

  return {
    summary: {
      totalAccounts: accounts.length,
      connectedAccounts: accounts.filter((account: any) => account.status === 'connected').length,
      connectingAccounts: accounts.filter((account: any) => account.status === 'connecting').length,
      totalCampaigns: recentCampaigns.length,
      queuedCampaigns: recentCampaigns.filter((campaign: any) => ['queued', 'in-progress', 'paused'].includes(campaign.status || '')).length,
      totalContacts: recentContacts.length,
      totalConversations: recentConversations.length,
      totalGroups: recentGroups.length,
      totalContactActivities: recentActivities.length,
      totalContactTasks: recentTasks.length,
      openContactTasks: recentTasks.filter((task: any) => task.status !== 'completed').length,
      highValueLeads: leadRanking.filter((lead) => lead.score >= 40).length,
      activeAutoReplyRules: autoReplyInsights.summary.activeRules,
      recentAutoReplyLogs: autoReplyInsights.summary.totalRecentLogs,
      failedAutoReplyLogs: autoReplyInsights.summary.failedRecentLogs,
      followupCandidates: followupCandidates.filter((item: any) => item.score >= 20).length,
      qualifiedPipelineContacts: salesPipeline.summary.qualified,
      opportunityPipelineContacts: salesPipeline.summary.opportunity,
      customerPipelineContacts: salesPipeline.summary.customer,
      stageDriftCount: salesPipeline.summary.stageDriftCount,
      urgentLeadQueue: leadScoring.summary.urgentContacts,
      suppressedLeadCount: leadScoring.summary.suppressedContacts,
      reactivationCandidates: leadScoring.summary.reactivationCandidates,
      optimizerBestSendWindow: analyticsOptimizer.summary.bestSendWindow,
      optimizerBestSegment: analyticsOptimizer.summary.bestSegment,
      governancePendingReview: governance.summary.pendingHumanReview,
      governanceBlockedActions: governance.summary.blockedActions,
      strategistAudienceTag: marketingStrategist.summary.topAudienceTag,
      strategistAudienceSource: marketingStrategist.summary.topAudienceSource,
      totalProxyProfiles: proxies.length,
      recentDiagnostics: diagnostics.length,
      runtimeStatus: operationalHealth.overallStatus,
      runtimeAlerts: operationalHealth.alerts.filter((alert: any) => alert.severity !== 'info').length,
      queueRetryJobs: operationalHealth.queue.retry,
      queueFailedJobs: operationalHealth.queue.failed,
    },
    accounts: accounts.map((account: any) => ({
      id: account.id,
      displayName: account.displayName,
      phoneNumber: account.phoneNumber,
      status: account.status,
      proxyProfileId: account.proxyProfileId,
      lastError: account.lastError,
      lastActive: account.lastActive,
    })),
    campaigns: recentCampaigns.map((campaign: any) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      accountIds: campaign.accountIds,
      contactIds: campaign.contactIds,
      scheduleType: campaign.scheduleType,
      createdAt: campaign.createdAt,
      startedAt: campaign.startedAt,
      completedAt: campaign.completedAt,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
    })),
    contacts: recentContacts.map((contact: any) => ({
      id: contact.id,
      fullName: contact.fullName,
      phone: contact.phone,
      tags: parseStringList(contact.tags),
      segments: parseStringList(contact.segments),
      notes: contact.notes,
      source: contact.source,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      lastInteraction: contact.lastInteraction,
    })),
    contactActivities: recentActivities.map((activity: any) => ({
      id: activity.id,
      contactId: activity.contactId,
      action: activity.action,
      description: activity.description,
      type: activity.type,
      createdAt: activity.createdAt,
    })),
    contactTasks: recentTasks.map((task: any) => ({
      id: task.id,
      contactId: task.contactId,
      title: task.title,
      priority: task.priority,
      status: task.status,
      dueDate: task.dueDate,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    })),
    leadRanking: leadRanking.map((lead) => ({
      contactId: lead.contactId,
      fullName: lead.fullName,
      phone: lead.phone,
      score: lead.score,
      reasons: lead.reasons.slice(0, 3),
      lastInteraction: lead.lastInteraction,
    })),
    autoReplyInsights,
    followupCandidates: followupCandidates.map((item: any) => ({
      conversationId: item.conversationId,
      contactId: item.contactId,
      fullName: item.fullName,
      phone: item.phone,
      score: item.score,
      reasons: item.reasons.slice(0, 3),
      lastMessageAt: item.lastMessageAt,
    })),
    salesPipeline: {
      summary: salesPipeline.summary,
      topPipelineContacts: salesPipeline.topPipelineContacts.slice(0, 10),
      stageDrift: salesPipeline.stageDrift.slice(0, 10),
    },
    leadScoring,
    analyticsOptimizer,
    governance,
    marketingStrategist,
    operationalHealth,
    conversations: recentConversations.map((conversation: any) => ({
      id: conversation.id,
      whatsappAccountId: conversation.whatsappAccountId,
      contactId: conversation.contactId,
      status: conversation.status,
      unreadCount: conversation.unreadCount,
      lastMessageAt: conversation.lastMessageAt,
      updatedAt: conversation.updatedAt,
    })),
    groups: recentGroups.map((group: any) => ({
      id: group.id,
      whatsappAccountId: group.whatsappAccountId,
      jid: group.jid,
      name: group.name,
      description: group.description,
      updatedAt: group.updatedAt,
    })),
    autoReplyRules: activeAutoReplyRules.slice(0, 20).map((rule: any) => ({
      id: rule.id,
      accountId: rule.accountId,
      name: rule.name,
      triggerType: rule.triggerType,
      keywords: rule.keywords,
      isActive: rule.isActive,
    })),
    proxyProfiles: proxies.map((proxy: any) => ({
      id: proxy.id,
      name: proxy.name,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      testStatus: proxy.testStatus,
      lastTested: proxy.lastTested,
    })),
    networkDiagnostics: diagnostics,
    providerKeys,
    availableActions: getAiActionCatalog(),
  };
}

function findAccountReference(instruction: string, overview: ReturnType<typeof getAiControlOverview>) {
  const lowerInstruction = instruction.toLowerCase();

  return overview.accounts.find((account: any) => {
    const id = String(account.id || '').toLowerCase();
    const displayName = String(account.displayName || '').toLowerCase();
    return (id && lowerInstruction.includes(id)) || (displayName && lowerInstruction.includes(displayName));
  }) || null;
}

function extractPhoneNumberFromInstruction(instruction: string) {
  const match = instruction.match(/(?:\+?\d[\d\s-]{8,}\d)/);
  return normalizePhone(match?.[0] || null);
}

function buildLocalFallbackPlan(instruction: string, overview: ReturnType<typeof getAiControlOverview>): AIControlPlan {
  const normalized = instruction.toLowerCase();
  const actions: AIControlAction[] = [];
  const referencedAccount = findAccountReference(instruction, overview);
  const referencedContact = findContactReference(instruction, overview);
  const extractedPhoneNumber = extractPhoneNumberFromInstruction(instruction);

  const mentionsHealth = /health|سلامت|وضعیت|overview|system/.test(normalized);
  const mentionsAccounts = /account|اکانت|accounts|لیست اکانت/.test(normalized);
  const mentionsContacts = /contact|مخاطب|مشتری|crm/.test(normalized);
  const mentionsActivities = /activity|activities|فعالیت|history|سابقه/.test(normalized);
  const mentionsTasks = /task|tasks|تسک|todo|پیگیری/.test(normalized);
  const mentionsNotes = /note|notes|یادداشت/.test(normalized);
  const mentionsSegments = /segment|segments|سگمنت|بخش‌بندی|segmentat/.test(normalized);
  const mentionsCampaigns = /campaign|کمپین/.test(normalized);
  const mentionsLeads = /lead|leads|لید|مشتری بالقوه|hot/.test(normalized);
  const mentionsRecommendation = /recommend|suggest|پیشنهاد|recommendation/.test(normalized);
  const mentionsSnapshot = /snapshot|report|status|گزارش|آنالیز|تحلیل/.test(normalized);
  const mentionsVariants = /variant|variation|copy|tone|offer|audience|نسخه|کپی|لحن|آفر|مخاطب هدف/.test(normalized);
  const mentionsLaunch = /launch|approval|اجرا|لانچ|راه.?اندازی|approve/.test(normalized);
  const mentionsKpi = /kpi|performance|عملکرد|pause|resume|stop|متوقف|ادامه/.test(normalized);
  const mentionsLessons = /lesson|lessons|summary|جمع.?بندی|نتیجه/.test(normalized);
  const mentionsAutoReply = /auto.?reply|autoreply|پاسخ.?خودکار|ربات/.test(normalized);
  const mentionsFollowup = /follow.?up|پیگیری|فالو.?آپ|sales/.test(normalized);
  const mentionsPipeline = /pipeline|stage|stages|مرحله|پایپ.?لاین|sales pipeline/.test(normalized);
  const mentionsNextAction = /next.?best|next action|اقدام بعدی|next step/.test(normalized);
  const mentionsConversion = /conversion|convert|تبدیل|automation|اتومیشن/.test(normalized);
  const mentionsQr = /qr|کیوآر|کیو آر/.test(normalized);
  const mentionsPairing = /pairing|code|کد|جفت/.test(normalized);

  if (mentionsHealth) {
    actions.push({ type: 'health_overview', params: {} });
  }

  if (mentionsAccounts) {
    actions.push({ type: 'list_accounts', params: {} });
  }

  if (mentionsContacts) {
    actions.push(referencedContact
      ? { type: 'get_contact_profile', params: { contactId: referencedContact.id } }
      : { type: 'list_contacts', params: {} });
  }

  if (mentionsActivities && referencedContact) {
    actions.push({ type: 'get_contact_activities', params: { contactId: referencedContact.id, limit: 20 } });
  }

  if (mentionsTasks) {
    actions.push(referencedContact
      ? { type: 'list_contact_tasks', params: { contactId: referencedContact.id, limit: 20 } }
      : { type: 'list_contact_tasks', params: { limit: 20 } });
  }

  if (mentionsNotes && referencedContact) {
    actions.push({ type: 'get_contact_profile', params: { contactId: referencedContact.id } });
  }

  if (mentionsSegments) {
    actions.push({ type: 'segment_contacts', params: { mode: 'activity', value: 'active', limit: 50 } });
  }

  if (mentionsLeads) {
    actions.push({ type: 'list_hot_leads', params: { limit: 20 } });
  }

  if (mentionsAutoReply) {
    actions.push({ type: 'get_auto_reply_insights', params: {} });
    actions.push({ type: 'list_auto_reply_rules', params: { activeOnly: true } });
  }

  if (mentionsFollowup) {
    actions.push({ type: 'recommend_followups', params: { limit: 20, status: 'open' } });
  }

  if (mentionsPipeline) {
    actions.push({ type: 'get_sales_pipeline_overview', params: {} });
    actions.push({ type: 'list_pipeline_contacts', params: { limit: 25 } });
  }

  if (mentionsNextAction && referencedContact) {
    actions.push({ type: 'get_contact_next_best_action', params: { contactId: referencedContact.id } });
  }

  if (mentionsConversion) {
    actions.push({ type: 'preview_conversion_queue', params: { limit: 20, minScore: 15 } });
    actions.push({ type: 'create_conversion_campaign', params: { goal: 'reengage', limit: 25, dryRun: true } });
  }

  if (mentionsCampaigns) {
    actions.push({ type: 'list_campaigns', params: {} });
    const referencedCampaign = overview.campaigns.find((campaign: any) => normalized.includes(String(campaign.id || '').toLowerCase()) || normalized.includes(String(campaign.name || '').toLowerCase()));

    if (mentionsVariants || mentionsRecommendation || /agent|plan|پلن|طراحی/.test(normalized)) {
      actions.push({ type: 'design_campaign_agent_plan', params: { goal: 'engaged', limit: 25 } });
    }

    if (referencedCampaign && mentionsSnapshot) {
      actions.push({ type: 'get_campaign_snapshot', params: { campaignId: referencedCampaign.id } });
    }

    if (referencedCampaign && mentionsLaunch) {
      actions.push({ type: 'evaluate_campaign_launch', params: { campaignId: referencedCampaign.id } });
    }

    if (mentionsRecommendation) {
      actions.push({ type: 'recommend_campaign_contacts', params: { goal: 'engaged', limit: 25, campaignId: referencedCampaign?.id } });
    }

    if (referencedCampaign && mentionsKpi) {
      actions.push({ type: 'review_campaign_kpis', params: { campaignId: referencedCampaign.id } });
    }

    if (referencedCampaign && mentionsLessons) {
      actions.push({ type: 'summarize_campaign_learnings', params: { campaignId: referencedCampaign.id } });
    }

    if (referencedCampaign && mentionsFollowup) {
      actions.push({ type: 'create_campaign_followup', params: { campaignId: referencedCampaign.id, mode: 'failed', dryRun: true } });
    }
  }

  if (mentionsQr && referencedAccount) {
    actions.push({
      type: 'get_account_qr',
      params: { accountId: referencedAccount.id },
    });
  }

  if (mentionsPairing && referencedAccount && extractedPhoneNumber) {
    actions.push({
      type: 'request_pairing_code',
      params: {
        accountId: referencedAccount.id,
        phoneNumber: extractedPhoneNumber,
      },
    });
  }

  if (actions.length === 0) {
    actions.push({ type: 'health_overview', params: {} });
    actions.push({ type: 'list_accounts', params: {} });
  }

  return {
    summary: 'Fallback local planner was used because no live AI provider key/response was available.',
    actions,
  };
}

async function generatePlan(provider: AIProvider, model: string, instruction: string) {
  const overview = getAiControlOverview();
  const prompt = [
    'You are the admin AI controller of a WhatsApp CRM application.',
    'Your task is to convert the user instruction into a SAFE JSON plan using only the allowed action catalog.',
    'Return JSON only and no markdown.',
    'Use this exact format:',
    JSON.stringify({ summary: 'short summary', actions: [{ type: 'health_overview', params: {} }] }, null, 2),
    'Important rules:',
    '- Never invent action names outside the catalog.',
    '- If a required id is clearly available in overview, use it exactly.',
    '- If QR or pairing is required, include get_account_qr or request_pairing_code.',
    '- Prefer concise plans with maximum 5 actions.',
    'Allowed actions catalog:',
    JSON.stringify(getAiActionCatalog(), null, 2),
    'Current app overview:',
    JSON.stringify(overview, null, 2),
    'User instruction:',
    instruction,
  ].join('\n\n');

  const rawResponse = await callAiProvider(provider, model, prompt);
  const jsonPayload = extractJsonObject(rawResponse);
  const parsed = JSON.parse(jsonPayload) as AIControlPlan;

  return {
    overview,
    rawResponse,
    plan: {
      summary: parsed.summary || 'AI control plan generated.',
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    },
  };
}

export async function executeAiControlAction(actionInput: AIControlAction): Promise<AIControlExecutionResult> {
  const actionType = normalizeActionType(String(actionInput.type || '')) as AIControlActionType;
  const params = actionInput.params || {};
  const governance = previewAiGovernance({ type: actionType, params });
  const finalizeGovernedSuccess = (data: unknown): AIControlExecutionResult => {
    persistAiGovernanceLog({
      actionType,
      params,
      approvalState: governance.approvalState,
      requiresApproval: governance.requiresApproval,
      riskLevel: governance.riskLevel,
      blocked: false,
      executed: true,
      warnings: governance.warnings,
      targetSummary: governance.targetSummary,
    });
    return { action: actionType, success: true, data };
  };

  if (asBoolean((params as Record<string, unknown>).preview, false)) {
    persistAiGovernanceLog({
      actionType,
      params,
      approvalState: governance.approvalState,
      requiresApproval: governance.requiresApproval,
      riskLevel: governance.riskLevel,
      blocked: governance.blocked,
      executed: false,
      warnings: governance.warnings,
      targetSummary: governance.targetSummary,
    });
    return {
      action: actionType,
      success: true,
      data: {
        preview: true,
        governance,
      },
    };
  }

  if (governance.blocked) {
    persistAiGovernanceLog({
      actionType,
      params,
      approvalState: governance.approvalState,
      requiresApproval: governance.requiresApproval,
      riskLevel: governance.riskLevel,
      blocked: true,
      executed: false,
      warnings: governance.warnings,
      targetSummary: governance.targetSummary,
    });
    return {
      action: actionType,
      success: false,
      error: 'Blocked by AI governance policy',
      data: { governance },
    };
  }

  if (governance.requiresApproval && !asBoolean((params as Record<string, unknown>).approved, false) && !asBoolean((params as Record<string, unknown>).dryRun, false)) {
    persistAiGovernanceLog({
      actionType,
      params,
      approvalState: governance.approvalState,
      requiresApproval: governance.requiresApproval,
      riskLevel: governance.riskLevel,
      blocked: false,
      executed: false,
      warnings: governance.warnings,
      targetSummary: governance.targetSummary,
    });
    return {
      action: actionType,
      success: false,
      error: 'Human approval required before executing this action',
      data: { governance },
    };
  }

  try {
    if (actionType === 'health_overview') {
      return { action: actionType, success: true, data: getAiControlOverview() };
    }

    if (actionType === 'list_accounts') {
      return {
        action: actionType,
        success: true,
        data: db.select().from(whatsappAccounts).all(),
      };
    }

    if (actionType === 'list_contacts') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 50)));
      const search = asOptionalString(params.search)?.toLowerCase() || null;
      let items = db.select().from(contacts).orderBy(desc(contacts.updatedAt)).all();

      if (search) {
        items = items.filter((contact: any) => {
          const haystack = [contact.fullName, contact.phone, contact.email, contact.tags, contact.notes]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(search);
        });
      }

      return {
        action: actionType,
        success: true,
        data: items.slice(0, limit),
      };
    }

    if (actionType === 'get_contact_profile') {
      const contact = resolveContact(params, getAiControlOverview());

      return {
        action: actionType,
        success: true,
        data: buildContactProfile(contact),
      };
    }

    if (actionType === 'get_contact_activities') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 50)));
      const contact = resolveContact(params, getAiControlOverview());
      const items = db.select().from(contactActivities)
        .where(eq(contactActivities.contactId, contact.id))
        .orderBy(desc(contactActivities.createdAt))
        .all()
        .slice(0, limit);

      return {
        action: actionType,
        success: true,
        data: {
          contact: {
            id: contact.id,
            fullName: contact.fullName,
            phone: contact.phone,
          },
          activities: items,
        },
      };
    }

    if (actionType === 'list_contact_tasks') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 50)));
      const status = asOptionalString(params.status);
      const hasScopedContact = !!asOptionalString(params.contactId) || !!asOptionalString(params.search);
      const scopedContact = hasScopedContact ? resolveContact(params, getAiControlOverview()) : null;
      let items = db.select().from(contactTasks).orderBy(desc(contactTasks.createdAt)).all();

      if (scopedContact) {
        items = items.filter((task: any) => task.contactId === scopedContact.id);
      }

      if (status) {
        items = items.filter((task: any) => task.status === status);
      }

      return {
        action: actionType,
        success: true,
        data: items.slice(0, limit).map((task: any) => {
          const contact = db.select().from(contacts).where(eq(contacts.id, task.contactId)).get();
          return {
            ...task,
            contactName: contact?.fullName || null,
            contactPhone: contact?.phone || null,
          };
        }),
      };
    }

    if (actionType === 'create_contact_task') {
      const contact = resolveContact(params, getAiControlOverview());
      const title = asOptionalString(params.title);
      const description = asOptionalString(params.description);
      const priority = asOptionalString(params.priority) || 'medium';
      const dueDate = asOptionalString(params.dueDate);

      if (!title) throw new Error('title is required');
      if (!['low', 'medium', 'high'].includes(priority)) {
        throw new Error('priority must be low, medium or high');
      }

      const task = {
        id: uuidv4(),
        contactId: contact.id,
        title,
        description,
        priority,
        status: 'pending',
        dueDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };

      db.insert(contactTasks).values(task).run();
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: contact.id,
        action: 'تسک اضافه شد',
        description: `تسک «${title}» توسط AI اضافه شد`,
        details: dueDate ? `موعد: ${dueDate}` : null,
        type: 'task_added',
        activityData: safeJsonStringify({ priority, dueDate }),
        createdAt: new Date().toISOString(),
      }).run();

      return {
        action: actionType,
        success: true,
        data: task,
      };
    }

    if (actionType === 'complete_contact_task') {
      const taskId = asOptionalString(params.taskId);
      if (!taskId) throw new Error('taskId is required');

      const task = db.select().from(contactTasks).where(eq(contactTasks.id, taskId)).get();
      if (!task) throw new Error('task not found');

      const updates = {
        status: 'completed',
        completedAt: new Date().toISOString(),
      };

      db.update(contactTasks).set(updates).where(eq(contactTasks.id, taskId)).run();
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: task.contactId,
        action: 'تسک تکمیل شد',
        description: `تسک «${task.title}» توسط AI تکمیل شد`,
        details: null,
        type: 'task_completed',
        activityData: safeJsonStringify({ taskId }),
        createdAt: new Date().toISOString(),
      }).run();

      return {
        action: actionType,
        success: true,
        data: {
          ...task,
          ...updates,
        },
      };
    }

    if (actionType === 'add_contact_note') {
      const contact = resolveContact(params, getAiControlOverview());
      const note = asOptionalString(params.note);
      if (!note) throw new Error('note is required');

      const timestamp = new Date().toISOString();
      const noteBlock = `[${timestamp}] ${note}`;
      const mergedNotes = [contact.notes, noteBlock].filter(Boolean).join('\n\n');

      db.update(contacts).set({
        notes: mergedNotes,
        updatedAt: timestamp,
      }).where(eq(contacts.id, contact.id)).run();

      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: contact.id,
        action: 'یادداشت اضافه شد',
        description: 'AI یک یادداشت جدید برای مخاطب ثبت کرد',
        details: note,
        type: 'note_added',
        activityData: safeJsonStringify({ note }),
        createdAt: timestamp,
      }).run();

      return {
        action: actionType,
        success: true,
        data: {
          contactId: contact.id,
          notes: mergedNotes,
        },
      };
    }

    if (actionType === 'segment_contacts') {
      const mode = asOptionalString(params.mode);
      const value = asOptionalString(params.value);
      const limit = Math.max(1, Math.min(500, Number(asOptionalNumber(params.limit) || 100)));
      if (!mode) throw new Error('mode is required');
      if (!value) throw new Error('value is required');

      let items = db.select().from(contacts).orderBy(desc(contacts.updatedAt)).all();

      if (mode === 'tag') {
        items = items.filter((contact: any) => parseStringList(contact.tags).some((tag) => tag.toLowerCase().includes(value.toLowerCase())));
      } else if (mode === 'source') {
        items = items.filter((contact: any) => String(contact.source || '').toLowerCase().includes(value.toLowerCase()));
      } else if (mode === 'country') {
        items = items.filter((contact: any) => String(contact.country || '').toLowerCase().includes(value.toLowerCase()) || String(contact.phone || '').startsWith(value.replace('+', '')));
      } else if (mode === 'activity') {
        const now = Date.now();
        items = items.filter((contact: any) => {
          const lastInteractionTime = contact.lastInteraction ? new Date(contact.lastInteraction).getTime() : 0;
          if (value === 'active') {
            return !!lastInteractionTime && (now - lastInteractionTime) <= 7 * 24 * 60 * 60 * 1000;
          }
          if (value === 'inactive') {
            return !lastInteractionTime || (now - lastInteractionTime) > 30 * 24 * 60 * 60 * 1000;
          }
          return false;
        });
      } else {
        throw new Error('mode must be tag, source, country or activity');
      }

      return {
        action: actionType,
        success: true,
        data: {
          mode,
          value,
          count: items.length,
          contacts: items.slice(0, limit),
        },
      };
    }

    if (actionType === 'get_campaign_snapshot') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');

      const snapshot = getCampaignExecutionSnapshot(campaignId);
      if (!snapshot) throw new Error('campaign not found');

      return {
        action: actionType,
        success: true,
        data: snapshot,
      };
    }

    if (actionType === 'list_hot_leads') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 25)));
      const minScore = Number(asOptionalNumber(params.minScore) || 0);
      const ranked = db.select().from(contacts).all()
        .map((contact: any) => scoreContactForCampaign(contact))
        .filter((contact) => contact.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return {
        action: actionType,
        success: true,
        data: ranked,
      };
    }

    if (actionType === 'recommend_campaign_contacts') {
      const campaignId = asOptionalString(params.campaignId);
      const goal = asOptionalString(params.goal) || 'engaged';
      const limit = Math.max(1, Math.min(300, Number(asOptionalNumber(params.limit) || 50)));
      const excludeExistingRecipients = asBoolean(params.excludeExistingRecipients, true);
      let excludedContactIds = new Set<string>();

      if (campaignId && excludeExistingRecipients) {
        const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
        if (!campaign) throw new Error('campaign not found');
        excludedContactIds = new Set(parseStringList(campaign.contactIds));
      }

      const ranked = rankContactsForGoal(goal, db.select().from(contacts).all().map((contact: any) => scoreContactForCampaign(contact)))
        .filter((contact) => !excludedContactIds.has(contact.contactId))
        .slice(0, limit)
        .map((contact) => ({
          ...contact,
          recommendation: {
            goal,
            confidence: contact.score >= 70 ? 'high' : contact.score >= 40 ? 'medium' : 'low',
          },
        }));

      return {
        action: actionType,
        success: true,
        data: {
          campaignId,
          goal,
          count: ranked.length,
          contacts: ranked,
        },
      };
    }

    if (actionType === 'get_auto_reply_insights') {
      return {
        action: actionType,
        success: true,
        data: buildAutoReplyInsights(),
      };
    }

    if (actionType === 'list_auto_reply_logs') {
      const ruleId = asOptionalString(params.ruleId);
      const status = asOptionalString(params.status)?.toLowerCase() || null;
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 50)));
      let items = db.select().from(autoReplyLogs).orderBy(desc(autoReplyLogs.createdAt)).all();

      if (ruleId) {
        items = items.filter((log: any) => log.ruleId === ruleId);
      }

      if (status) {
        items = items.filter((log: any) => String(log.status || '').toLowerCase() === status);
      }

      return {
        action: actionType,
        success: true,
        data: items.slice(0, limit),
      };
    }

    if (actionType === 'toggle_auto_reply_rule') {
      const ruleId = asOptionalString(params.ruleId);
      const isActive = asBoolean(params.isActive, false);
      if (!ruleId) throw new Error('ruleId is required');

      const rule = db.select().from(autoReplyRules).where(eq(autoReplyRules.id, ruleId)).get();
      if (!rule) throw new Error('auto reply rule not found');

      db.update(autoReplyRules).set({ isActive: isActive ? 1 : 0 }).where(eq(autoReplyRules.id, ruleId)).run();

      return {
        action: actionType,
        success: true,
        data: {
          ruleId,
          isActive: isActive ? 1 : 0,
        },
      };
    }

    if (actionType === 'recommend_followups') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 25)));
      const minScore = Number(asOptionalNumber(params.minScore) || 0);
      const status = asOptionalString(params.status);
      let items = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();

      if (status) {
        items = items.filter((conversation: any) => conversation.status === status);
      }

      const ranked = items
        .map((conversation: any) => scoreFollowupCandidate(conversation))
        .filter(Boolean)
        .filter((item: any) => item.score >= minScore)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);

      return {
        action: actionType,
        success: true,
        data: ranked,
      };
    }

    if (actionType === 'create_followup_task') {
      const conversationId = asOptionalString(params.conversationId);
      const title = asOptionalString(params.title) || 'پیگیری فروش';
      const description = asOptionalString(params.description);
      const priority = asOptionalString(params.priority) || 'high';
      const dueDate = asOptionalString(params.dueDate) || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      let contact = null as any;
      let conversation = null as any;

      if (conversationId) {
        conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
        if (!conversation) throw new Error('conversation not found');
        if (!conversation.contactId) throw new Error('conversation contact is not assigned');
        contact = db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get();
      } else {
        contact = resolveContact(params, getAiControlOverview());
      }

      if (!contact) throw new Error('contact not found');
      if (!['low', 'medium', 'high'].includes(priority)) {
        throw new Error('priority must be low, medium or high');
      }

      const task = {
        id: uuidv4(),
        contactId: contact.id,
        title,
        description: description || (conversation ? `پیگیری مکالمه ${conversation.id} برای ${contact.fullName || contact.phone}` : `پیگیری فروش برای ${contact.fullName || contact.phone}`),
        priority,
        status: 'pending',
        dueDate,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };

      db.insert(contactTasks).values(task).run();
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: contact.id,
        action: 'تسک پیگیری اضافه شد',
        description: `AI تسک پیگیری «${title}» را ثبت کرد`,
        details: conversation ? `conversationId: ${conversation.id}` : null,
        type: 'followup_task_added',
        activityData: safeJsonStringify({ conversationId: conversation?.id || null, dueDate, priority }),
        createdAt: new Date().toISOString(),
      }).run();

      if (conversation?.id) {
        db.update(conversations).set({ status: 'pending', updatedAt: new Date().toISOString() }).where(eq(conversations.id, conversation.id)).run();
      }

      return {
        action: actionType,
        success: true,
        data: {
          ...task,
          conversationId: conversation?.id || null,
        },
      };
    }

    if (actionType === 'get_sales_pipeline_overview') {
      return {
        action: actionType,
        success: true,
        data: buildSalesPipelineOverview(),
      };
    }

    if (actionType === 'list_pipeline_contacts') {
      const stage = asOptionalString(params.stage)?.toLowerCase() || null;
      const minScore = Number(asOptionalNumber(params.minScore) || 0);
      const limit = Math.max(1, Math.min(300, Number(asOptionalNumber(params.limit) || 50)));
      let items = db.select().from(contacts).all().map((contact: any) => buildPipelineContactEntry(contact));

      if (stage) {
        items = items.filter((item) => item.effectiveStage === stage);
      }

      items = items.filter((item) => item.score >= minScore).sort((a, b) => b.score - a.score);

      return {
        action: actionType,
        success: true,
        data: items.slice(0, limit),
      };
    }

    if (actionType === 'get_contact_next_best_action') {
      const contact = resolveContact(params, getAiControlOverview());
      return {
        action: actionType,
        success: true,
        data: {
          contactId: contact.id,
          fullName: contact.fullName,
          phone: contact.phone,
          nextBestAction: getNextBestActionForContact(contact),
        },
      };
    }

    if (actionType === 'suggest_stage_updates') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 50)));
      const items = db.select().from(contacts).all()
        .map((contact: any) => buildPipelineContactEntry(contact))
        .filter((item) => item.storedStage !== item.inferredStage)
        .slice(0, limit);

      return {
        action: actionType,
        success: true,
        data: items,
      };
    }

    if (actionType === 'set_contact_pipeline_stage') {
      const contact = resolveContact(params, getAiControlOverview());
      const stage = asOptionalString(params.stage)?.toLowerCase();
      const reason = asOptionalString(params.reason);

      if (!stage || !['cold', 'warm', 'qualified', 'opportunity', 'customer'].includes(stage)) {
        throw new Error('stage must be cold, warm, qualified, opportunity or customer');
      }

      return {
        action: actionType,
        success: true,
        data: persistPipelineStage(contact, stage, reason),
      };
    }

    if (actionType === 'preview_conversion_queue') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 25)));
      const minScore = Number(asOptionalNumber(params.minScore) || 0);
      return {
        action: actionType,
        success: true,
        data: buildConversionQueue(limit, minScore),
      };
    }

    if (actionType === 'execute_contact_next_best_action') {
      const contact = resolveContact(params, getAiControlOverview());
      const dryRun = asBoolean(params.dryRun, true);
      return {
        action: actionType,
        success: true,
        data: executeNextBestActionForContact(contact, dryRun),
      };
    }

    if (actionType === 'create_conversion_campaign') {
      const stage = asOptionalString(params.stage)?.toLowerCase() || null;
      const goal = asOptionalString(params.goal) || 'reengage';
      const limit = Math.max(1, Math.min(300, Number(asOptionalNumber(params.limit) || 50)));
      const name = asOptionalString(params.name);
      const messageTemplate = asOptionalString(params.messageTemplate);
      const accountIds = asArray(params.accountIds);
      const startNow = asBoolean(params.startNow, false);
      const dryRun = asBoolean(params.dryRun, true);

      return {
        action: actionType,
        success: true,
        data: createConversionCampaignDraft({
          stage,
          goal,
          limit,
          name,
          messageTemplate,
          accountIds,
          startNow,
          dryRun,
        }),
      };
    }

    if (actionType === 'apply_suggested_stage_updates') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 25)));
      const dryRun = asBoolean(params.dryRun, true);
      const items = db.select().from(contacts).all()
        .map((contact: any) => buildPipelineContactEntry(contact))
        .filter((item) => item.storedStage !== item.inferredStage)
        .slice(0, limit);

      if (dryRun) {
        return {
          action: actionType,
          success: true,
          data: {
            dryRun: true,
            updates: items,
          },
        };
      }

      const applied = items.map((item) => {
        const contact = db.select().from(contacts).where(eq(contacts.id, item.contactId)).get();
        if (!contact) {
          return {
            contactId: item.contactId,
            applied: false,
          };
        }

        return {
          contactId: item.contactId,
          applied: true,
          result: persistPipelineStage(contact, item.inferredStage, 'Applied suggested stage update from AI conversion automation'),
        };
      });

      return finalizeGovernedSuccess({
        dryRun: false,
        applied,
      });
    }

    if (actionType === 'list_groups') {
      const accountId = asOptionalString(params.accountId);
      if (!accountId) {
        throw new Error('accountId is required');
      }

      return {
        action: actionType,
        success: true,
        data: await getGroups(accountId),
      };
    }

    if (actionType === 'extract_group_members') {
      const accountId = asOptionalString(params.accountId);
      const groupId = asOptionalString(params.groupId);
      if (!accountId) throw new Error('accountId is required');
      if (!groupId) throw new Error('groupId is required');

      return finalizeGovernedSuccess(await extractGroupMembers(accountId, groupId));
    }

    if (actionType === 'list_conversations') {
      const limit = Math.max(1, Math.min(200, Number(asOptionalNumber(params.limit) || 50)));
      const status = asOptionalString(params.status);
      let items = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();

      if (status) {
        items = items.filter((conversation: any) => conversation.status === status);
      }

      const enriched = items.slice(0, limit).map((conversation: any) => {
        const contact = db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get();
        return {
          ...conversation,
          contactName: contact?.fullName || null,
          contactPhone: contact?.phone || null,
        };
      });

      return {
        action: actionType,
        success: true,
        data: enriched,
      };
    }

    if (actionType === 'get_conversation_messages') {
      const conversationId = asOptionalString(params.conversationId);
      const limit = Math.max(1, Math.min(300, Number(asOptionalNumber(params.limit) || 50)));
      if (!conversationId) {
        throw new Error('conversationId is required');
      }

      const items = db.select().from(messageLogs)
        .where(eq(messageLogs.conversationId, conversationId))
        .orderBy(desc(messageLogs.createdAt))
        .all()
        .slice(0, limit)
        .reverse();

      return {
        action: actionType,
        success: true,
        data: items,
      };
    }

    if (actionType === 'reply_to_conversation') {
      const conversationId = asOptionalString(params.conversationId);
      const content = asOptionalString(params.content);
      if (!conversationId) throw new Error('conversationId is required');
      if (!content) throw new Error('content is required');

      const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!conversation) throw new Error('conversation not found');

        if (!conversation.contactId) throw new Error('conversation contact is not assigned');
        if (!conversation.whatsappAccountId) throw new Error('conversation account is not assigned');

      const contact = db.select().from(contacts).where(eq(contacts.id, conversation.contactId)).get();
      if (!contact?.phone) throw new Error('conversation contact phone not found');

      const sendResult = await sendMessage(conversation.whatsappAccountId, contact.phone, content);

      db.insert(messageLogs).values({
        id: uuidv4(),
        whatsappAccountId: conversation.whatsappAccountId,
        contactId: conversation.contactId,
        conversationId: conversation.id,
        campaignId: null,
        direction: 'outbound',
        messageType: 'text',
        content,
        mediaPath: null,
        parsedData: null,
        status: 'sent',
        aiModelUsed: null,
        createdAt: new Date().toISOString(),
      }).run();

      db.update(conversations).set({
        unreadCount: 0,
        lastMessageAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'open',
      }).where(eq(conversations.id, conversation.id)).run();

      return finalizeGovernedSuccess({
        conversationId,
        contactId: conversation.contactId,
        phone: contact.phone,
        sendResult,
      });
    }

    if (actionType === 'list_auto_reply_rules') {
      const accountId = asOptionalString(params.accountId);
      const activeOnly = asBoolean(params.activeOnly, false);
      let items = db.select().from(autoReplyRules).orderBy(desc(autoReplyRules.createdAt)).all();

      if (accountId) {
        items = items.filter((rule: any) => rule.accountId === accountId);
      }

      if (activeOnly) {
        items = items.filter((rule: any) => rule.isActive === 1);
      }

      return {
        action: actionType,
        success: true,
        data: items,
      };
    }

    if (actionType === 'create_account') {
      const displayName = asOptionalString(params.displayName) || asOptionalString(params.customId);
      const customId = sanitizeCustomId(asOptionalString(params.customId));
      const phone = normalizePhone(asOptionalString(params.phone) || asOptionalString(params.pairingPhone));
      const proxyProfileId = asOptionalString(params.proxyProfileId);
      const autoConnect = asBoolean(params.autoConnect, true);

      if (!displayName) {
        throw new Error('displayName or customId is required');
      }

      const id = customId || uuidv4();
      const existing = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, id)).get();
      if (existing) {
        throw new Error(`Account id already exists: ${id}`);
      }

      db.insert(whatsappAccounts).values({
        id,
        displayName,
        phoneNumber: phone,
        proxyProfileId,
        status: autoConnect ? 'connecting' : 'disconnected',
        createdAt: new Date().toISOString(),
      }).run();

      let pairingCode: string | null = null;
      if (autoConnect) {
        await connectAccount(id);
        const pairingPhone = normalizePhone(asOptionalString(params.pairingPhone));
        if (pairingPhone) {
          try {
            const pairing = await requestPairingCode(id, pairingPhone);
            pairingCode = pairing.code;
          } catch (error: any) {
            logger.warn(`Pairing code request failed for ${id}: ${error.message}`);
          }
        }
      }

      return finalizeGovernedSuccess({
        id,
        displayName,
        phoneNumber: phone,
        proxyProfileId,
        status: autoConnect ? 'connecting' : 'disconnected',
        requiresManualPhoneApproval: autoConnect,
        pairingCode,
      });
    }

    if (actionType === 'connect_account') {
      const accountId = asOptionalString(params.accountId);
      if (!accountId) throw new Error('accountId is required');
      await connectAccount(accountId);
      return finalizeGovernedSuccess({ accountId, status: 'connecting' });
    }

    if (actionType === 'disconnect_account') {
      const accountId = asOptionalString(params.accountId);
      if (!accountId) throw new Error('accountId is required');
      disconnectAccount(accountId);
      return finalizeGovernedSuccess({ accountId, status: 'disconnected' });
    }

    if (actionType === 'get_account_qr') {
      const accountId = asOptionalString(params.accountId);
      if (!accountId) throw new Error('accountId is required');
      return {
        action: actionType,
        success: true,
        data: {
          accountId,
          qr: latestQrs[accountId] || null,
          requiresPhoneScan: true,
        },
      };
    }

    if (actionType === 'request_pairing_code') {
      const accountId = asOptionalString(params.accountId);
      const phoneNumber = normalizePhone(asOptionalString(params.phoneNumber));
      if (!accountId || !phoneNumber) {
        throw new Error('accountId and phoneNumber are required');
      }

      const pairing = await requestPairingCode(accountId, phoneNumber);
      return finalizeGovernedSuccess({
        accountId,
        pairingCode: pairing.code,
        phoneNumber: pairing.phone,
        generatedAt: pairing.generatedAt,
        requiresPhoneApproval: true,
      });
    }

    if (actionType === 'assign_proxy_profile') {
      const accountId = asOptionalString(params.accountId);
      const proxyProfileId = asOptionalString(params.proxyProfileId);
      if (!accountId) throw new Error('accountId is required');

      db.update(whatsappAccounts)
        .set({ proxyProfileId: proxyProfileId || null })
        .where(eq(whatsappAccounts.id, accountId))
        .run();

      return {
        action: actionType,
        success: true,
        data: {
          accountId,
          proxyProfileId,
        },
      };
    }

    if (actionType === 'list_campaigns') {
      return {
        action: actionType,
        success: true,
        data: db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).all().slice(0, 30),
      };
    }

    if (actionType === 'create_campaign') {
      const name = asOptionalString(params.name);
      const accountIds = asArray(params.accountIds);
      const contactIds = asArray(params.contactIds);
      const messageTemplate = asOptionalString(params.messageTemplate);
      const mediaPath = asOptionalString(params.mediaPath);
      const scheduleType = asOptionalString(params.scheduleType) || 'immediate';
      const scheduledAt = asOptionalString(params.scheduledAt);
      const startNow = asBoolean(params.startNow, scheduleType === 'immediate');

      if (!name) {
        throw new Error('name is required');
      }

      if (accountIds.length === 0) {
        throw new Error('accountIds is required');
      }

      if (contactIds.length === 0) {
        throw new Error('contactIds is required');
      }

      if (!messageTemplate && !mediaPath) {
        throw new Error('messageTemplate or mediaPath is required');
      }

      const warnings = collectCampaignTextWarnings({ name, messageTemplate });

      const id = uuidv4();
      db.insert(campaigns).values({
        id,
        name,
        accountIds: JSON.stringify(accountIds),
        contactIds: JSON.stringify(contactIds),
        segmentId: null,
        messageTemplate,
        mediaPath,
        scheduleType,
        scheduledAt,
        maxPerHour: asOptionalNumber(params.maxPerHour),
        maxPerDay: asOptionalNumber(params.maxPerDay),
        delayMinMs: asOptionalNumber(params.delayMinMs),
        delayMaxMs: asOptionalNumber(params.delayMaxMs),
        status: 'draft',
        createdAt: new Date().toISOString(),
      }).run();

      let queueResult: Record<string, unknown> | null = null;
      if (startNow) {
        queueResult = queueCampaign(id, accountIds);
      }

      return finalizeGovernedSuccess({
        id,
        name,
        accountIds,
        contactIds,
        status: queueResult?.status || 'draft',
        warnings,
        queueResult,
      });
    }

    if (actionType === 'design_campaign_agent_plan') {
      const goal = asOptionalString(params.goal);
      const objective = asOptionalString(params.objective);
      const limit = asOptionalNumber(params.limit);
      const minScore = asOptionalNumber(params.minScore);
      const accountIds = asArray(params.accountIds);

      return {
        action: actionType,
        success: true,
        data: designCampaignAgentPlan({
          goal,
          objective,
          limit,
          minScore,
          accountIds,
        }),
      };
    }

    if (actionType === 'evaluate_campaign_launch') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');

      return {
        action: actionType,
        success: true,
        data: evaluateCampaignLaunch(campaignId),
      };
    }

    if (actionType === 'create_campaign_followup') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');

      return {
        action: actionType,
        success: true,
        data: createCampaignFollowupDraft({
          campaignId,
          mode: asOptionalString(params.mode) || 'failed',
          name: asOptionalString(params.name),
          messageTemplate: asOptionalString(params.messageTemplate),
          scheduledAt: asOptionalString(params.scheduledAt),
          startNow: asBoolean(params.startNow, false),
          dryRun: asBoolean(params.dryRun, true),
        }),
      };
    }

    if (actionType === 'review_campaign_kpis') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');

      return {
        action: actionType,
        success: true,
        data: reviewCampaignKpis(campaignId),
      };
    }

    if (actionType === 'summarize_campaign_learnings') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');

      return {
        action: actionType,
        success: true,
        data: summarizeCampaignLearnings(campaignId),
      };
    }

    if (actionType === 'execute_campaign') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');

      const campaign = db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get();
      if (!campaign) throw new Error('Campaign not found');

      let accountIds: string[] = [];
      try {
        const parsed = JSON.parse(campaign.accountIds || '[]');
        accountIds = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        accountIds = [];
      }

      const queued = queueCampaign(campaignId, accountIds);
      return finalizeGovernedSuccess({ campaignId, ...queued });
    }

    if (actionType === 'pause_campaign') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');
      return finalizeGovernedSuccess(pauseCampaign(campaignId));
    }

    if (actionType === 'resume_campaign') {
      const campaignId = asOptionalString(params.campaignId);
      if (!campaignId) throw new Error('campaignId is required');
      return finalizeGovernedSuccess(resumeCampaign(campaignId));
    }

    throw new Error(`Unsupported action: ${actionType}`);
  } catch (error: any) {
    persistAiGovernanceLog({
      actionType,
      params,
      approvalState: governance.approvalState,
      requiresApproval: governance.requiresApproval,
      riskLevel: governance.riskLevel,
      blocked: false,
      executed: false,
      warnings: governance.warnings,
      targetSummary: governance.targetSummary,
    });
    return {
      action: actionType,
      success: false,
      error: error.message || 'Unknown AI control action error',
    };
  }
}

export async function executeAiControlInstruction(options: {
  provider: AIProvider;
  model: string;
  instruction: string;
  maxActions?: number;
}) {
  const maxActions = Math.max(1, Math.min(8, Number(options.maxActions || 5)));
  let overview = getAiControlOverview();
  let rawResponse = '';
  let plan: AIControlPlan;
  let planningMode: 'provider' | 'local-fallback' = 'provider';

  try {
    const generatedPlan = await generatePlan(options.provider, options.model, options.instruction);
    overview = generatedPlan.overview;
    rawResponse = generatedPlan.rawResponse;
    plan = generatedPlan.plan;
  } catch (error: any) {
    logger.warn(`AI provider planning failed, switching to local fallback: ${error.message}`);
    planningMode = 'local-fallback';
    plan = buildLocalFallbackPlan(options.instruction, overview);
    rawResponse = JSON.stringify(plan);
  }

  const actions = (plan.actions || []).slice(0, maxActions);
  const results: AIControlExecutionResult[] = [];

  for (const action of actions) {
    const result = await executeAiControlAction(action);
    results.push(result);
    persistAiControlLog({
      provider: options.provider,
      model: options.model,
      instruction: options.instruction,
      planningMode,
      planSummary: plan.summary,
      actionType: String(action.type || 'unknown'),
      actionParams: action.params || {},
      success: result.success,
      error: result.error || null,
      resultData: result.data ?? null,
    });
  }

  return {
    overview,
    provider: options.provider,
    model: options.model,
    instruction: options.instruction,
    planningMode,
    rawResponse,
    plan: {
      summary: plan.summary,
      actions,
    },
    results,
    success: results.every((result) => result.success),
    availableActions: getAiActionCatalog(),
    postExecutionOverview: getAiControlOverview(),
  };
}
