import { desc } from 'drizzle-orm';
import { db } from '../database';
import { campaigns, contacts, messageLogs } from '../database/schema';
import { getLeadScoringOverview, listLeadScorecards } from './lead-scoring.service';

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

function topEntries(items: string[], limit = 5) {
  const counts = new Map<string, number>();
  items.filter(Boolean).forEach((item) => counts.set(item, (counts.get(item) || 0) + 1));
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function isGenericAudienceTag(tag: string) {
  const normalized = String(tag || '').trim().toLowerCase();
  return normalized.startsWith('group:') || normalized === 'first message' || normalized === 'special';
}

function normalizePhone(value: any) {
  return String(value || '').replace(/[^\d]/g, '');
}

function isGenericExtractedName(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('group member') || normalized === 'unknown' || normalized === '.';
}

function isStrategistAudienceCandidate(item: any) {
  const phone = normalizePhone(item.phone || item.contact?.phone);
  const source = String(item.contact?.source || '').toLowerCase();
  const fullName = String(item.fullName || item.contact?.fullName || '');
  const compositeScore = Number(item.scores?.compositeScore || item.compositeScore || 0);
  const hasUsablePhone = phone.length >= 10 && phone !== '0000000000';
  const hasSomeIdentity = !!String(item.contact?.city || item.contact?.email || item.contact?.notes || '').trim() || !isGenericExtractedName(fullName);

  if (!hasUsablePhone) {
    return false;
  }

  if (source === 'group_extract' && (!hasSomeIdentity || compositeScore < 25)) {
    return false;
  }

  if (fullName.toLowerCase() === 'unknown' && (source === 'group_extract' || compositeScore < 45)) {
    return false;
  }

  return true;
}

function getStrategistAudiencePriority(item: any) {
  const source = String(item.contact?.source || '').toLowerCase();
  const fullName = String(item.fullName || item.contact?.fullName || '');
  const phone = normalizePhone(item.phone || item.contact?.phone);
  let score = Number(item.scores?.compositeScore || item.compositeScore || 0);

  if (source === 'whatsapp_inbound') {
    score += 30;
  } else if (source === 'group_extract') {
    score -= 20;
  }

  if (!isGenericExtractedName(fullName)) {
    score += 12;
  }

  if (phone.length >= 11) {
    score += 6;
  }

  if (String(item.contact?.city || item.contact?.email || '').trim()) {
    score += 5;
  }

  return score;
}

function inferGoal(goal?: string | null, objective?: string | null) {
  if (goal) return String(goal).toLowerCase();
  const normalized = String(objective || '').toLowerCase();
  if (/react|بازگشت|inactive|silent/.test(normalized)) return 'reactivation';
  if (/demo|consult|qualified|pricing|opportunity|مشاوره|قیمت/.test(normalized)) return 'conversion';
  if (/cold|awareness|new|prospect|آگاهی|سرد/.test(normalized)) return 'awareness';
  return 'engagement';
}

function buildSeasonalSuggestions(now: Date) {
  const month = now.getMonth() + 1;
  const suggestions: Array<{ theme: string; recommendation: string }> = [];

  if (month === 3) {
    suggestions.push({ theme: 'نوروز و reset فصلی', recommendation: 'پیام‌ها را حول refresh، برنامه فصل جدید و شروع منظم‌تر کسب‌وکار بچینید.' });
    suggestions.push({ theme: 'جمع‌بندی قبل از تعطیلات', recommendation: 'CTAها را کوتاه و کم‌اصطکاک نگه دارید؛ مثل دمو کوتاه یا ارسال خلاصه یک‌صفحه‌ای.' });
  }

  if (month >= 6 && month <= 8) {
    suggestions.push({ theme: 'تابستان', recommendation: 'روی سرعت اجرا، سبک‌سازی فرایند و کاهش اتلاف زمان تاکید کنید.' });
  }

  if (month >= 9 && month <= 12) {
    suggestions.push({ theme: 'برنامه‌ریزی پایان سال', recommendation: 'پیام‌ها را به بودجه، بازده و آمادگی فصل بعد وصل کنید.' });
  }

  if (suggestions.length === 0) {
    suggestions.push({ theme: 'evergreen', recommendation: 'تمرکز روی ارزش عملی، سرعت نتیجه و کاهش ریسک خرید حفظ شود.' });
  }

  return suggestions;
}

function buildCompetitorSafeFraming(market: string, goal: string) {
  return {
    principle: 'الهام از archetypeهای رقابتی بدون تقلید مستقیم از برند، لحن یا claim اختصاصی رقبا',
    angles: [
      { archetype: 'simple-and-fast', framing: `در بازار ${market || 'هدف'} روی سادگی شروع و سرعت رسیدن به اولین نتیجه تاکید کنید.` },
      { archetype: 'roi-and-clarity', framing: goal === 'conversion' ? 'تمرکز روی بازگشت سرمایه، شفافیت اجرا و کاهش اصطکاک تصمیم‌گیری باشد.' : 'تمرکز روی شفافیت مزیت و وضوح step بعدی باشد.' },
      { archetype: 'trusted-operator', framing: 'به‌جای ادعای اغراق‌آمیز، روی فرآیند قابل اعتماد، پشتیبانی روشن و نمونه استفاده مشابه تکیه کنید.' },
    ],
    guardrails: [
      'بدون استفاده از نام برند رقیب در copy اصلی',
      'بدون تقلید از tagline یا claims اختصاصی',
      'بدون مقایسه غیرقابل‌اثبات',
    ],
  };
}

function buildOfferSuggestions(goal: string, productName: string, offerContext: string) {
  const fallbackName = productName || 'راهکار شما';
  const fallbackContext = offerContext || 'یک مسیر کوتاه و عملی برای شروع';

  if (goal === 'reactivation') {
    return [
      `${fallbackName}: بازگشت کم‌اصطکاک با جمع‌بندی کوتاه و ارزش فوری`,
      `${fallbackContext} با CTA سبک مثل دریافت نمونه یا دمو کوتاه`,
    ];
  }

  if (goal === 'conversion') {
    return [
      `${fallbackName}: دمو یا مشاوره کوتاه با خروجی مشخص`,
      `پیشنهاد مبتنی بر نتیجه: ${fallbackContext}`,
    ];
  }

  if (goal === 'awareness') {
    return [
      `${fallbackName}: معرفی روشن، کم‌فشار و مسئله‌محور`,
      `آفر محتوامحور: ${fallbackContext}`,
    ];
  }

  return [
    `${fallbackName}: پیشنهاد تعامل کوتاه و کاربردی`,
    fallbackContext,
  ];
}

function buildHeadlineIdeas(input: { productName: string; goal: string; audienceLabel: string; offer: string }) {
  const name = input.productName || 'این راهکار';
  const audience = input.audienceLabel || 'این مخاطب';
  return [
    `چطور ${audience} با ${name} سریع‌تر به نتیجه برسد؟`,
    `${name} برای ${audience}: شروع ساده، نتیجه روشن`,
    `اگر ${audience} دنبال مسیر کم‌هزینه‌تر است، این پیشنهاد را ببیند`,
    input.goal === 'conversion'
      ? `یک دمو کوتاه از ${name} قبل از تصمیم نهایی`
      : `یک جمع‌بندی کوتاه از ${name} بدون پیچیدگی اضافی`,
    `پیشنهاد امروز: ${input.offer}`,
  ];
}

function buildCopyIdeas(input: { productName: string; offer: string; goal: string }) {
  const name = input.productName || 'راهکار ما';
  return [
    `سلام {{name}}، اگر بخواهید می‌توانم خیلی کوتاه نشان بدهم ${name} چطور می‌تواند ${input.offer}.`,
    `سلام {{name}}، برای اینکه سریع‌تر ارزیابی کنید، یک خلاصه عملی از ${name} آماده کرده‌ایم.`,
    input.goal === 'reactivation'
      ? `سلام {{name}}، اگر هنوز این موضوع برایتان مهم است، می‌توانم نسخه کوتاه‌تر و کاربردی‌تری از پیشنهاد قبلی بفرستم.`
      : `سلام {{name}}، اگر تمایل داشته باشید، یک قدم بعدی واضح و کم‌فشار برای بررسی ${name} هماهنگ می‌کنیم.`,
  ];
}

function buildObjectionMap(goal: string) {
  const shared = [
    { objection: 'الان زمانش نیست', responseAngle: 'CTA سبک و زمان‌کم مثل دمو 10 دقیقه‌ای یا خلاصه یک‌صفحه‌ای' },
    { objection: 'مطمئن نیستم به درد ما بخورد', responseAngle: 'مثال نزدیک به صنعت/سگمنت مشابه و outcome محور' },
    { objection: 'پیچیده به نظر می‌رسد', responseAngle: 'تاکید روی onboarding ساده و step اول کم‌ریسک' },
  ];

  if (goal === 'conversion') {
    shared.push({ objection: 'قیمت هنوز روشن نیست', responseAngle: 'ابتدا fit و scope را کوتاه مشخص کنید، بعد pricing متناسب ارائه شود' });
  }

  return shared;
}

function buildCampaignCalendar(goal: string) {
  const base = new Date();
  const slots = [2, 5, 9, 14].map((offsetDays, index) => {
    const date = new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    return {
      wave: index + 1,
      date: date.toISOString(),
      focus: index === 0
        ? 'offer introduction'
        : index === 1
          ? 'proof and relevance'
          : index === 2
            ? 'objection handling'
            : goal === 'reactivation'
              ? 'soft reactivation close'
              : 'conversion CTA',
    };
  });

  return {
    cadence: goal === 'awareness' ? 'low-pressure weekly' : 'tight two-week cycle',
    waves: slots,
  };
}

function buildSalesFunnelStrategy(goal: string) {
  return {
    topOfFunnel: goal === 'awareness'
      ? 'پیام مسئله‌محور و کم‌فشار با CTA سبک برای باز کردن گفتگو'
      : 'پیام ارزش‌محور با qualification حداقلی',
    middleOfFunnel: 'ارائه proof، fit و مثال نزدیک به مخاطب + پاسخ به objectionهای اصلی',
    bottomOfFunnel: goal === 'conversion'
      ? 'دعوت به دمو، pricing discussion یا آفر زمانی محدود اما غیرتهاجمی'
      : 'CTA مشخص برای قدم بعدی عملی و کم‌ریسک',
  };
}

function analyzeAudience(limit: number) {
  const scorecards = listLeadScorecards({ limit: 500 });
  const contactMap = new Map(db.select().from(contacts).all().map((contact: any) => [contact.id, contact]));
  const enrichedContacts = scorecards.map((item: any) => ({ ...item, contact: contactMap.get(item.contactId) || null }));
  const filteredContacts = enrichedContacts.filter((item: any) => isStrategistAudienceCandidate(item));
  const selectedContacts = (filteredContacts.length >= Math.max(5, Math.floor(limit / 4)) ? filteredContacts : filteredContacts.length > 0 ? filteredContacts : enrichedContacts)
    .sort((a: any, b: any) => getStrategistAudiencePriority(b) - getStrategistAudiencePriority(a))
    .slice(0, limit);

  const tags = topEntries(selectedContacts.flatMap((item: any) => parseStringList(item.contact?.tags)));
  const sources = topEntries(selectedContacts.map((item: any) => String(item.contact?.source || 'manual')));
  const cities = topEntries(selectedContacts.map((item: any) => String(item.contact?.city || '')).filter(Boolean));
  const languages = topEntries(selectedContacts.map((item: any) => String(item.contact?.language || '')).filter(Boolean));
  const stages = topEntries(selectedContacts.map((item: any) => item.stage));
  const actions = topEntries(selectedContacts.map((item: any) => item.nextBestAction.code));

  return {
    totalContacts: selectedContacts.length,
    topTags: tags,
    topSources: sources,
    topCities: cities,
    topLanguages: languages,
    stageMix: stages,
    nextBestActionMix: actions,
    topContacts: selectedContacts.slice(0, 12).map((item: any) => ({
      contactId: item.contactId,
      fullName: item.fullName,
      phone: item.phone,
      stage: item.stage,
      compositeScore: item.scores.compositeScore,
      nextBestAction: item.nextBestAction,
    })),
  };
}

export function buildMarketingStrategistOverview() {
  const now = new Date();
  const recentCampaigns = db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).all().slice(0, 15);
  const outboundCount = db.select().from(messageLogs).all().filter((item: any) => item.direction === 'outbound').length;
  const leadOverview = getLeadScoringOverview();
  const audienceSnapshot = analyzeAudience(60);

  return {
    summary: {
      recentCampaigns: recentCampaigns.length,
      outboundMessages: outboundCount,
      scoredContacts: leadOverview.summary.totalContactsScored,
      urgentContacts: leadOverview.summary.urgentContacts,
      topAudienceTag: audienceSnapshot.topTags[0] || null,
      topAudienceSource: audienceSnapshot.topSources[0] || null,
    },
    audienceSnapshot,
    seasonalSuggestions: buildSeasonalSuggestions(now),
    recentCampaigns: recentCampaigns.map((campaign: any) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      createdAt: campaign.createdAt,
    })),
  };
}

