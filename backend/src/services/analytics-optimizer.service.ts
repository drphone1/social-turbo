import { desc } from 'drizzle-orm';
import { db } from '../database';
import { autoReplyLogs, campaigns, contacts, messageLogs } from '../database/schema';
import { getCampaignExecutionSnapshot } from './campaign.executor';
import { listLeadScorecards } from './lead-scoring.service';

type OptimizerRange = 'today' | '7days' | '30days' | '90days';

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
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

function normalizeTemplateSnippet(value: any) {
  return String(value || '')
    .replace(/\{\{[^}]+\}\}/g, '{var}')
    .replace(/https?:\/\/\S+/gi, '{link}')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSyntheticSignal(value: any) {
  return /(utf-?8|self[_ -]?test|copilot|runtime test|validation|operational_self_test|test contact|connected account test|fresh test|special colleague)/i
    .test(String(value || ''));
}

function isGenericIdentity(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'unknown' || normalized === '.' || normalized.startsWith('group member');
}

function topEntries(items: Array<string | null | undefined>, limit = 5) {
  const counts = new Map<string, number>();
  items.filter(Boolean).forEach((item) => {
    const key = String(item).trim();
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function resolveRange(range?: string | null): OptimizerRange {
  if (range === 'today' || range === '7days' || range === '30days' || range === '90days') {
    return range;
  }
  return '30days';
}

function getRangeStart(range: OptimizerRange) {
  const now = new Date();
  const start = new Date(now);
  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
    return start;
  }

  const daysBack = range === '7days' ? 7 : range === '30days' ? 30 : 90;
  start.setDate(start.getDate() - daysBack);
  return start;
}

function formatWindow(hour: number) {
  const next = (hour + 2) % 24;
  return `${String(hour).padStart(2, '0')}:00-${String(next).padStart(2, '0')}:00`;
}

function createPerformanceBucket() {
  return { sends: 0, replies: 0, failed: 0, delivered: 0, contacts: new Set<string>() };
}

function finalizePerformanceMap(map: Map<string, ReturnType<typeof createPerformanceBucket>>, minSends = 1) {
  return Array.from(map.entries())
    .map(([value, bucket]) => {
      const sends = bucket.sends;
      const replies = bucket.replies;
      const failed = bucket.failed;
      const delivered = bucket.delivered;
      const replyRate = sends > 0 ? clamp((replies / sends) * 100) : 0;
      const failureRate = sends > 0 ? clamp((failed / sends) * 100) : 0;
      const deliveryRate = sends > 0 ? clamp((delivered / sends) * 100) : 0;
      const score = clamp((replyRate * 0.65) + (deliveryRate * 0.25) - (failureRate * 0.35));
      return {
        value,
        sends,
        replies,
        failed,
        delivered,
        replyRate,
        failureRate,
        deliveryRate,
        uniqueContacts: bucket.contacts.size,
        score,
      };
    })
    .filter((item) => item.sends >= minSends)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.replyRate !== a.replyRate) return b.replyRate - a.replyRate;
      return b.sends - a.sends;
    });
}

function buildReplyLookup(allLogs: any[]) {
  const inboundByContact = new Map<string, number[]>();
  allLogs
    .filter((log: any) => log.direction === 'inbound' && log.contactId)
    .forEach((log: any) => {
      const timestamp = new Date(log.createdAt || 0).getTime();
      if (Number.isNaN(timestamp)) return;
      const key = String(log.contactId);
      if (!inboundByContact.has(key)) {
        inboundByContact.set(key, []);
      }
      inboundByContact.get(key)?.push(timestamp);
    });

  inboundByContact.forEach((list) => list.sort((a, b) => a - b));
  return inboundByContact;
}

function hasReplyAfterOutbound(contactId: string, outboundAt: string, inboundByContact: Map<string, number[]>) {
  const outboundTime = new Date(outboundAt || 0).getTime();
  if (!contactId || Number.isNaN(outboundTime)) return false;
  const inboundTimes = inboundByContact.get(contactId) || [];
  const maxReplyWindowMs = 72 * 60 * 60 * 1000;
  return inboundTimes.some((timestamp) => timestamp > outboundTime && timestamp <= (outboundTime + maxReplyWindowMs));
}

