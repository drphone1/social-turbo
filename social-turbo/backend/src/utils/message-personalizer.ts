/**
 * Message Personalization Service
 * Handles dynamic variable replacement in messages
 */

import { logger } from './logger';

export interface ContactVariables {
  name?: string;
  fullName?: string;
  firstName?: string;
  phone?: string;
  email?: string;
  company?: string;
  city?: string;
  country?: string;
  timezone?: string;
  language?: string;
  source?: string;
  notes?: string;
  parsedData?: Record<string, any> | string | null;
  lastInteraction?: string;
  tags?: string[];
  customFields?: Record<string, any>;
  [key: string]: any;
}

export interface PersonalizationResult {
  originalMessage: string;
  personalizedMessage: string;
  variables: string[];
  replacedVariables: string[];
  missingVariables: string[];
  fallbackVariables?: string[];
  resolvedContext?: Record<string, string>;
  availableContext?: Record<string, string>;
}

export interface TemplateAnalysisResult {
  message: string;
  variables: string[];
  count: number;
  supportedVariables: Record<string, string>;
  unknownVariables: string[];
  samplePreview: string;
  contactCoverage?: {
    totalContacts: number;
    perVariable: Array<{
      variable: string;
      availableCount: number;
      fallbackCount: number;
      missingCount: number;
      coverageRate: number;
    }>;
  };
}

const STAGE_VALUES = ['cold', 'warm', 'qualified', 'opportunity', 'customer'];

const VARIABLE_ALIASES: Record<string, string[]> = {
  name: ['name', 'fullName', 'fullname', 'contactName'],
  firstName: ['firstName', 'firstname', 'givenName'],
  phone: ['phone', 'mobile', 'phoneNumber'],
  email: ['email', 'mail'],
  company: ['company', 'business', 'organization'],
  city: ['city', 'town'],
  country: ['country'],
  timezone: ['timezone', 'timeZone'],
  language: ['language', 'lang', 'preferredLanguage', 'locale'],
  job: ['job', 'title', 'jobTitle', 'position', 'role'],
  industry: ['industry', 'sector', 'market'],
  stage: ['stage', 'leadStage', 'pipelineStage', 'salesStage'],
  interest: ['interest', 'interests', 'topic', 'need', 'needs'],
  sourceGroup: ['sourceGroup', 'source', 'channel', 'origin'],
  engagementHistory: ['engagementHistory', 'interactionHistory', 'activityHistory', 'engagement'],
  offerType: ['offerType', 'offer', 'proposalType'],
  today: ['today'],
  tomorrow: ['tomorrow'],
  currentTime: ['currentTime', 'timeNow'],
};

const DEFAULT_FALLBACKS: Record<string, string> = {
  name: 'دوست عزیز',
  firstName: 'دوست عزیز',
  phone: 'شماره شما',
  email: 'ایمیل شما',
  company: 'کسب‌وکار شما',
  city: 'شهر شما',
  country: 'منطقه شما',
  timezone: 'منطقه زمانی شما',
  language: 'fa',
  job: 'همکار گرامی',
  industry: 'حوزه کاری شما',
  stage: 'lead',
  interest: 'راهکار مناسب شما',
  sourceGroup: 'ارتباط قبلی',
  engagementHistory: 'تعامل قبلی',
  offerType: 'معرفی کوتاه',
};

function normalizeVariableKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function asTrimmedString(value: any): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value).trim();
  return text ? text : undefined;
}

function parseLooseJson(value: any): Record<string, any> {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
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

function normalizeTags(value: any): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => asTrimmedString(item)).filter(Boolean) as string[];
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => asTrimmedString(item)).filter(Boolean) as string[];
      }
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }

  return [];
}

function getNestedValue(source: Record<string, any>, path: string): any {
  return path.split('.').reduce((acc: any, key) => {
    if (acc === undefined || acc === null) {
      return undefined;
    }

    return acc[key];
  }, source);
}

