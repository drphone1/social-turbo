import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database';
import { apiKeys, autoReplyRules, contactActivities, contacts, contactTasks, conversations, messageLogs } from '../database/schema';
import { personalizeMessage } from '../utils/message-personalizer';
import { decryptSecret } from '../utils/secret-crypto';
import { logger } from '../utils/logger';

type SupportedLanguage = 'fa' | 'en' | 'ar' | 'mixed';
type AutoReplyIntent =
  | 'general_support'
  | 'product_inquiry'
  | 'pricing_inquiry'
  | 'objection_handling'
  | 'lead_qualification'
  | 'demo_invitation'
  | 'follow_up_reminder'
  | 'escalation_to_human'
  | 'silent_no_reply';

type ConversationStage = 'cold' | 'warm' | 'qualified' | 'opportunity' | 'customer';

export interface AutoReplyBrainInput {
  accountId: string;
  remoteJid: string;
  message: string;
  rule: any;
  contact?: any | null;
  conversation?: any | null;
}

export interface AutoReplyBrainDecision {
  shouldReply: boolean;
  shouldEscalate: boolean;
  shouldCreateFollowupTask: boolean;
  decisionType: 'reply' | 'escalate' | 'followup' | 'silent';
  detectedIntent: AutoReplyIntent;
  detectedLanguage: SupportedLanguage;
  replyText: string;
  escalationReason: string | null;
  silentReason: string | null;
  conversationStatus: 'open' | 'pending';
  suggestedStage: ConversationStage | null;
  contextSummary: Record<string, any>;
}

function parseJsonRecord(value: any): Record<string, any> {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }

  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringList(value: any): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

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

function safeJsonStringify(value: any): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function extractPhoneFromJid(remoteJid: string): string {
  return String(remoteJid || '').split('@')[0].split(':')[0];
}