function buildSuppressionSuggestions(scorecards: any[]) {
  return scorecards
    .filter((item: any) => item.suppressionRules?.length > 0)
    .slice(0, 8)
    .map((item: any) => ({
      contactId: item.contactId,
      fullName: item.fullName,
      phone: item.phone,
      reason: item.suppressionRules[0]?.reason || 'نیاز به suppression دستی',
      ruleCodes: (item.suppressionRules || []).map((rule: any) => rule.code),
    }));
}

function buildFollowupSuggestions(scorecards: any[]) {
  return scorecards
    .filter((item: any) => item.suppressionRules?.length === 0)
    .filter((item: any) => item.nextBestAction?.code !== 'suppress_outreach')
    .filter((item: any) => Number(item.scores?.compositeScore || 0) >= 45)
    .filter((item: any) => !isGenericIdentity(item.fullName))
    .slice(0, 8)
    .map((item: any) => ({
      contactId: item.contactId,
      fullName: item.fullName,
      stage: item.stage,
      compositeScore: item.scores?.compositeScore || 0,
      nextBestAction: item.nextBestAction,
      followupWindow: item.followupWindow,
      reactivationSuggestion: item.reactivationSuggestion || null,
    }));
}

function buildBudgetRiskHints(input: {
  outboundLogs: any[];
  attributedReplies: number;
  autoReplyLogs: any[];
  campaignHealth: any[];
  bestSendWindow: any | null;
  topSource: any | null;
}) {
  const hints: Array<{ level: 'info' | 'warn'; title: string; detail: string }> = [];
  const totalOutbound = input.outboundLogs.length;
  const failedOutbound = input.outboundLogs.filter((log: any) => log.status === 'failed').length;
  const failureRate = totalOutbound > 0 ? failedOutbound / totalOutbound : 0;
  const replyRate = totalOutbound > 0 ? input.attributedReplies / totalOutbound : 0;
  const autoReplyFailed = input.autoReplyLogs.filter((log: any) => log.status === 'failed').length;
  const autoReplyFailureRate = input.autoReplyLogs.length > 0 ? autoReplyFailed / input.autoReplyLogs.length : 0;
  const pausedOrRiskyCampaigns = input.campaignHealth.filter((item: any) => item.failureRate >= 30 || item.recommendedAction === 'pause_campaign').length;

  if (totalOutbound < 10) {
    hints.push({ level: 'info', title: 'داده هنوز کم است', detail: 'برای recommendation با confidence بالاتر، حجم outbound را بیشتر کنید و سپس دوباره optimizer را اجرا کنید.' });
  }
  if (failureRate >= 0.2) {
    hints.push({ level: 'warn', title: 'ریسک اتلاف بودجه در delivery', detail: 'نرخ failure outbound بالاست؛ قبل از scale، account health و quality سگمنت را بررسی کنید.' });
  }
  if (autoReplyFailureRate >= 0.12) {
    hints.push({ level: 'warn', title: 'ریسک در auto-reply execution', detail: 'بخشی از auto-replyها fail شده‌اند؛ اگر هدف conversion است، monitoring انسانی را در ساعات پیک بیشتر کنید.' });
  }
  if (replyRate <= 0.08 && totalOutbound >= 12) {
    hints.push({ level: 'warn', title: 'بازده reply پایین است', detail: 'پیش از افزایش بودجه، copy و timing را بهینه کنید و روی سگمنت‌های strongتر تمرکز کنید.' });
  }
  if (pausedOrRiskyCampaigns > 0) {
    hints.push({ level: 'warn', title: 'کمپین‌های پرریسک دیده شدند', detail: `${pausedOrRiskyCampaigns} کمپین snapshot ضعیف یا پرریسک دارد و نباید همان pattern بدون اصلاح تکرار شود.` });
  }
  if (input.bestSendWindow?.sends && input.bestSendWindow.sends < 3) {
    hints.push({ level: 'info', title: 'confidence زمان ارسال متوسط است', detail: 'best send time از sample محدود استخراج شده؛ فعلاً با A/B تست کوچک تایید شود.' });
  }
  if (input.topSource?.replyRate >= 30) {
    hints.push({ level: 'info', title: 'تمرکز روی منبع برنده', detail: `منبع ${input.topSource.value} فعلاً reply بهتری دارد و برای scale کم‌ریسک‌تر است.` });
  }

  return hints;
}

