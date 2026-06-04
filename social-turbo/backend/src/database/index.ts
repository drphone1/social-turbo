import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import * as schema from './schema';

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'database', 'whatsapp-turbo.db');

// Ensure directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Delete corrupted database if it exists and we are starting fresh
// We will try to open it, if it fails with malformed, we delete it.
let sqlite: Database.Database | undefined;
try {
  sqlite = new Database(dbPath);
  // Test if it's malformed by running a simple query
  sqlite.pragma('schema_version');
} catch (error: any) {
  if (error.message.includes('malformed') || error.code === 'SQLITE_CORRUPT') {
    logger.warn('Database is malformed. Deleting and recreating...');
    if (sqlite) sqlite.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
    sqlite = new Database(dbPath);
  } else {
    throw error;
  }
}

const finalSqlite = sqlite as Database.Database;

// Enable WAL mode to prevent future corruption
finalSqlite.pragma('journal_mode = WAL');
finalSqlite.pragma('synchronous = NORMAL');

export { finalSqlite as sqlite };
export const db = drizzle(finalSqlite, { schema });

export async function initializeDatabase() {
  logger.info('Initializing Database...');
  
  finalSqlite.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_accounts (
      id TEXT PRIMARY KEY,
      phone_number TEXT,
      display_name TEXT,
      status TEXT DEFAULT 'connecting',
      session_path TEXT,
      proxy_profile_id TEXT,
      warm_up_profile_id TEXT,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS proxy_profiles (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      host TEXT,
      port INTEGER,
      username TEXT,
      password TEXT,
      rotation_policy TEXT,
      test_status TEXT,
      last_tested DATETIME
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT,
      phone TEXT,
      email TEXT,
      country TEXT,
      city TEXT,
      timezone TEXT,
      language TEXT,
      tags TEXT,
      segments TEXT,
      source TEXT,
      consent_status TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_interaction DATETIME
    );

    CREATE TABLE IF NOT EXISTS account_contacts (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      phone TEXT,
      name TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'draft',
      account_ids TEXT,
      contact_ids TEXT,
      segment_id TEXT,
      message_template TEXT,
      media_path TEXT,
      schedule_type TEXT,
      scheduled_at DATETIME,
      max_per_hour INTEGER,
      max_per_day INTEGER,
      delay_min_ms INTEGER,
      delay_max_ms INTEGER,
      sent_count INTEGER DEFAULT 0,
      delivered_count INTEGER DEFAULT 0,
      read_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      blocked_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS message_logs (
      id TEXT PRIMARY KEY,
      whatsapp_account_id TEXT,
      contact_id TEXT,
      campaign_id TEXT,
      direction TEXT,
      message_type TEXT,
      content TEXT,
      media_path TEXT,
      status TEXT,
      ai_model_used TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaign_events (
      id TEXT PRIMARY KEY,
      campaign_id TEXT,
      account_id TEXT,
      contact_id TEXT,
      level TEXT,
      event_type TEXT,
      message TEXT,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY,
      type TEXT,
      payload TEXT,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      scheduled_at DATETIME,
      started_at DATETIME,
      completed_at DATETIME,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      base_url TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      key_value TEXT,
      quota_daily INTEGER,
      usage_today INTEGER DEFAULT 0,
      priority INTEGER,
      status TEXT DEFAULT 'active',
      last_used DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_control_logs (
      id TEXT PRIMARY KEY,
      provider TEXT,
      model TEXT,
      instruction TEXT,
      planning_mode TEXT,
      plan_summary TEXT,
      action_type TEXT,
      action_params TEXT,
      success INTEGER DEFAULT 0,
      error TEXT,
      result_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_governance_logs (
      id TEXT PRIMARY KEY,
      action_type TEXT,
      action_params TEXT,
      approval_state TEXT,
      requires_approval INTEGER DEFAULT 0,
      risk_level TEXT,
      blocked INTEGER DEFAULT 0,
      executed INTEGER DEFAULT 0,
      warnings TEXT,
      target_summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auto_reply_rules (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      trigger_type TEXT,
      keywords TEXT,
      working_hours TEXT,
      ai_provider_id TEXT,
      ai_model TEXT,
      system_prompt TEXT,
      media_path TEXT,
      media_type TEXT,
      media_mime_type TEXT,
      media_file_name TEXT,
      send_as_voice_note INTEGER DEFAULT 0,
      silent_policy TEXT,
      language_policy TEXT,
      escalation_keywords TEXT,
      allow_followup INTEGER DEFAULT 1,
      response_delay_min_ms INTEGER,
      response_delay_max_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auto_reply_logs (
      id TEXT PRIMARY KEY,
      rule_id TEXT,
      from_phone TEXT,
      incoming_message TEXT,
      auto_reply TEXT,
      media_path TEXT,
      media_type TEXT,
      status TEXT,
      decision_type TEXT,
      detected_intent TEXT,
      detected_language TEXT,
      escalation_reason TEXT,
      brain_context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS group_extractions (
      id TEXT PRIMARY KEY,
      whatsapp_account_id TEXT,
      group_id TEXT,
      group_name TEXT,
      member_count INTEGER,
      extracted_count INTEGER DEFAULT 0,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS warm_up_profiles (
      id TEXT PRIMARY KEY,
      name TEXT,
      total_days INTEGER,
      daily_plan TEXT,
      current_day INTEGER DEFAULT 1,
      status TEXT DEFAULT 'idle',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS network_diagnostics (
      id TEXT PRIMARY KEY,
      host TEXT,
      status TEXT,
      ping_ms INTEGER,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      whatsapp_account_id TEXT,
      contact_id TEXT,
      status TEXT DEFAULT 'open',
      unread_count INTEGER DEFAULT 0,
      last_message_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      whatsapp_account_id TEXT,
      jid TEXT,
      name TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      contact_id TEXT,
      role TEXT DEFAULT 'member',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contact_activities (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      action TEXT,
      description TEXT,
      details TEXT,
      type TEXT,
      activity_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contact_tasks (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      title TEXT,
      description TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      due_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );
  `);

  // Run migrations for new columns
  try {
    finalSqlite.exec("ALTER TABLE contacts ADD COLUMN parsed_data TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding parsed_data to contacts:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE message_logs ADD COLUMN parsed_data TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding parsed_data to message_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE message_logs ADD COLUMN conversation_id TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding conversation_id to message_logs:', e);
    }
  }

  // New migrations for latest features
  try {
    finalSqlite.exec("ALTER TABLE groups ADD COLUMN last_message_at DATETIME;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('no such column')) {
      logger.error('Error adding last_message_at to groups:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE account_contacts ADD COLUMN last_interaction DATETIME;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name') && !e.message.includes('no such column')) {
      logger.error('Error adding last_interaction to account_contacts:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN media_path TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding media_path to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN media_type TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding media_type to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN media_mime_type TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding media_mime_type to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN media_file_name TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding media_file_name to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN send_as_voice_note INTEGER DEFAULT 0;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding send_as_voice_note to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN media_path TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding media_path to auto_reply_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN media_type TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding media_type to auto_reply_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN silent_policy TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding silent_policy to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN language_policy TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding language_policy to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN escalation_keywords TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding escalation_keywords to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_rules ADD COLUMN allow_followup INTEGER DEFAULT 1;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding allow_followup to auto_reply_rules:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN decision_type TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding decision_type to auto_reply_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN detected_intent TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding detected_intent to auto_reply_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN detected_language TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding detected_language to auto_reply_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN escalation_reason TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding escalation_reason to auto_reply_logs:', e);
    }
  }

  try {
    finalSqlite.exec("ALTER TABLE auto_reply_logs ADD COLUMN brain_context TEXT;");
  } catch (e: any) {
    if (!e.message.includes('duplicate column name')) {
      logger.error('Error adding brain_context to auto_reply_logs:', e);
    }
  }
  
  logger.info('Database initialized successfully.');
}