function pickFirstString(...values: any[]): string | undefined {
  for (const value of values) {
    const normalized = asTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function inferStage(parsedData: Record<string, any>, tags: string[], lastInteraction?: string): string {
  const directStage = pickFirstString(
    getNestedValue(parsedData, 'aiPipeline.stage'),
    parsedData.stage,
    parsedData.leadStage,
    parsedData.pipelineStage,
    parsedData.salesStage,
  );

  const normalizedDirectStage = directStage?.toLowerCase();
  if (normalizedDirectStage && STAGE_VALUES.includes(normalizedDirectStage)) {
    return normalizedDirectStage;
  }

  const tagStage = tags
    .map((tag) => tag.toLowerCase())
    .find((tag) => STAGE_VALUES.includes(tag));
  if (tagStage) {
    return tagStage;
  }

  if (lastInteraction) {
    const interactionTime = new Date(lastInteraction).getTime();
    if (!Number.isNaN(interactionTime)) {
      const daysSince = (Date.now() - interactionTime) / (1000 * 60 * 60 * 24);
      if (daysSince <= 7) {
        return 'qualified';
      }
      if (daysSince <= 30) {
        return 'warm';
      }
    }
  }

  return 'cold';
}

function inferInterest(parsedData: Record<string, any>, tags: string[], notes?: string): string {
  const directInterest = pickFirstString(
    parsedData.interest,
    Array.isArray(parsedData.interests) ? parsedData.interests[0] : undefined,
    getNestedValue(parsedData, 'crm.interest'),
    getNestedValue(parsedData, 'ai.interest'),
  );
  if (directInterest) {
    return directInterest;
  }

  const tagInterest = tags.find((tag) => !STAGE_VALUES.includes(tag.toLowerCase()));
  if (tagInterest) {
    return tagInterest;
  }

  if (notes) {
    return notes.split(/[\.\n،]/)[0]?.trim() || DEFAULT_FALLBACKS.interest;
  }

  return DEFAULT_FALLBACKS.interest;
}

function inferEngagementHistory(lastInteraction?: string): string {
  if (!lastInteraction) {
    return 'هنوز تعامل ثبت‌شده‌ای ندارد';
  }

  const interactionTime = new Date(lastInteraction).getTime();
  if (Number.isNaN(interactionTime)) {
    return 'تعامل قبلی ثبت شده است';
  }

  const daysSince = Math.floor((Date.now() - interactionTime) / (1000 * 60 * 60 * 24));
  if (daysSince <= 1) {
    return 'در 24 ساعت اخیر تعامل داشته';
  }
  if (daysSince <= 7) {
    return 'در هفته اخیر فعال بوده';
  }
  if (daysSince <= 30) {
    return 'در ماه اخیر تعامل داشته';
  }

  return 'مدتی از آخرین تعامل گذشته';
}

function inferOfferType(stage: string, interest: string): string {
  switch (stage) {
    case 'customer':
      return 'پیشنهاد ارتقا یا خرید مجدد';
    case 'opportunity':
      return 'دعوت به دمو یا جمع‌بندی نهایی';
    case 'qualified':
      return 'پیشنهاد متناسب با نیاز اعلام‌شده';
    case 'warm':
      return `معرفی کوتاه مرتبط با ${interest}`;
    default:
      return 'معرفی کوتاه و کم‌اصطکاک';
  }
}

function buildResolvedContext(contact: ContactVariables, includeFallbacks = true): Record<string, string> {
  const parsedData = parseLooseJson(contact.parsedData);
  const parsedCustomFields = parseLooseJson(parsedData.customFields);
  const contactCustomFields = parseLooseJson(contact.customFields);
  const customFields = { ...parsedCustomFields, ...contactCustomFields };
  const tags = normalizeTags(contact.tags || parsedData.tags || customFields.tags);

  const rawFullName = pickFirstString(
    contact.fullName,
    contact.name,
    parsedData.fullName,
    parsedData.name,
    customFields.fullName,
    customFields.name,
  );
  const fullName = rawFullName || (includeFallbacks ? DEFAULT_FALLBACKS.name : undefined);
  const rawFirstName = pickFirstString(
    contact.firstName,
    parsedData.firstName,
    customFields.firstName,
    rawFullName?.split(/\s+/)[0],
  );
  const firstName = rawFirstName || (includeFallbacks ? DEFAULT_FALLBACKS.firstName : undefined);
  const company = pickFirstString(contact.company, parsedData.company, customFields.company) || (includeFallbacks ? DEFAULT_FALLBACKS.company : undefined);
  const city = pickFirstString(contact.city, parsedData.city, customFields.city) || (includeFallbacks ? DEFAULT_FALLBACKS.city : undefined);
  const country = pickFirstString(contact.country, parsedData.country, customFields.country) || (includeFallbacks ? DEFAULT_FALLBACKS.country : undefined);
  const timezone = pickFirstString(contact.timezone, parsedData.timezone, customFields.timezone) || (includeFallbacks ? DEFAULT_FALLBACKS.timezone : undefined);
  const language = pickFirstString(contact.language, parsedData.language, customFields.language, parsedData.locale) || (includeFallbacks ? DEFAULT_FALLBACKS.language : undefined);
  const stage = inferStage(parsedData, tags, pickFirstString(contact.lastInteraction, parsedData.lastInteraction));
  const notes = pickFirstString(contact.notes, parsedData.notes, customFields.notes);
  const interest = inferInterest(parsedData, tags, notes);
  const sourceGroup = pickFirstString(contact.source, parsedData.sourceGroup, parsedData.source, customFields.sourceGroup, customFields.source) || (includeFallbacks ? DEFAULT_FALLBACKS.sourceGroup : undefined);
  const job = pickFirstString(contact.job, contact.jobTitle, parsedData.job, parsedData.jobTitle, customFields.job, customFields.jobTitle, customFields.role) || (includeFallbacks ? DEFAULT_FALLBACKS.job : undefined);
  const industry = pickFirstString(contact.industry, parsedData.industry, customFields.industry, parsedData.sector, customFields.sector) || (includeFallbacks ? DEFAULT_FALLBACKS.industry : undefined);
  const engagementHistory = pickFirstString(parsedData.engagementHistory, customFields.engagementHistory) || inferEngagementHistory(pickFirstString(contact.lastInteraction, parsedData.lastInteraction));
  const offerType = pickFirstString(contact.offerType, parsedData.offerType, customFields.offerType) || inferOfferType(stage, interest);
  const phone = pickFirstString(contact.phone, parsedData.phone, customFields.phone) || (includeFallbacks ? DEFAULT_FALLBACKS.phone : undefined);
  const email = pickFirstString(contact.email, parsedData.email, customFields.email) || (includeFallbacks ? DEFAULT_FALLBACKS.email : undefined);

  return Object.entries({
    name: fullName,
    fullName,
    firstName,
    phone,
    email,
    company,
    city,
    country,
    timezone,
    language,
    job,
    industry,
    stage,
    interest,
    sourceGroup,
    source: sourceGroup,
    engagementHistory,
    offerType,
    today: new Date().toLocaleDateString('fa-IR'),
    tomorrow: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('fa-IR'),
    currentTime: new Date().toLocaleTimeString('fa-IR'),
    ...Object.entries(customFields).reduce((acc, [key, value]) => {
      const normalized = asTrimmedString(value);
      if (normalized) {
        acc[key] = normalized;
      }
      return acc;
    }, {} as Record<string, string>),
  }).reduce((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, string>);
}

function getExplicitVariableValue(contact: ContactVariables, variable: string): any {
  const rawContext = buildResolvedContext(contact, false);

  if (contact[variable] !== undefined) {
    return contact[variable];
  }

  const directContextValue = resolveVariableValue(rawContext, variable);
  if (directContextValue !== undefined) {
    return directContextValue;
  }

  if (contact.customFields && contact.customFields[variable] !== undefined) {
    return contact.customFields[variable];
  }

  const parsedData = parseLooseJson(contact.parsedData);
  if (parsedData[variable] !== undefined) {
    return parsedData[variable];
  }

  if (variable === 'today') {
    return new Date().toLocaleDateString('fa-IR');
  }
  if (variable === 'tomorrow') {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('fa-IR');
  }
  if (variable === 'currentTime') {
    return new Date().toLocaleTimeString('fa-IR');
  }

  return undefined;
}

function resolveVariableValue(context: Record<string, string>, variable: string): string | undefined {
  const normalizedVariable = normalizeVariableKey(variable);

  for (const [canonicalKey, aliases] of Object.entries(VARIABLE_ALIASES)) {
    if (aliases.some((alias) => normalizeVariableKey(alias) === normalizedVariable)) {
      return context[canonicalKey] || context[aliases[0]];
    }
  }

  const directKey = Object.keys(context).find((key) => normalizeVariableKey(key) === normalizedVariable);
  return directKey ? context[directKey] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyReplacement(template: string, variable: string, value: string): string {
  const regex = new RegExp(`\\{\\{\\s*${escapeRegExp(variable)}\\s*\\}\\}`, 'g');
  return template.replace(regex, value);
}

function getFallbackValue(variable: string, resolvedValue?: string): string {
  if (resolvedValue) {
    return resolvedValue;
  }

  const normalizedVariable = normalizeVariableKey(variable);
  const canonicalKey = Object.entries(VARIABLE_ALIASES)
    .find(([, aliases]) => aliases.some((alias) => normalizeVariableKey(alias) === normalizedVariable))?.[0];

  return DEFAULT_FALLBACKS[canonicalKey || variable] || 'مقدار تکمیلی';
}

/**
 * Extracts all variables from message template
 * Variables are in format {{variable_name}}
 */
export function extractVariables(message: string): string[] {
  const regex = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const variables: string[] = [];
  let match;

  while ((match = regex.exec(message)) !== null) {
    variables.push(match[1].trim());
  }

  return [...new Set(variables)]; // Remove duplicates
}

/**
 * Personalizes a message by replacing variables with contact data
 */
export function personalizeMessage(
  message: string,
  contact: ContactVariables
): PersonalizationResult {
  try {
    let personalizedMessage = message;
    const variables = extractVariables(message);
    const replacedVariables: string[] = [];
    const missingVariables: string[] = [];
    const fallbackVariables: string[] = [];
    const rawContext = buildResolvedContext(contact, false);
    const availableContext = buildResolvedContext(contact, true);
    const resolvedContext: Record<string, string> = {};

    // Replace each variable
    for (const variable of variables) {
      const directValue = getExplicitVariableValue(contact, variable);
      const resolvedValue = directValue !== undefined && directValue !== null && String(directValue).trim()
        ? String(directValue).trim()
        : resolveVariableValue(rawContext, variable);
      const replacementValue = getFallbackValue(variable, resolvedValue);

      personalizedMessage = applyReplacement(personalizedMessage, variable, replacementValue);
      resolvedContext[variable] = replacementValue;

      if (resolvedValue !== undefined && resolvedValue !== null && String(resolvedValue).trim()) {
        replacedVariables.push(variable);
      } else {
        missingVariables.push(variable);
        fallbackVariables.push(variable);
      }
    }

    return {
      originalMessage: message,
      personalizedMessage,
      variables,
      replacedVariables,
      missingVariables,
      fallbackVariables,
      resolvedContext,
      availableContext,
    };
  } catch (error) {
    logger.error(`Error personalizing message: ${error}`);
    return {
      originalMessage: message,
      personalizedMessage: message,
      variables: [],
      replacedVariables: [],
      missingVariables: [],
      fallbackVariables: [],
      resolvedContext: {},
      availableContext: {},
    };
  }
}

/**
 * Gets variable value from contact object
 * Supports nested fields and custom handling
 */
function getVariableValue(contact: ContactVariables, variable: string): any {
  const context = buildResolvedContext(contact, false);

  // Direct match
  if (contact[variable] !== undefined) {
    return contact[variable];
  }

  const directContextValue = resolveVariableValue(context, variable);
  if (directContextValue !== undefined) {
    return directContextValue;
  }

  // Custom field match
  if (contact.customFields && contact.customFields[variable] !== undefined) {
    return contact.customFields[variable];
  }

  const parsedData = parseLooseJson(contact.parsedData);
  if (parsedData[variable] !== undefined) {
    return parsedData[variable];
  }

  // Date-based variables
  if (variable === 'today') {
    return new Date().toLocaleDateString('fa-IR');
  }
  if (variable === 'tomorrow') {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('fa-IR');
  }
  if (variable === 'currentTime') {
    return new Date().toLocaleTimeString('fa-IR');
  }

  return undefined;
}

/**
 * Personalizes multiple messages for different contacts
 */
export function personalizeMessages(
  message: string,
  contacts: ContactVariables[]
): PersonalizationResult[] {
  return contacts.map(contact => personalizeMessage(message, contact));
}

/**
 * Validates if all required variables are available in contact
 */
export function validateMessageVariables(
  message: string,
  contact: ContactVariables
): boolean {
  const variables = extractVariables(message);
  return variables.every(variable => {
    const value = getVariableValue(contact, variable);
    return value !== undefined && value !== null;
  });
}

/**
 * Gets missing variables for a contact
 */
export function getMissingVariables(
  message: string,
  contact: ContactVariables
): string[] {
  const variables = extractVariables(message);
  return variables.filter(variable => {
    const value = getVariableValue(contact, variable);
    return value === undefined || value === null;
  });
}

/**
 * Replace variables with placeholder text for preview
 */
export function previewMessage(message: string): string {
  const variables = extractVariables(message);
  let preview = message;

  for (const variable of variables) {
    const regex = new RegExp(`\\{\\{\\s*${escapeRegExp(variable)}\\s*\\}\\}`, 'g');
    const placeholder = `[${variable.toUpperCase()}]`;
    preview = preview.replace(regex, placeholder);
  }

  return preview;
}

export function analyzeMessageTemplate(
  message: string,
  contacts: ContactVariables[] = []
): TemplateAnalysisResult {
  const variables = extractVariables(message);
  const normalizedSupportedKeys = new Set(
    Object.values(VARIABLE_ALIASES).flat().map((key) => normalizeVariableKey(key))
  );

  const contactCoverage = contacts.length > 0
    ? {
        totalContacts: contacts.length,
        perVariable: variables.map((variable) => {
          let availableCount = 0;
          let fallbackCount = 0;

          contacts.forEach((contact) => {
            const directValue = getExplicitVariableValue(contact, variable);
            if (directValue !== undefined && directValue !== null && String(directValue).trim()) {
              availableCount += 1;
              return;
            }

            const fallbackValue = getFallbackValue(variable);
            if (fallbackValue) {
              fallbackCount += 1;
            }
          });

          const missingCount = Math.max(0, contacts.length - availableCount - fallbackCount);
          return {
            variable,
            availableCount,
            fallbackCount,
            missingCount,
            coverageRate: contacts.length > 0 ? Number((availableCount / contacts.length).toFixed(2)) : 0,
          };
        }),
      }
    : undefined;

  return {
    message,
    variables,
    count: variables.length,
    supportedVariables: COMMON_VARIABLES,
    unknownVariables: variables.filter((variable) => !normalizedSupportedKeys.has(normalizeVariableKey(variable))),
    samplePreview: previewMessage(message),
    contactCoverage,
  };
}

/**
 * Provides message template suggestions based on available contact fields
 */
export function getTemplateTemplate(): string {
  return `سلام {{firstName}}،

با توجه به اینکه در {{industry}} فعال هستید، یک {{offerType}} برای {{company}} آماده کرده‌ایم.
اگر مایل باشید خیلی کوتاه درباره آن توضیح می‌دهم.

${process.env.COMPANY_NAME || 'ارادتمند'}`;
}

/**
 * Suggested variables for common use cases
 */
export const COMMON_VARIABLES = {
  name: 'نام کامل مخاطب',
  firstName: 'نام کوچک مخاطب',
  phone: 'شماره تماس مخاطب',
  email: 'ایمیل مخاطب',
  company: 'نام شرکت یا کسب‌وکار مخاطب',
  city: 'شهر مخاطب',
  country: 'کشور مخاطب',
  timezone: 'منطقه زمانی مخاطب',
  language: 'زبان ترجیحی مخاطب',
  job: 'شغل یا سمت مخاطب',
  industry: 'صنعت یا حوزه کاری مخاطب',
  stage: 'مرحله فعلی لید در پایپ‌لاین',
  interest: 'علاقه‌مندی یا نیاز اصلی مخاطب',
  sourceGroup: 'کانال یا گروه منبع جذب',
  engagementHistory: 'خلاصه وضعیت تعامل اخیر',
  offerType: 'نوع پیشنهاد مناسب این مخاطب',
  today: 'تاریخ امروز',
  tomorrow: 'تاریخ فردا',
  currentTime: 'زمان فعلی',
};