function detectLanguage(text: string): SupportedLanguage {
  const value = String(text || '');
  const persianChars = (value.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (value.match(/[A-Za-z]/g) || []).length;
  const arabicHints = /مرحبا|كيف|السعر|خدمة|مساعدة/.test(value);

  if (arabicHints) {
    return 'ar';
  }

  if (persianChars > 0 && latinChars > 0) {
    return 'mixed';
  }

  if (persianChars > 0) {
    return 'fa';
  }

  return 'en';
}

function resolveReplyLanguage(rule: any, detectedLanguage: SupportedLanguage): SupportedLanguage {
  const policy = String(rule?.languagePolicy || '').trim().toLowerCase();
  if (policy === 'fa' || policy === 'en' || policy === 'ar') {
    return policy as SupportedLanguage;
  }

  return detectedLanguage;
}

function getFallbackFirstName(language: SupportedLanguage): string {
  if (language === 'en') {
    return 'there';
  }

  if (language === 'ar') {
    return 'صديقي';
  }

  return 'دوست عزیز';
}

function getStoredStage(contact: any): ConversationStage | null {
  const parsedData = parseJsonRecord(contact?.parsedData);
  const stage = String(parsedData?.aiPipeline?.stage || '').trim().toLowerCase();
  return ['cold', 'warm', 'qualified', 'opportunity', 'customer'].includes(stage)
    ? stage as ConversationStage
    : null;
}

function inferStage(contact: any, conversation: any | null, recentLogs: any[]): ConversationStage {
  const storedStage = getStoredStage(contact);
  if (storedStage) {
    return storedStage;
  }

  const tags = parseStringList(contact?.tags).map((tag) => tag.toLowerCase());
  if (tags.some((tag) => ['customer', 'buyer'].includes(tag))) {
    return 'customer';
  }

  const inboundCount = recentLogs.filter((log: any) => log.direction === 'inbound').length;
  const outboundCount = recentLogs.filter((log: any) => log.direction === 'outbound').length;
  if ((conversation && Number(conversation.unreadCount || 0) > 0) || inboundCount >= 3) {
    return 'opportunity';
  }

  if (outboundCount >= 1 || inboundCount >= 1) {
    return 'qualified';
  }

  const lastInteractionAt = contact?.lastInteraction ? new Date(contact.lastInteraction).getTime() : NaN;
  if (!Number.isNaN(lastInteractionAt)) {
    const daysSince = (Date.now() - lastInteractionAt) / (1000 * 60 * 60 * 24);
    if (daysSince <= 30) {
      return 'warm';
    }
  }

  return 'cold';
}

function promoteStage(currentStage: ConversationStage, nextStage: ConversationStage | null): ConversationStage {
  if (!nextStage) {
    return currentStage;
  }

  const order: ConversationStage[] = ['cold', 'warm', 'qualified', 'opportunity', 'customer'];
  return order.indexOf(nextStage) > order.indexOf(currentStage) ? nextStage : currentStage;
}

function detectIntent(message: string, stage: ConversationStage): AutoReplyIntent {
  const normalized = String(message || '').trim().toLowerCase();

  if (!normalized || /^(ok|okay|thanks|thank you|tnx|مرسی|ممنون|سپاس|تشکر|👍|👌)$/.test(normalized)) {
    return 'silent_no_reply';
  }

  if (/human|agent|operator|کارشناس|اپراتور|آدم|مسئول/.test(normalized)) {
    return 'escalation_to_human';
  }

  if (/demo|جلسه|مشاوره|presentation|present|call me|تماس بگیرید/.test(normalized)) {
    return 'demo_invitation';
  }

  if (/price|pricing|cost|quote|plan|tariff|قیمت|هزینه|تعرفه|قیمتش/.test(normalized)) {
    return 'pricing_inquiry';
  }

  if (/product|service|feature|how does it work|what is this|محصول|سرویس|خدمت|ویژگی|امکانات|چی هست/.test(normalized)) {
    return 'product_inquiry';
  }

  if (/expensive|گران|نیاز ندارم|later|بعدا|فعلا نه|not interested|busy|مشغول/.test(normalized)) {
    return 'objection_handling';
  }

  if (/follow.?up|پیگیری|خبر بدید|هنوز|یادآوری|remind/.test(normalized)) {
    return 'follow_up_reminder';
  }

  if (/support|help|problem|issue|bug|error|پشتیبانی|مشکل|خطا|خراب/.test(normalized)) {
    return 'general_support';
  }

  if (stage === 'cold' || stage === 'warm') {
    return 'lead_qualification';
  }

  return 'general_support';
}

function shouldEscalate(message: string, rule: any, intent: AutoReplyIntent): { escalate: boolean; reason: string | null } {
  const normalized = String(message || '').toLowerCase();
  const escalationTerms = parseStringList(rule?.escalationKeywords).map((item) => item.toLowerCase());
  const defaultTerms = ['شکایت', 'نارضایتی', 'refund', 'cancel', 'لغو', 'legal', 'urgent', 'فوری', 'عصبانی', 'complaint'];
  const matchedTerm = [...escalationTerms, ...defaultTerms].find((term) => normalized.includes(term));

  if (intent === 'escalation_to_human') {
    return { escalate: true, reason: 'کاربر درخواست بررسی انسانی داده است' };
  }

  if (matchedTerm) {
    return { escalate: true, reason: `پیام شامل کلیدواژه حساس «${matchedTerm}» است` };
  }

  return { escalate: false, reason: null };
}

function shouldSilence(message: string, recentLogs: any[], intent: AutoReplyIntent): { silent: boolean; reason: string | null } {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) {
    return { silent: true, reason: 'پیام متنی قابل پاسخ وجود ندارد' };
  }

  if (intent === 'silent_no_reply') {
    return { silent: true, reason: 'پیام فقط تایید کوتاه یا تشکر است' };
  }

  const recentOutbound = recentLogs
    .filter((log: any) => log.direction === 'outbound')
    .sort((a: any, b: any) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0];

  if (recentOutbound) {
    const minutesSince = (Date.now() - new Date(recentOutbound.createdAt || 0).getTime()) / (1000 * 60);
    if (minutesSince <= 2) {
      return { silent: true, reason: 'برای جلوگیری از حلقه پاسخ، اخیراً پیام خروجی ارسال شده است' };
    }
  }

  return { silent: false, reason: null };
}