function buildCopySuggestions(copyPerformance: any[], goal?: string | null) {
  const suggestions: Array<{ type: string; title: string; detail: string; sample?: string | null }> = [];
  const best = copyPerformance.find((item: any) => item.replyRate > 0 && item.sends >= 2) || null;
  const weakest = copyPerformance.find((item: any) => item.sends >= 2 && item.failureRate >= 20) || null;

  if (best) {
    suggestions.push({
      type: 'keep-and-scale',
      title: 'الگوی copy برنده را scale کنید',
      detail: `این الگو replyRate حدود ${best.replyRate}% گرفته و برای تکرار یا variant سازی مناسب‌تر است.`,
      sample: best.preview,
    });
  }

  if (!best) {
    suggestions.push({
      type: 'insufficient-reply-signal',
      title: 'سیگنال reply برای انتخاب copy برنده کافی نیست',
      detail: 'هنوز outbound واقعی با reply معتبر کم است؛ فعلاً copyها را با A/B تست سبک و sample کوچک مقایسه کنید.',
      sample: null,
    });
  }

  if (weakest) {
    suggestions.push({
      type: 'reduce-friction',
      title: 'copy ضعیف را کوتاه‌تر و کم‌اصطکاک‌تر کنید',
      detail: 'این الگو failure/reply ضعیف‌تری داشته است. CTA را سبک‌تر و متن را کوتاه‌تر کنید.',
      sample: weakest.preview,
    });
  }

  suggestions.push({
    type: 'personalization',
    title: 'شخصی‌سازی را در خط اول حفظ کنید',
    detail: goal === 'conversion'
      ? 'برای conversion، opening را مسئله‌محور و شخصی‌سازی‌شده نگه دارید و CTA را به دمو یا مشاوره کوتاه وصل کنید.'
      : 'در پیام‌های broad، personal cue کوتاه در خط اول معمولاً friction را کم می‌کند و کیفیت reply را بالا می‌برد.',
    sample: null,
  });

  return suggestions.slice(0, 5);
}

function buildCampaignHealth(rangeCampaigns: any[]) {
  return rangeCampaigns
    .map((campaign: any) => getCampaignExecutionSnapshot(campaign.id))
    .filter(Boolean)
    .map((snapshot: any) => {
      const totalRecipients = Math.max(0, Number(snapshot.totalRecipients || 0));
      const sentCount = Math.max(0, Number(snapshot.sentCount || 0));
      const failedCount = Math.max(0, Number(snapshot.failedCount || 0));
      const failureRate = totalRecipients > 0 ? clamp((failedCount / totalRecipients) * 100) : 0;
      const successRate = totalRecipients > 0 ? clamp((sentCount / totalRecipients) * 100) : 0;
      const recommendedAction = failureRate >= 35 && failedCount >= 3
        ? 'pause_campaign'
        : successRate >= 55 && snapshot.status === 'completed'
          ? 'repeat_pattern'
          : 'observe';

      return {
        campaignId: snapshot.id,
        name: snapshot.name,
        status: snapshot.status,
        sentCount,
        failedCount,
        totalRecipients,
        successRate,
        failureRate,
        recommendedAction,
      };
    })
    .sort((a: any, b: any) => {
      if (b.successRate !== a.successRate) return b.successRate - a.successRate;
      return b.totalRecipients - a.totalRecipients;
    })
    .slice(0, 12);
}

