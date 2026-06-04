import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const whatsappAccounts = sqliteTable('whatsapp_accounts', {
  id: text('id').primaryKey(),
  phoneNumber: text('phone_number'),
  displayName: text('display_name'),
  status: text('status').default('connecting'),
  sessionPath: text('session_path'),
  proxyProfileId: text('proxy_profile_id'),
  warmUpProfileId: text('warm_up_profile_id'),
  tags: text('tags'),
  createdAt: text('created_at'),
  lastActive: text('last_active'),
  lastError: text('last_error')
});

export const proxyProfiles = sqliteTable('proxy_profiles', {
  id: text('id').primaryKey(),
  name: text('name'),
  type: text('type'),
  host: text('host'),
  port: integer('port'),
  username: text('username'),
  password: text('password'),
  rotationPolicy: text('rotation_policy'),
  testStatus: text('test_status'),
  lastTested: text('last_tested')
});

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  fullName: text('full_name'),
  phone: text('phone'),
  email: text('email'),
  country: text('country'),
  city: text('city'),
  timezone: text('timezone'),
  language: text('language'),
  tags: text('tags'),
  segments: text('segments'),
  source: text('source'),
  consentStatus: text('consent_status'),
  notes: text('notes'),
  parsedData: text('parsed_data'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  lastInteraction: text('last_interaction')
});

export const accountContacts = sqliteTable('account_contacts', {
  id: text('id').primaryKey(),
  accountId: text('account_id'),
  phone: text('phone'),
  name: text('name'),
  source: text('source'),
  lastInteraction: text('last_interaction'),
  createdAt: text('created_at')
});

export const campaigns = sqliteTable('campaigns', {
  id: text('id').primaryKey(),
  name: text('name'),
  status: text('status').default('draft'),
  accountIds: text('account_ids'),
  contactIds: text('contact_ids'),
  segmentId: text('segment_id'),
  messageTemplate: text('message_template'),
  mediaPath: text('media_path'),
  scheduleType: text('schedule_type'),
  scheduledAt: text('scheduled_at'),
  maxPerHour: integer('max_per_hour'),
  maxPerDay: integer('max_per_day'),
  delayMinMs: integer('delay_min_ms'),
  delayMaxMs: integer('delay_max_ms'),
  sentCount: integer('sent_count').default(0),
  deliveredCount: integer('delivered_count').default(0),
  readCount: integer('read_count').default(0),
  failedCount: integer('failed_count').default(0),
  blockedCount: integer('blocked_count').default(0),
  createdAt: text('created_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at')
});

export const messageLogs = sqliteTable('message_logs', {
  id: text('id').primaryKey(),
  whatsappAccountId: text('whatsapp_account_id'),
  contactId: text('contact_id'),
  conversationId: text('conversation_id'),
  campaignId: text('campaign_id'),
  direction: text('direction'),
  messageType: text('message_type'),
  content: text('content'),
  mediaPath: text('media_path'),
  parsedData: text('parsed_data'),
  status: text('status'),
  aiModelUsed: text('ai_model_used'),
  createdAt: text('created_at')
});

export const campaignEvents = sqliteTable('campaign_events', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id'),
  accountId: text('account_id'),
  contactId: text('contact_id'),
  level: text('level'),
  eventType: text('event_type'),
  message: text('message'),
  payload: text('payload'),
  createdAt: text('created_at')
});

export const queueJobs = sqliteTable('queue_jobs', {
  id: text('id').primaryKey(),
  type: text('type'),
  payload: text('payload'),
  status: text('status').default('pending'),
  priority: integer('priority').default(5),
  attempts: integer('attempts').default(0),
  maxAttempts: integer('max_attempts').default(3),
  scheduledAt: text('scheduled_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at')
});

export const aiProviders = sqliteTable('ai_providers', {
  id: text('id').primaryKey(),
  name: text('name'),
  type: text('type'),
  baseUrl: text('base_url'),
  isActive: integer('is_active').default(1),
  createdAt: text('created_at')
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  provider: text('provider'), // openai, gemini, claude
  apiKey: text('api_key'),
  modelName: text('model_name'),
  isActive: integer('is_active').default(1),
  quotaDaily: integer('quota_daily'),
  usageToday: integer('usage_today').default(0),
  lastUsed: text('last_used'),
  lastError: text('last_error'),
  createdAt: text('created_at')
});

export const aiControlLogs = sqliteTable('ai_control_logs', {
  id: text('id').primaryKey(),
  provider: text('provider'),
  model: text('model'),
  instruction: text('instruction'),
  planningMode: text('planning_mode'),
  planSummary: text('plan_summary'),
  actionType: text('action_type'),
  actionParams: text('action_params'),
  success: integer('success').default(0),
  error: text('error'),
  resultData: text('result_data'),
  createdAt: text('created_at')
});