function buildContextSummary(input: AutoReplyBrainInput, stage: ConversationStage, language: SupportedLanguage, intent: AutoReplyIntent, recentLogs: any[]) {
  const parsedData = parseJsonRecord(input.contact?.parsedData);
  return {
    accountId: input.accountId,
    remoteJid: input.remoteJid,
    phone: extractPhoneFromJid(input.remoteJid),
    fullName: input.contact?.fullName || null,
    stage,
    language,
    intent,
    unreadCount: input.conversation?.unreadCount || 0,
    conversationStatus: input.conversation?.status || 'open',
    lastInteraction: input.contact?.lastInteraction || null,
    company: parsedData.company || null,
    city: input.contact?.city || parsedData.city || null,
    recentMessages: recentLogs.slice(-6).map((log: any) => ({
      direction: log.direction,
      content: log.content,
      createdAt: log.createdAt,
    })),
  };
}

function buildFallbackReply(language: SupportedLanguage, intent: AutoReplyIntent, stage: ConversationStage, escalate: boolean): string {
  const fa: Record<AutoReplyIntent, string> = {
    general_support: 'سلام {{firstName}}، پیام شما دریافت شد. برای اینکه دقیق‌تر کمک کنیم، اگر ممکن است جزئیات بیشتری بفرستید.',
    product_inquiry: 'سلام {{firstName}}، خوشحال می‌شویم درباره راهکار مناسب {{company}} توضیح کوتاه و دقیقی ارائه کنیم. اگر مایل باشید همین‌جا جمع‌بندی را می‌فرستم.',
    pricing_inquiry: 'سلام {{firstName}}، برای اعلام قیمت دقیق لازم است نیاز شما را کوتاه بدانیم. اگر دوست داشته باشید همین حالا یک جمع‌بندی سریع از پلن مناسب {{company}} می‌فرستم.',
    objection_handling: 'سلام {{firstName}}، کاملاً متوجه‌ام. اگر مایل باشید فقط در یک پیام کوتاه مزیت عملی و متناسب با شرایط {{company}} را ارسال می‌کنم تا راحت‌تر تصمیم بگیرید.',
    lead_qualification: 'سلام {{firstName}}، ممنون از پیام شما. برای اینکه پیشنهاد دقیق‌تری بدهم، بفرمایید الان بیشتر روی چه موضوعی تمرکز دارید؟',
    demo_invitation: 'سلام {{firstName}}، عالی است. برای هماهنگی دمو یا گفت‌وگوی کوتاه، زمان مناسب شما را بفرمایید تا ادامه دهیم.',
    follow_up_reminder: 'سلام {{firstName}}، پیگیری می‌کنم که اگر هنوز تمایل داشته باشید، ادامه را خیلی خلاصه و کاربردی برایتان جمع‌بندی کنیم.',
    escalation_to_human: 'سلام {{firstName}}، درخواست شما ثبت شد و همکار انسانی ما موضوع را بررسی می‌کند و در ادامه با شما هماهنگ می‌شود.',
    silent_no_reply: '',
  };
  const en: Record<AutoReplyIntent, string> = {
    general_support: 'Hi {{firstName}}, we received your message. If you share a bit more detail, we can guide you more accurately.',
    product_inquiry: 'Hi {{firstName}}, we can share a short overview of the most relevant solution for {{company}}. If you want, I can send the summary here.',
    pricing_inquiry: 'Hi {{firstName}}, to give you accurate pricing we need a quick understanding of your need. If you want, I can suggest the most relevant option first.',
    objection_handling: 'Hi {{firstName}}, understood. If helpful, I can send a very short practical summary so you can evaluate it faster.',
    lead_qualification: 'Hi {{firstName}}, thanks for reaching out. What is the main goal you are trying to solve right now?',
    demo_invitation: 'Hi {{firstName}}, great. Please share a suitable time and we can coordinate a short demo or call.',
    follow_up_reminder: 'Hi {{firstName}}, just following up. If you are still interested, I can send a shorter and more practical summary.',
    escalation_to_human: 'Hi {{firstName}}, your request has been handed to a human teammate and they will follow up with you shortly.',
    silent_no_reply: '',
  };
  const ar: Record<AutoReplyIntent, string> = {
    general_support: 'مرحبا {{firstName}}، تم استلام رسالتك. إذا أرسلت تفاصيل أكثر سنتمكن من مساعدتك بشكل أدق.',
    product_inquiry: 'مرحبا {{firstName}}، يمكننا إرسال ملخص قصير عن الحل الأنسب لـ {{company}} إذا رغبت.',
    pricing_inquiry: 'مرحبا {{firstName}}، لإرسال السعر المناسب نحتاج معرفة سريعة باحتياجك أولاً.',
    objection_handling: 'مرحبا {{firstName}}، أتفهم ذلك. إذا رغبت أرسل لك ملخصاً عملياً قصيراً لتقييم أسرع.',
    lead_qualification: 'مرحبا {{firstName}}، شكراً لرسالتك. ما هو الهدف الرئيسي الذي تريد حله الآن؟',
    demo_invitation: 'مرحبا {{firstName}}، ممتاز. شاركنا الوقت المناسب لننسق عرضاً أو اتصالاً قصيراً.',
    follow_up_reminder: 'مرحبا {{firstName}}، أتابع معك. إذا ما زلت مهتماً أرسل لك ملخصاً أقصر وأكثر عملية.',
    escalation_to_human: 'مرحبا {{firstName}}، تم تحويل طلبك إلى زميل بشري وسيتابع معك قريباً.',
    silent_no_reply: '',
  };

  const replyMap = language === 'ar' ? ar : language === 'en' ? en : fa;
  const selected = replyMap[intent] || replyMap.general_support;

  if (escalate && intent !== 'escalation_to_human') {
    return language === 'en'
      ? 'Hi {{firstName}}, your request needs human review. A teammate will continue with you shortly.'
      : language === 'ar'
        ? 'مرحبا {{firstName}}، هذه الرسالة تحتاج متابعة بشرية وسيتابع معك أحد الزملاء قريباً.'
        : 'سلام {{firstName}}، این موضوع نیاز به بررسی انسانی دارد و همکار ما ادامه پیگیری را انجام می‌دهد.';
  }

  if (intent === 'lead_qualification' && stage === 'cold') {
    return language === 'en'
      ? 'Hi {{firstName}}, thanks for your message. What kind of result are you looking for so we can guide you better?'
      : language === 'ar'
        ? 'مرحبا {{firstName}}، شكراً لرسالتك. ما النتيجة التي تبحث عنها حتى نوجّهك بشكل أفضل؟'
        : 'سلام {{firstName}}، ممنون از پیام شما. بفرمایید دقیقاً دنبال چه نتیجه‌ای هستید تا دقیق‌تر راهنمایی‌تان کنیم.';
  }

  return selected;
}