export function buildMarketingStrategy(input: {
  goal?: string | null;
  objective?: string | null;
  productName?: string | null;
  offerContext?: string | null;
  market?: string | null;
  tone?: string | null;
  limit?: number | null;
}) {
  const goal = inferGoal(input.goal || null, input.objective || null);
  const audience = analyzeAudience(Number(input.limit || 60));
  const primaryAudienceLabel = audience.topTags.find((item: any) => !isGenericAudienceTag(item.value))?.value
    || audience.topSources[0]?.value
    || audience.stageMix[0]?.value
    || 'مخاطبین با تعامل بالاتر';
  const offers = buildOfferSuggestions(goal, String(input.productName || ''), String(input.offerContext || ''));
  const positioning = {
    audience: primaryAudienceLabel,
    problemFrame: goal === 'reactivation'
      ? 'مخاطب قبلاً سیگنال علاقه داشته اما momentum از دست رفته است.'
      : goal === 'conversion'
        ? 'مخاطب به نتیجه عملی و تصمیم کم‌ریسک نیاز دارد.'
        : 'مخاطب هنوز باید fit و relevance را سریع درک کند.',
    valueProposition: offers[0],
    tone: input.tone || (goal === 'awareness' ? 'مشورتی و کم‌فشار' : 'شفاف، حرفه‌ای و نتیجه‌محور'),
  };
  const headlines = buildHeadlineIdeas({
    productName: String(input.productName || ''),
    goal,
    audienceLabel: primaryAudienceLabel,
    offer: offers[0],
  });
  const copyIdeas = buildCopyIdeas({
    productName: String(input.productName || ''),
    offer: offers[0],
    goal,
  });

  return {
    goal,
    objective: input.objective || null,
    audience,
    offerSuggestions: offers,
    positioning,
    headlineIdeas: headlines,
    copyIdeas,
    objectionMap: buildObjectionMap(goal),
    campaignCalendar: buildCampaignCalendar(goal),
    seasonalSuggestions: buildSeasonalSuggestions(new Date()),
    contentAngles: [
      'problem-solution clarity',
      'before-after transformation',
      'quick win in first week',
      'social proof without exaggeration',
      'risk reduction and easy next step',
    ],
    competitorSafeFraming: buildCompetitorSafeFraming(String(input.market || ''), goal),
    salesFunnelStrategy: buildSalesFunnelStrategy(goal),
  };
}