function buildOptimizerCore(options?: { range?: string | null; goal?: string | null }) {
  const range = resolveRange(options?.range || null);
  const startDate = getRangeStart(range);
  const allLogs = db.select().from(messageLogs).orderBy(desc(messageLogs.createdAt)).all();
  const inboundByContact = buildReplyLookup(allLogs);
  const allContacts = db.select().from(contacts).all();
  const contactMap = new Map(allContacts.map((contact: any) => [contact.id, contact]));
  const scorecards = listLeadScorecards({ limit: 500 });
  const scorecardMap = new Map(scorecards.map((item: any) => [item.contactId, item]));
  const allCampaigns = db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).all();
  const campaignMap = new Map(allCampaigns.map((campaign: any) => [campaign.id, campaign]));
  const recentLogs = allLogs.filter((log: any) => new Date(log.createdAt || 0) >= startDate);
  const outboundLogs = recentLogs.filter((log: any) => {
    if (log.direction !== 'outbound') return false;
    const campaign = log.campaignId ? campaignMap.get(log.campaignId) : null;
    const syntheticCampaign = isSyntheticSignal(log.campaignId) || isSyntheticSignal(campaign?.name);
    const syntheticContent = isSyntheticSignal(log.content);
    return !syntheticCampaign && !syntheticContent;
  });
  const recentAutoReplyLogs = db.select().from(autoReplyLogs).orderBy(desc(autoReplyLogs.createdAt)).all()
    .filter((log: any) => new Date(log.createdAt || 0) >= startDate);
  const recentCampaigns = allCampaigns
    .filter((campaign: any) => new Date(campaign.createdAt || 0) >= startDate)
    .filter((campaign: any) => !isSyntheticSignal(campaign.id) && !isSyntheticSignal(campaign.name))
    .slice(0, 20);

  const sourceMap = new Map<string, ReturnType<typeof createPerformanceBucket>>();
  const stageMap = new Map<string, ReturnType<typeof createPerformanceBucket>>();
  const tagMap = new Map<string, ReturnType<typeof createPerformanceBucket>>();
  const hourMap = new Map<string, ReturnType<typeof createPerformanceBucket>>();
  const copyMap = new Map<string, ReturnType<typeof createPerformanceBucket> & { preview?: string | null }>();

  let attributedReplies = 0;

  outboundLogs.forEach((log: any) => {
    const contact = contactMap.get(log.contactId);
    const scorecard = scorecardMap.get(log.contactId);
    const replied = log.contactId ? hasReplyAfterOutbound(log.contactId, log.createdAt, inboundByContact) : false;
    const failed = log.status === 'failed';
    const delivered = log.status === 'delivered' || log.status === 'sent';
    if (replied) attributedReplies += 1;

    const source = String(contact?.source || 'unknown');
    const stage = String(scorecard?.stage || 'cold');
    const tags = parseStringList(contact?.tags).filter((tag) => !/^group:/i.test(tag));
    const parsedDate = new Date(log.createdAt || 0);
    const hour = Number.isNaN(parsedDate.getTime()) ? null : parsedDate.getHours();
    const templateKey = normalizeTemplateSnippet(log.content).slice(0, 140);

    const register = (map: Map<string, any>, key: string) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, createPerformanceBucket());
      const bucket = map.get(key);
      bucket.sends += 1;
      if (replied) bucket.replies += 1;
      if (failed) bucket.failed += 1;
      if (delivered) bucket.delivered += 1;
      if (log.contactId) bucket.contacts.add(String(log.contactId));
    };

    if (!['unknown', 'manual'].includes(source.toLowerCase())) {
      register(sourceMap, source);
    }
    register(stageMap, stage);
    tags.forEach((tag) => register(tagMap, tag));
    if (typeof hour === 'number') register(hourMap, formatWindow(hour));

    if (templateKey) {
      if (!copyMap.has(templateKey)) {
        copyMap.set(templateKey, { ...createPerformanceBucket(), preview: String(log.content || '').slice(0, 160) || null });
      }
      const bucket = copyMap.get(templateKey)!;
      bucket.sends += 1;
      if (replied) bucket.replies += 1;
      if (failed) bucket.failed += 1;
      if (delivered) bucket.delivered += 1;
      if (log.contactId) bucket.contacts.add(String(log.contactId));
    }
  });

  const sourcePerformance = finalizePerformanceMap(sourceMap, 1).slice(0, 8);
  const stagePerformance = finalizePerformanceMap(stageMap, 1).slice(0, 8);
  const tagPerformance = finalizePerformanceMap(tagMap, 2).slice(0, 8);
  const timeOfDayPerformance = finalizePerformanceMap(hourMap, 1).slice(0, 8);
  const copyPerformance = Array.from(copyMap.entries())
    .map(([value, bucket]) => {
      const sends = bucket.sends;
      const replies = bucket.replies;
      const failed = bucket.failed;
      const delivered = bucket.delivered;
      return {
        value,
        preview: bucket.preview || value,
        sends,
        replies,
        failed,
        delivered,
        replyRate: sends > 0 ? clamp((replies / sends) * 100) : 0,
        failureRate: sends > 0 ? clamp((failed / sends) * 100) : 0,
        deliveryRate: sends > 0 ? clamp((delivered / sends) * 100) : 0,
        uniqueContacts: bucket.contacts.size,
      };
    })
    .sort((a, b) => {
      if (b.replyRate !== a.replyRate) return b.replyRate - a.replyRate;
      return b.sends - a.sends;
    })
    .slice(0, 8);

  const autoReplyDecisionMix = topEntries(recentAutoReplyLogs.map((item: any) => item.decisionType || 'unknown'), 6);
  const autoReplyIntentMix = topEntries(recentAutoReplyLogs.map((item: any) => item.detectedIntent || 'unknown'), 6);
  const campaignHealth = buildCampaignHealth(recentCampaigns);
  const suppressionSuggestions = buildSuppressionSuggestions(scorecards);
  const followupSuggestions = buildFollowupSuggestions(scorecards);
  const replyDrivenWindow = timeOfDayPerformance.find((item: any) => item.replies > 0) || null;
  const safestWindow = timeOfDayPerformance.find((item: any) => item.sends >= 2 && item.failureRate <= 10) || null;
  const bestSendWindow = replyDrivenWindow || null;
  const topSource = sourcePerformance.find((item: any) => item.replyRate > 0) || sourcePerformance[0] || null;
  const topStage = stagePerformance[0] || null;
  const fallbackSourceFromLeads = topEntries(
    scorecards
      .filter((item: any) => !isGenericIdentity(item.fullName))
      .map((item: any) => String(contactMap.get(item.contactId)?.source || ''))
      .filter((value) => value && !['unknown', 'manual'].includes(value.toLowerCase())),
    5,
  )[0] || null;
  const bestSegment = topSource?.replyRate > 0
    ? { mode: 'source', value: topSource?.value || null, confidence: topSource?.score || 0, basis: 'reply-performance' }
    : fallbackSourceFromLeads
      ? { mode: 'source', value: fallbackSourceFromLeads.value, confidence: fallbackSourceFromLeads.count, basis: 'lead-quality-fallback' }
      : topStage
        ? { mode: 'stage', value: topStage?.value || null, confidence: topStage?.score || 0, basis: 'delivery-fallback' }
        : null;

  return {
    range,
    startDate: startDate.toISOString(),
    outboundLogs,
    recentAutoReplyLogs,
    summary: {
      outboundMessages: outboundLogs.length,
      inboundMessages: recentLogs.filter((log: any) => log.direction === 'inbound').length,
      attributedReplies,
      replyRate: outboundLogs.length > 0 ? clamp((attributedReplies / outboundLogs.length) * 100) : 0,
      autoReplyCount: recentAutoReplyLogs.length,
      autoReplySuccessRate: recentAutoReplyLogs.length > 0
        ? clamp((recentAutoReplyLogs.filter((log: any) => log.status === 'sent').length / recentAutoReplyLogs.length) * 100)
        : 0,
      campaignsAnalyzed: recentCampaigns.length,
      bestSendWindow,
      safestSendWindow: safestWindow,
      bestSegment,
    },
    segmentPerformance: {
      sources: sourcePerformance,
      stages: stagePerformance,
      tags: tagPerformance,
    },
    timeOfDayPerformance,
    copyPerformance,
    autoReplyEffectiveness: {
      total: recentAutoReplyLogs.length,
      sent: recentAutoReplyLogs.filter((log: any) => log.status === 'sent').length,
      failed: recentAutoReplyLogs.filter((log: any) => log.status === 'failed').length,
      escalations: recentAutoReplyLogs.filter((log: any) => log.decisionType === 'escalate').length,
      silentDecisions: recentAutoReplyLogs.filter((log: any) => log.decisionType === 'silent').length,
      decisionMix: autoReplyDecisionMix,
      intentMix: autoReplyIntentMix,
    },
    campaignHealth,
    suppressionSuggestions,
    followupSuggestions,
    topAudienceSignals: {
      sources: topEntries(allContacts.map((contact: any) => contact.source || 'manual'), 6),
      tags: topEntries(allContacts.flatMap((contact: any) => parseStringList(contact.tags)), 6),
    },
  };
}