async function generateAiReply(rule: any, prompt: string): Promise<string> {
  try {
    const aiProvider = rule.aiProviderId || 'openai';
    const aiModel = rule.aiModel;
    const apiKeyRecord = db.select().from(apiKeys).where(eq(apiKeys.provider, aiProvider)).get();

    if (!apiKeyRecord?.apiKey) {
      return '';
    }

    const resolvedApiKey = decryptSecret(apiKeyRecord.apiKey);

    if (aiProvider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: aiModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens: 280,
        }),
      });

      if (!response.ok) {
        return '';
      }

      const data = await response.json();
      return String(data.choices?.[0]?.message?.content || '').trim();
    }

    if (aiProvider === 'gemini') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${aiModel}:generateContent?key=${resolvedApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      });

      if (!response.ok) {
        return '';
      }

      const data = await response.json();
      return String(data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    }

    if (aiProvider === 'claude') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': resolvedApiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: aiModel || 'claude-3-5-sonnet-20241022',
          max_tokens: 280,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        return '';
      }

      const data = await response.json();
      return String(data.content?.[0]?.text || '').trim();
    }

    return '';
  } catch (error) {
    logger.error('Auto-reply brain AI generation failed:', error);
    return '';
  }
}

function buildAiPrompt(rule: any, contextSummary: Record<string, any>, intent: AutoReplyIntent, language: SupportedLanguage, escalate: boolean): string {
  return [
    rule.systemPrompt || 'You are an operational WhatsApp auto-reply assistant.',
    'Respond as a short WhatsApp message.',
    `Language: ${language}`,
    `Intent: ${intent}`,
    `Escalate: ${escalate ? 'yes' : 'no'}`,
    'Constraints:',
    '- concise',
    '- no markdown',
    '- no hallucinated promises',
    '- if escalation is needed, acknowledge and hand off cleanly',
    '- if lead qualification is needed, ask only one short question',
    `Context: ${safeJsonStringify(contextSummary)}`,
    `Incoming message: ${contextSummary.recentMessages?.slice(-1)?.[0]?.content || ''}`,
  ].join('\n');
}

