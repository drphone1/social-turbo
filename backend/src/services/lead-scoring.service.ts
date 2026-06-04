import { desc, eq } from 'drizzle-orm';
import { db } from '../database';
import { autoReplyLogs, contactTasks, contacts, conversations, messageLogs } from '../database/schema';

type PipelineStage = 'cold' | 'warm' | 'qualified' | 'opportunity' | 'customer';

interface ScoreContext {
  allConversations: any[];
  allLogs: any[];
  allTasks: any[];
  allAutoReplyLogs: any[];
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseJsonRecord(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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

function getStage(contact: any): PipelineStage {
  const parsedData = parseJsonRecord(contact?.parsedData);
  const stage = String(parsedData?.aiPipeline?.stage || '').toLowerCase();
  if (['cold', 'warm', 'qualified', 'opportunity', 'customer'].includes(stage)) {
    return stage as PipelineStage;
  }

  const tags = parseStringList(contact?.tags).map((tag) => tag.toLowerCase());
  if (tags.some((tag) => ['customer', 'buyer'].includes(tag))) return 'customer';
  if (tags.some((tag) => ['opportunity', 'deal'].includes(tag))) return 'opportunity';
  if (tags.some((tag) => ['qualified', 'lead'].includes(tag))) return 'qualified';
  return contact?.lastInteraction ? 'warm' : 'cold';
}

function getDaysSince(dateString?: string | null) {
  if (!dateString) return Number.POSITIVE_INFINITY;
  const value = new Date(dateString).getTime();
  if (Number.isNaN(value)) return Number.POSITIVE_INFINITY;
  return (Date.now() - value) / (1000 * 60 * 60 * 24);
}

function buildContext(): ScoreContext {
  return {
    allConversations: db.select().from(conversations).all(),
    allLogs: db.select().from(messageLogs).orderBy(desc(messageLogs.createdAt)).all(),
    allTasks: db.select().from(contactTasks).all(),
    allAutoReplyLogs: db.select().from(autoReplyLogs).orderBy(desc(autoReplyLogs.createdAt)).all(),
  };
}

function buildSuppressionRules(contact: any, contactLogs: any[]) {
  const tags = parseStringList(contact?.tags).map((tag) => tag.toLowerCase());
  const notes = String(contact?.notes || '').toLowerCase();
  const recentInboundText = contactLogs
    .filter((log: any) => log.direction === 'inbound')
    .slice(0, 5)
    .map((log: any) => String(log.content || '').toLowerCase())
    .join(' ');

  const rules: Array<{ code: string; reason: string }> = [];

  if (['opted_out', 'blocked', 'unsubscribed'].includes(String(contact?.consentStatus || '').toLowerCase())) {
    rules.push({ code: 'consent_block', reason: 'وضعیت consent اجازه outreach نمی‌دهد' });
  }
  if (tags.some((tag) => ['blocked', 'do_not_contact', 'blacklist'].includes(tag))) {
    rules.push({ code: 'tag_block', reason: 'مخاطب در لیست عدم تماس یا بلاک قرار دارد' });
  }
  if (/stop|unsubscribe|don.?t message|دیگه پیام ندید|مزاحم|لغو/.test(`${notes} ${recentInboundText}`)) {
    rules.push({ code: 'stop_signal', reason: 'سیگنال صریح برای توقف پیام وجود دارد' });
  }

  return rules;
}

function computeLeadScore(contact: any, stage: PipelineStage, contactLogs: any[]) {
  const parsedData = parseJsonRecord(contact?.parsedData);
  const baseByStage: Record<PipelineStage, number> = {
    cold: 18,
    warm: 35,
    qualified: 62,
    opportunity: 82,
    customer: 95,
  };

  let score = baseByStage[stage];
  if (contact?.email) score += 6;
  if (parsedData.company || contact?.city || contact?.country) score += 6;
  const lastIntent = String(parsedData?.autoReplyBrain?.lastIntent || '').toLowerCase();
  if (['pricing_inquiry', 'demo_invitation', 'product_inquiry'].includes(lastIntent)) score += 12;
  const inboundCount = contactLogs.filter((log: any) => log.direction === 'inbound').length;
  score += Math.min(inboundCount * 4, 16);
  return clamp(score);
}

function computeEngagementScore(contact: any, relatedConversations: any[], contactLogs: any[]) {
  const lastInteractionDays = getDaysSince(contact?.lastInteraction);
  const inboundCount = contactLogs.filter((log: any) => log.direction === 'inbound').length;
  const outboundCount = contactLogs.filter((log: any) => log.direction === 'outbound').length;
  const unreadCount = relatedConversations.reduce((sum: number, item: any) => sum + Number(item.unreadCount || 0), 0);

  let score = 0;
  if (lastInteractionDays <= 1) score += 35;
  else if (lastInteractionDays <= 3) score += 28;
  else if (lastInteractionDays <= 7) score += 20;
  else if (lastInteractionDays <= 14) score += 12;
  else if (lastInteractionDays <= 30) score += 6;
  score += Math.min(inboundCount * 7, 35);
  score += Math.min(outboundCount * 3, 12);
  score += Math.min(unreadCount * 8, 18);
  return clamp(score);
}

function computeCampaignResponseScore(contactLogs: any[]) {
  const campaignOutbound = contactLogs.filter((log: any) => log.direction === 'outbound' && log.campaignId);
  if (campaignOutbound.length === 0) return 0;

  const outboundTimes = campaignOutbound.map((log: any) => new Date(log.createdAt || 0).getTime());
  const inboundAfterCampaign = contactLogs.filter((log: any) => log.direction === 'inbound' && outboundTimes.some((time) => new Date(log.createdAt || 0).getTime() >= time)).length;
  return clamp((inboundAfterCampaign / campaignOutbound.length) * 100);
}

function computeInboxUrgencyScore(relatedConversations: any[], relatedTasks: any[], autoReplyEvents: any[]) {
  const unreadCount = relatedConversations.reduce((sum: number, item: any) => sum + Number(item.unreadCount || 0), 0);
  const pendingConversations = relatedConversations.filter((item: any) => item.status === 'pending').length;
  const highPriorityTasks = relatedTasks.filter((task: any) => task.status !== 'completed' && task.priority === 'high').length;
  const escalationEvents = autoReplyEvents.filter((item: any) => item.decisionType === 'escalate' || item.status === 'failed').length;

  let score = 0;
  score += Math.min(unreadCount * 14, 42);
  score += Math.min(pendingConversations * 22, 30);
  score += Math.min(highPriorityTasks * 20, 30);
  score += Math.min(escalationEvents * 15, 30);
  return clamp(score);
}

function buildNextBestAction(input: {
  stage: PipelineStage;
  leadScore: number;
  engagementScore: number;
  campaignResponseScore: number;
  inboxUrgencyScore: number;
  suppressionRules: Array<{ code: string; reason: string }>;
  daysSinceInteraction: number;
}) {
  if (input.suppressionRules.length > 0) {
    return { code: 'suppress_outreach', label: 'توقف ارتباطات خروجی', reason: input.suppressionRules[0].reason, followupWindow: 'manual-only' };
  }
  if (input.inboxUrgencyScore >= 70) {
    return { code: 'human_followup_now', label: 'پیگیری انسانی فوری', reason: 'فشار inbox یا escalation بالا است', followupWindow: 'now' };
  }
  if (input.stage === 'opportunity' || input.campaignResponseScore >= 60) {
    return { code: 'book_demo_or_offer', label: 'هماهنگی دمو یا ارسال آفر', reason: 'لید به آستانه تبدیل نزدیک شده است', followupWindow: '4h' };
  }
  if (input.leadScore >= 65 && input.engagementScore >= 40) {
    return { code: 'send_personalized_followup', label: 'ارسال follow-up شخصی‌سازی‌شده', reason: 'امتیاز لید و engagement هر دو مناسب هستند', followupWindow: '24h' };
  }
  if ((input.stage === 'cold' || input.stage === 'warm') && input.daysSinceInteraction >= 14) {
    return { code: 'reactivation_sequence', label: 'اجرای reactivation', reason: 'مخاطب مدتی غیرفعال بوده اما suppression ندارد', followupWindow: '3d' };
  }
  return { code: 'qualify_need', label: 'جمع‌آوری نیاز و qualification', reason: 'هنوز برای اقدام پرریسک زود است و باید qualification کامل‌تر شود', followupWindow: '7d' };
}

function buildReactivationSuggestion(daysSinceInteraction: number, suppressionRules: Array<{ code: string; reason: string }>) {
  if (suppressionRules.length > 0 || daysSinceInteraction < 21 || !Number.isFinite(daysSinceInteraction)) return null;
  if (daysSinceInteraction >= 45) return 'این مخاطب برای reactivation با پیام کوتاه ارزش پیشنهادی یا case-study مناسب است.';
  return 'یک follow-up کوتاه و کم‌فشار برای باز کردن مجدد مکالمه پیشنهاد می‌شود.';
}

function buildContactLeadScorecard(contact: any, context: ScoreContext) {
  const relatedConversations = context.allConversations.filter((item: any) => item.contactId === contact.id);
  const conversationIds = new Set(relatedConversations.map((item: any) => item.id));
  const contactLogs = context.allLogs.filter((log: any) => log.contactId === contact.id || (log.conversationId && conversationIds.has(log.conversationId)));
  const relatedTasks = context.allTasks.filter((task: any) => task.contactId === contact.id);
  const autoReplyEvents = context.allAutoReplyLogs.filter((item: any) => String(item.fromPhone || '').includes(String(contact.phone || '')));
  const stage = getStage(contact);
  const suppressionRules = buildSuppressionRules(contact, contactLogs);
  const leadScore = computeLeadScore(contact, stage, contactLogs);
  const engagementScore = computeEngagementScore(contact, relatedConversations, contactLogs);
  const campaignResponseScore = computeCampaignResponseScore(contactLogs);
  const inboxUrgencyScore = computeInboxUrgencyScore(relatedConversations, relatedTasks, autoReplyEvents);
  const daysSinceInteraction = getDaysSince(contact.lastInteraction);
  const nextBestAction = buildNextBestAction({ stage, leadScore, engagementScore, campaignResponseScore, inboxUrgencyScore, suppressionRules, daysSinceInteraction });
  const reactivationSuggestion = buildReactivationSuggestion(daysSinceInteraction, suppressionRules);
  const compositeScore = clamp((leadScore * 0.35) + (engagementScore * 0.3) + (campaignResponseScore * 0.2) + (inboxUrgencyScore * 0.15));

  return {
    contactId: contact.id,
    fullName: contact.fullName,
    phone: contact.phone,
    stage,
    scores: { leadScore, engagementScore, campaignResponseScore, inboxUrgencyScore, compositeScore },
    nextBestAction,
    followupWindow: nextBestAction.followupWindow,
    suppressionRules,
    reactivationSuggestion,
    context: {
      conversationCount: relatedConversations.length,
      unreadCount: relatedConversations.reduce((sum: number, item: any) => sum + Number(item.unreadCount || 0), 0),
      openTasks: relatedTasks.filter((task: any) => task.status !== 'completed').length,
      lastInteraction: contact.lastInteraction || null,
      daysSinceInteraction: Number.isFinite(daysSinceInteraction) ? Number(daysSinceInteraction.toFixed(1)) : null,
      lastAutoReplyDecision: autoReplyEvents[0]?.decisionType || null,
      lastAutoReplyIntent: autoReplyEvents[0]?.detectedIntent || null,
    },
  };
}

export function getContactLeadScorecard(contactId: string) {
  const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) return null;
  return buildContactLeadScorecard(contact, buildContext());
}

export function listLeadScorecards(options?: { stage?: string; minScore?: number; limit?: number; nextBestAction?: string }) {
  const allContacts = db.select().from(contacts).all();
  const context = buildContext();
  return allContacts
    .map((contact: any) => buildContactLeadScorecard(contact, context))
    .filter((item: any) => !options?.stage || item.stage === options.stage)
    .filter((item: any) => typeof options?.minScore !== 'number' || item.scores.compositeScore >= options.minScore)
    .filter((item: any) => !options?.nextBestAction || item.nextBestAction.code === options.nextBestAction)
    .sort((a: any, b: any) => b.scores.compositeScore - a.scores.compositeScore)
    .slice(0, options?.limit || 25);
}

export function getLeadScoringOverview() {
  const scorecards = listLeadScorecards({ limit: 500 });
  const avg = (key: 'leadScore' | 'engagementScore' | 'campaignResponseScore' | 'inboxUrgencyScore' | 'compositeScore') => {
    if (scorecards.length === 0) return 0;
    return clamp(scorecards.reduce((sum: number, item: any) => sum + item.scores[key], 0) / scorecards.length);
  };

  const byAction = scorecards.reduce((acc: Record<string, number>, item: any) => {
    acc[item.nextBestAction.code] = (acc[item.nextBestAction.code] || 0) + 1;
    return acc;
  }, {});
  const byStage = scorecards.reduce((acc: Record<string, number>, item: any) => {
    acc[item.stage] = (acc[item.stage] || 0) + 1;
    return acc;
  }, {});

  return {
    summary: {
      totalContactsScored: scorecards.length,
      averageLeadScore: avg('leadScore'),
      averageEngagementScore: avg('engagementScore'),
      averageCampaignResponseScore: avg('campaignResponseScore'),
      averageInboxUrgencyScore: avg('inboxUrgencyScore'),
      averageCompositeScore: avg('compositeScore'),
      urgentContacts: scorecards.filter((item: any) => item.scores.inboxUrgencyScore >= 70).length,
      suppressedContacts: scorecards.filter((item: any) => item.suppressionRules.length > 0).length,
      reactivationCandidates: scorecards.filter((item: any) => !!item.reactivationSuggestion).length,
    },
    byAction,
    byStage,
    topLeads: scorecards.slice(0, 10),
  };
}