export function buildStrategySegmentRecommendation(input: {
  goal?: string | null;
  objective?: string | null;
  limit?: number | null;
}) {
  const strategy = buildMarketingStrategy(input);
  const topTag = strategy.audience.topTags.find((item: any) => !isGenericAudienceTag(item.value)) || null;
  const topSource = strategy.audience.topSources[0] || null;
  const topStage = strategy.audience.stageMix[0] || null;

  return {
    strategyGoal: strategy.goal,
    suggestedSegment: {
      mode: topTag ? 'tag' : topSource ? 'source' : 'stage',
      value: topTag?.value || topSource?.value || topStage?.value || 'warm',
      rationale: topTag
        ? 'بیشترین تراکم audience هدف در tag غالب فعلی دیده می‌شود.'
        : topSource
          ? 'source غالب فعلی مناسب‌ترین ورودی برای استراتژی است.'
          : 'stage غالب فعلی بهترین نقطه شروع برای این استراتژی است.',
    },
    backupSegment: topStage ? { mode: 'stage', value: topStage.value } : null,
    selectedContactsPreview: strategy.audience.topContacts.slice(0, Math.max(5, Math.min(20, Number(input.limit || 10)))),
  };
}

export function buildStrategyCampaignDraft(input: {
  goal?: string | null;
  objective?: string | null;
  productName?: string | null;
  offerContext?: string | null;
  market?: string | null;
  limit?: number | null;
}) {
  const strategy = buildMarketingStrategy(input);
  const segment = buildStrategySegmentRecommendation(input);
  const selectedContacts = strategy.audience.topContacts.slice(0, Math.max(10, Math.min(50, Number(input.limit || 20))));

  return {
    name: `Strategy Draft - ${strategy.goal} - ${new Date().toISOString().slice(0, 10)}`,
    goal: strategy.goal,
    recommendedSegment: segment.suggestedSegment,
    contactIds: selectedContacts.map((item: any) => item.contactId),
    audiencePreview: selectedContacts,
    offer: strategy.offerSuggestions[0],
    primaryHeadline: strategy.headlineIdeas[0],
    messageTemplate: strategy.copyIdeas[0],
    followupTemplate: strategy.copyIdeas[1],
    calendar: strategy.campaignCalendar,
    objectionHandlingFocus: strategy.objectionMap.slice(0, 3),
    safetyNotes: strategy.competitorSafeFraming.guardrails,
  };
}