export async function evaluateAutoReplyBrain(input: AutoReplyBrainInput): Promise<AutoReplyBrainDecision> {
  const contact = input.contact || db.select().from(contacts).where(eq(contacts.phone, extractPhoneFromJid(input.remoteJid))).get() || null;
  const conversation = input.conversation || (contact
    ? db.select().from(conversations).where(and(eq(conversations.whatsappAccountId, input.accountId), eq(conversations.contactId, contact.id))).get()
    : null);
  const recentLogs = conversation
    ? db.select().from(messageLogs).where(eq(messageLogs.conversationId, conversation.id)).orderBy(desc(messageLogs.createdAt)).all().slice(0, 8).reverse()
    : [];

  const stage = inferStage(contact, conversation, recentLogs);
  const detectedLanguage = detectLanguage(input.message);
  const language = resolveReplyLanguage(input.rule, detectedLanguage);
  const intent = detectIntent(input.message, stage);
  const escalation = shouldEscalate(input.message, input.rule, intent);
  const silence = shouldSilence(input.message, recentLogs, intent);
  const allowFollowup = Number(input.rule?.allowFollowup ?? 1) !== 0;
  const shouldCreateFollowupTask = allowFollowup && ['pricing_inquiry', 'demo_invitation', 'objection_handling', 'follow_up_reminder'].includes(intent);
  const suggestedStage = promoteStage(stage, intent === 'demo_invitation'
    ? 'opportunity'
    : ['pricing_inquiry', 'product_inquiry', 'lead_qualification'].includes(intent)
      ? 'qualified'
      : null);
  const contextSummary = buildContextSummary({ ...input, contact, conversation }, stage, language, intent, recentLogs);

  if (silence.silent) {
    return {
      shouldReply: false,
      shouldEscalate: false,
      shouldCreateFollowupTask: false,
      decisionType: 'silent',
      detectedIntent: intent,
      detectedLanguage: language,
      replyText: '',
      escalationReason: null,
      silentReason: silence.reason,
      conversationStatus: 'open',
      suggestedStage,
      contextSummary,
    };
  }

  const fallbackReply = buildFallbackReply(language, intent, stage, escalation.escalate);
  const aiReply = await generateAiReply(input.rule, buildAiPrompt(input.rule, contextSummary, intent, language, escalation.escalate));
  const replyText = personalizeMessage(aiReply || fallbackReply, {
    fullName: contact?.fullName,
    firstName: contact?.fullName?.split(' ')[0] || getFallbackFirstName(language),
    phone: contact?.phone,
    city: contact?.city,
    parsedData: contact?.parsedData,
    lastInteraction: contact?.lastInteraction,
  }).personalizedMessage;

  return {
    shouldReply: true,
    shouldEscalate: escalation.escalate,
    shouldCreateFollowupTask,
    decisionType: escalation.escalate ? 'escalate' : shouldCreateFollowupTask ? 'followup' : 'reply',
    detectedIntent: intent,
    detectedLanguage: language,
    replyText,
    escalationReason: escalation.reason,
    silentReason: null,
    conversationStatus: escalation.escalate ? 'pending' : 'open',
    suggestedStage,
    contextSummary,
  };
}