export const aiGovernanceLogs = sqliteTable('ai_governance_logs', {
  id: text('id').primaryKey(),
  actionType: text('action_type'),
  actionParams: text('action_params'),
  approvalState: text('approval_state'),
  requiresApproval: integer('requires_approval').default(0),
  riskLevel: text('risk_level'),
  blocked: integer('blocked').default(0),
  executed: integer('executed').default(0),
  warnings: text('warnings'),
  targetSummary: text('target_summary'),
  createdAt: text('created_at')
});

export const autoReplyRules = sqliteTable('auto_reply_rules', {
  id: text('id').primaryKey(),
  accountId: text('account_id'),
  name: text('name'),
  isActive: integer('is_active').default(1),
  triggerType: text('trigger_type'),
  keywords: text('keywords'),
  workingHours: text('working_hours'),
  aiProviderId: text('ai_provider_id'),
  aiModel: text('ai_model'),
  systemPrompt: text('system_prompt'),
  mediaPath: text('media_path'),
  mediaType: text('media_type'),
  mediaMimeType: text('media_mime_type'),
  mediaFileName: text('media_file_name'),
  sendAsVoiceNote: integer('send_as_voice_note').default(0),
  silentPolicy: text('silent_policy'),
  languagePolicy: text('language_policy'),
  escalationKeywords: text('escalation_keywords'),
  allowFollowup: integer('allow_followup').default(1),
  responseDelayMinMs: integer('response_delay_min_ms'),
  responseDelayMaxMs: integer('response_delay_max_ms'),
  createdAt: text('created_at')
});

export const autoReplyLogs = sqliteTable('auto_reply_logs', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id'),
  fromPhone: text('from_phone'),
  incomingMessage: text('incoming_message'),
  autoReply: text('auto_reply'),
  mediaPath: text('media_path'),
  mediaType: text('media_type'),
  status: text('status'),
  decisionType: text('decision_type'),
  detectedIntent: text('detected_intent'),
  detectedLanguage: text('detected_language'),
  escalationReason: text('escalation_reason'),
  brainContext: text('brain_context'),
  createdAt: text('created_at')
});

export const groupExtractions = sqliteTable('group_extractions', {
  id: text('id').primaryKey(),
  whatsappAccountId: text('whatsapp_account_id'),
  groupId: text('group_id'),
  groupName: text('group_name'),
  memberCount: integer('member_count'),
  extractedCount: integer('extracted_count').default(0),
  status: text('status'),
  createdAt: text('created_at')
});

export const warmUpProfiles = sqliteTable('warm_up_profiles', {
  id: text('id').primaryKey(),
  name: text('name'),
  totalDays: integer('total_days'),
  dailyPlan: text('daily_plan'),
  currentDay: integer('current_day').default(1),
  status: text('status').default('idle'),
  createdAt: text('created_at')
});

export const networkDiagnostics = sqliteTable('network_diagnostics', {
  id: text('id').primaryKey(),
  host: text('host'),
  status: text('status'),
  pingMs: integer('ping_ms'),
  checkedAt: text('checked_at')
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  whatsappAccountId: text('whatsapp_account_id'),
  contactId: text('contact_id'),
  status: text('status').default('open'), // open, closed, pending
  unreadCount: integer('unread_count').default(0),
  lastMessageAt: text('last_message_at'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
});

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  whatsappAccountId: text('whatsapp_account_id'),
  jid: text('jid'),
  name: text('name'),
  description: text('description'),
  lastMessageAt: text('last_message_at'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
});

export const groupMembers = sqliteTable('group_members', {
  id: text('id').primaryKey(),
  groupId: text('group_id'),
  contactId: text('contact_id'),
  role: text('role').default('member'), // admin, member
  joinedAt: text('joined_at')
});
export const contactActivities = sqliteTable('contact_activities', {
  id: text('id').primaryKey(),
  contactId: text('contact_id'),
  action: text('action'),
  description: text('description'),
  details: text('details'),
  type: text('type'),
  activityData: text('activity_data'),
  createdAt: text('created_at')
});

export const contactTasks = sqliteTable('contact_tasks', {
  id: text('id').primaryKey(),
  contactId: text('contact_id'),
  title: text('title'),
  description: text('description'),
  priority: text('priority').default('medium'), // low, medium, high
  status: text('status').default('pending'), // pending, in-progress, completed
  dueDate: text('due_date'),
  createdAt: text('created_at'),
  completedAt: text('completed_at')
});