export function buildAnalyticsOptimizerOverview(options?: { range?: string | null }) {
  const core = buildOptimizerCore(options);
  return {
    range: core.range,
    startDate: core.startDate,
    summary: core.summary,
    timeOfDayPerformance: core.timeOfDayPerformance,
    segmentPerformance: core.segmentPerformance,
    autoReplyEffectiveness: core.autoReplyEffectiveness,
    campaignHealth: core.campaignHealth,
    topAudienceSignals: core.topAudienceSignals,
  };
}

export function buildAnalyticsOptimizerRecommendations(input?: { range?: string | null; goal?: string | null }) {
  const core = buildOptimizerCore(input);
  const bestSendTime = core.summary.bestSendWindow
    ? {
        window: core.summary.bestSendWindow.value,
        replyRate: core.summary.bestSendWindow.replyRate,
        failureRate: core.summary.bestSendWindow.failureRate,
        rationale: 'این بازه در داده فعلی بهترین تعادل reply و failure را نشان می‌دهد.',
      }
    : {
        window: core.summary.safestSendWindow?.value || null,
        replyRate: core.summary.safestSendWindow?.replyRate || 0,
        failureRate: core.summary.safestSendWindow?.failureRate || 0,
        rationale: core.summary.safestSendWindow
          ? 'هنوز reply attribution کافی وجود ندارد؛ این بازه فعلاً صرفاً کم‌ریسک‌ترین بازه delivery است.'
          : 'داده کافی برای پیشنهاد دقیق best send time وجود ندارد.',
      };

  const bestSegmentSuggestions = [
    core.summary.bestSegment ? {
      mode: core.summary.bestSegment.mode,
      value: core.summary.bestSegment.value,
      confidence: core.summary.bestSegment.confidence,
      rationale: core.summary.bestSegment.basis === 'reply-performance'
        ? 'این سگمنت بر اساس reply performance فعلی انتخاب شده است.'
        : core.summary.bestSegment.basis === 'lead-quality-fallback'
          ? 'reply signal کافی نبود؛ این سگمنت از کیفیت لیدهای فعلی و تمرکز pipeline استخراج شده است.'
          : 'reply signal کافی نبود؛ این stage فعلاً فقط delivery-safeتر از بقیه دیده شده است.',
    } : null,
    core.segmentPerformance.stages[0] ? {
      mode: 'stage',
      value: core.segmentPerformance.stages[0].value,
      replyRate: core.segmentPerformance.stages[0].replyRate,
      failureRate: core.segmentPerformance.stages[0].failureRate,
      rationale: 'این stage در داده موجود balance بهتری بین intent و responsiveness دارد.',
    } : null,
    core.segmentPerformance.tags[0] ? {
      mode: 'tag',
      value: core.segmentPerformance.tags[0].value,
      replyRate: core.segmentPerformance.tags[0].replyRate,
      failureRate: core.segmentPerformance.tags[0].failureRate,
      rationale: 'این tag از نظر quality پاسخ در waveهای اخیر بهتر عمل کرده است.',
    } : null,
  ].filter(Boolean);

  return {
    range: core.range,
    goal: input?.goal || null,
    summary: core.summary,
    bestSegmentSuggestions,
    bestCopySuggestions: buildCopySuggestions(core.copyPerformance, input?.goal || null),
    bestSendTime,
    suppressionListSuggestions: core.suppressionSuggestions,
    followupSuggestions: core.followupSuggestions,
    budgetRiskHints: buildBudgetRiskHints({
      outboundLogs: core.outboundLogs,
      attributedReplies: core.summary.attributedReplies,
      autoReplyLogs: core.recentAutoReplyLogs,
      campaignHealth: core.campaignHealth,
      bestSendWindow: core.summary.bestSendWindow,
      topSource: core.segmentPerformance.sources[0] || null,
    }),
    autoReplyEffectiveness: core.autoReplyEffectiveness,
    copyPerformance: core.copyPerformance,
    campaignHealth: core.campaignHealth,
  };
}