export function applyAutoReplyBrainOutcome(input: {
  decision: AutoReplyBrainDecision;
  contact?: any | null;
  conversation?: any | null;
  rule: any;
}) {
  const { decision, contact, conversation, rule } = input;

  if (!contact) {
    return;
  }

  const parsedData = parseJsonRecord(contact.parsedData);
  const currentStage = getStoredStage(contact) || 'cold';
  const effectiveStage = promoteStage(currentStage, decision.suggestedStage);
  const updatedParsedData = {
    ...parsedData,
    aiPipeline: {
      ...(parsedData.aiPipeline || {}),
      stage: effectiveStage,
      updatedAt: new Date().toISOString(),
      source: 'auto_reply_brain',
    },
    autoReplyBrain: {
      lastIntent: decision.detectedIntent,
      lastLanguage: decision.detectedLanguage,
      lastDecisionType: decision.decisionType,
      updatedAt: new Date().toISOString(),
    },
  };

  db.update(contacts).set({
    parsedData: safeJsonStringify(updatedParsedData),
    updatedAt: new Date().toISOString(),
    lastInteraction: new Date().toISOString(),
  }).where(eq(contacts.id, contact.id)).run();

  db.insert(contactActivities).values({
    id: uuidv4(),
    contactId: contact.id,
    action: 'Auto-reply brain تصمیم‌گیری کرد',
    description: `Intent: ${decision.detectedIntent} | Decision: ${decision.decisionType}`,
    details: decision.escalationReason || decision.silentReason || null,
    type: 'auto_reply_brain_decision',
    activityData: safeJsonStringify({
      ruleId: rule.id,
      decisionType: decision.decisionType,
      detectedIntent: decision.detectedIntent,
      detectedLanguage: decision.detectedLanguage,
      suggestedStage: decision.suggestedStage,
    }),
    createdAt: new Date().toISOString(),
  }).run();

  if (conversation && decision.conversationStatus === 'pending') {
    db.update(conversations).set({
      status: 'pending',
      updatedAt: new Date().toISOString(),
    }).where(eq(conversations.id, conversation.id)).run();
  }

  if (decision.shouldCreateFollowupTask || decision.shouldEscalate) {
    const existingTask = db.select().from(contactTasks)
      .where(eq(contactTasks.contactId, contact.id))
      .all()
      .find((task: any) => task.status !== 'completed' && String(task.title || '').includes(decision.shouldEscalate ? 'بررسی انسانی' : 'پیگیری auto-reply'));

    if (!existingTask) {
      db.insert(contactTasks).values({
        id: uuidv4(),
        contactId: contact.id,
        title: decision.shouldEscalate ? 'بررسی انسانی مکالمه' : 'پیگیری auto-reply',
        description: decision.shouldEscalate
          ? `این مکالمه به بررسی انسانی نیاز دارد. دلیل: ${decision.escalationReason || 'handoff requested'}`
          : `بعد از پاسخ خودکار intent=${decision.detectedIntent} نیاز به پیگیری ثبت شد`,
        priority: decision.shouldEscalate ? 'high' : 'medium',
        status: 'pending',
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        completedAt: null,
      }).run();
    }
  }
}

export async function buildAutoReplyBrainPreview(input: {
  accountId?: string | null;
  contactId?: string | null;
  remoteJid?: string | null;
  message: string;
  ruleId?: string | null;
}) {
  const rule = input.ruleId
    ? db.select().from(autoReplyRules).where(eq(autoReplyRules.id, input.ruleId)).get()
    : input.accountId
      ? db.select().from(autoReplyRules).where(eq(autoReplyRules.accountId, input.accountId)).all().find((item: any) => Number(item.isActive || 0) === 1) || null
      : null;

  if (!rule) {
    throw new Error('No auto-reply rule found for preview');
  }

  const contact = input.contactId
    ? db.select().from(contacts).where(eq(contacts.id, input.contactId)).get()
    : null;

  const resolvedAccountId = input.accountId || rule.accountId;

  if (!resolvedAccountId) {
    throw new Error('No account id found for auto-reply preview');
  }

  return evaluateAutoReplyBrain({
    accountId: resolvedAccountId,
    remoteJid: input.remoteJid || `${contact?.phone || 'unknown'}@s.whatsapp.net`,
    message: input.message,
    rule,
    contact,
    conversation: contact
      ? db.select().from(conversations).where(and(eq(conversations.whatsappAccountId, resolvedAccountId), eq(conversations.contactId, contact.id))).get()
      : null,
  });
}