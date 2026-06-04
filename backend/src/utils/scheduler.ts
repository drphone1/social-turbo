/**
 * Message Scheduling Service
 * Schedule messages to be sent at specific times
 */

import { logger } from './logger';

export interface ScheduledMessage {
  id: string;
  accountId: string;
  recipientPhone: string;
  message: string;
  scheduledTime: Date;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  createdAt: Date;
  sentAt?: Date;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

// In-memory storage (in production, use database)
const scheduledMessages = new Map<string, ScheduledMessage>();

/**
 * Schedule a message to be sent later
 */
export function scheduleMessage(
  accountId: string,
  recipientPhone: string,
  message: string,
  scheduledTime: Date
): ScheduledMessage {
  const id = generateScheduleId();
  
  if (scheduledTime <= new Date()) {
    throw new Error('Scheduled time must be in the future');
  }

  const scheduled: ScheduledMessage = {
    id,
    accountId,
    recipientPhone,
    message,
    scheduledTime,
    status: 'pending',
    createdAt: new Date(),
    retryCount: 0,
    maxRetries: 3,
  };

  scheduledMessages.set(id, scheduled);
  logger.info(`Message scheduled: ${id} for ${recipientPhone} at ${scheduledTime}`);
  return scheduled;
}

/**
 * Get scheduled message by ID
 */
export function getScheduledMessage(id: string): ScheduledMessage | null {
  return scheduledMessages.get(id) || null;
}

/**
 * Get all scheduled messages
 */
export function getAllScheduledMessages(): ScheduledMessage[] {
  return Array.from(scheduledMessages.values());
}

/**
 * Get pending messages ready to send
 */
export function getPendingMessages(): ScheduledMessage[] {
  const now = new Date();
  return Array.from(scheduledMessages.values()).filter(
    m => m.status === 'pending' && m.scheduledTime <= now
  );
}

/**
 * Get messages by account
 */
export function getMessagesByAccount(accountId: string): ScheduledMessage[] {
  return Array.from(scheduledMessages.values()).filter(m => m.accountId === accountId);
}

/**
 * Get upcoming messages for account
 */
export function getUpcomingMessages(accountId: string, hoursAhead = 24): ScheduledMessage[] {
  const now = new Date();
  const future = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  return Array.from(scheduledMessages.values()).filter(
    m => m.accountId === accountId &&
         m.status === 'pending' &&
         m.scheduledTime >= now &&
         m.scheduledTime <= future
  );
}

/**
 * Mark message as sent
 */
export function markAsSent(id: string): ScheduledMessage | null {
  const msg = scheduledMessages.get(id);
  if (!msg) return null;

  msg.status = 'sent';
  msg.sentAt = new Date();
  logger.info(`Message marked as sent: ${id}`);
  return msg;
}

/**
 * Mark message as failed
 */
export function markAsFailed(id: string, error: string): ScheduledMessage | null {
  const msg = scheduledMessages.get(id);
  if (!msg) return null;

  msg.retryCount++;
  msg.error = error;

  if (msg.retryCount >= msg.maxRetries) {
    msg.status = 'failed';
    logger.error(`Message marked as failed (max retries): ${id}`);
  } else {
    // Reschedule for retry
    const retryDelay = Math.pow(2, msg.retryCount) * 5 * 60 * 1000; // Exponential backoff
    msg.scheduledTime = new Date(new Date().getTime() + retryDelay);
    logger.info(`Message retry scheduled: ${id} after ${retryDelay / 60000} minutes`);
  }

  return msg;
}

/**
 * Cancel scheduled message
 */
export function cancelMessage(id: string): ScheduledMessage | null {
  const msg = scheduledMessages.get(id);
  if (!msg) return null;

  if (msg.status === 'sent' || msg.status === 'failed') {
    throw new Error(`Cannot cancel ${msg.status} message`);
  }

  msg.status = 'cancelled';
  logger.info(`Message cancelled: ${id}`);
  return msg;
}

/**
 * Reschedule message
 */
export function rescheduleMessage(id: string, newTime: Date): ScheduledMessage | null {
  const msg = scheduledMessages.get(id);
  if (!msg) return null;

  if (msg.status === 'sent') {
    throw new Error('Cannot reschedule a sent message');
  }

  if (newTime <= new Date()) {
    throw new Error('New scheduled time must be in the future');
  }

  msg.scheduledTime = newTime;
  logger.info(`Message rescheduled: ${id} for ${newTime}`);
  return msg;
}

/**
 * Delete scheduled message
 */
export function deleteMessage(id: string): boolean {
  const deleted = scheduledMessages.delete(id);
  if (deleted) {
    logger.info(`Message deleted: ${id}`);
  }
  return deleted;
}

/**
 * Get scheduling statistics
 */
export function getSchedulingStats(): Record<string, any> {
  const all = getAllScheduledMessages();
  const now = new Date();

  const pending = all.filter(m => m.status === 'pending');
  const sent = all.filter(m => m.status === 'sent');
  const failed = all.filter(m => m.status === 'failed');

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const scheduledToday = pending.filter(m => m.scheduledTime >= today && m.scheduledTime < tomorrow);
  const overdue = pending.filter(m => m.scheduledTime <= now);

  return {
    total: all.length,
    pending: pending.length,
    sent: sent.length,
    failed: failed.length,
    cancelled: all.filter(m => m.status === 'cancelled').length,
    todayScheduled: scheduledToday.length,
    overdue: overdue.length,
    avgRetries: all.length > 0 ? (all.reduce((sum, m) => sum + m.retryCount, 0) / all.length).toFixed(2) : 0,
  };
}

/**
 * Batch schedule messages
 */
export function batchScheduleMessages(
  accountId: string,
  recipients: Array<{ phone: string; message: string }>,
  scheduledTime: Date
): ScheduledMessage[] {
  return recipients.map(r =>
    scheduleMessage(accountId, r.phone, r.message, scheduledTime)
  );
}

/**
 * Generate schedule ID
 */
function generateScheduleId(): string {
  return `sch_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Start scheduling worker
 * In production, this would be a background job
 */
export function startSchedulingWorker(onMessageReady: (msg: ScheduledMessage) => void): NodeJS.Timer {
  return setInterval(() => {
    const pending = getPendingMessages();
    for (const msg of pending) {
      logger.info(`Message ready to send: ${msg.id}`);
      onMessageReady(msg);
    }
  }, 60000); // Check every minute
}
