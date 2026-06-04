import { db } from '../database';
import { whatsappAccounts } from '../database/schema';
import { sendMessage } from '../modules/whatsapp/baileys.service';
import { logger } from '../utils/logger';
import { eq } from 'drizzle-orm';

const WARMUP_MESSAGES = [
  "سلام، خسته نباشید",
  "وقت بخیر",
  "سلام، این یک پیام تست برای بررسی وضعیت خط است",
  "سلام، صدای من رو دارید؟",
  "تست ارتباط سرور",
  "سلام، خوب هستید؟",
  "ارتباط برقرار است، ممنون",
  "یک پیام تستی دیگر",
  "چطوری؟",
  "در حال همگام‌سازی خط...",
  "سلام، آیا پیام من دریافت شد؟"
];

// Helper to pick random message
function getRandomMessage() {
  return WARMUP_MESSAGES[Math.floor(Math.random() * WARMUP_MESSAGES.length)];
}

/**
 * Execute warmup by sending messages between our own connected accounts.
 * This simulates human behavior and warms up the accounts to prevent bans.
 */
export async function executeInterAccountWarmup() {
  try {
    // 1. Get all connected accounts
    const allAccounts = db.select()
      .from(whatsappAccounts)
      .all()
      .filter((account: any) => account.status === 'connected' && account.phoneNumber);

    if (allAccounts.length < 2) {
      logger.info('Warmup skipped: Need at least 2 connected accounts with phone numbers.');
      return { success: true, message: 'Not enough accounts to run inter-account warmup.' };
    }

    logger.info(`Starting inter-account warmup between ${allAccounts.length} accounts...`);
    
    const warmupLogs = [];
    
    // We send a few random messages between random pairs of accounts
    const pairsCount = Math.min(allAccounts.length, 5); // Just do a few pairs per execution
    for (let i = 0; i < pairsCount; i++) {
        // Pick random sender
        const senderIndex = Math.floor(Math.random() * allAccounts.length);
        const sender = allAccounts[senderIndex];
        
        // Pick random receiver (different from sender)
        let receiverIndex;
        do {
            receiverIndex = Math.floor(Math.random() * allAccounts.length);
        } while (receiverIndex === senderIndex);
        const receiver = allAccounts[receiverIndex];

        const message = getRandomMessage();
        
        try {
            logger.info(`Sending warmup message from ${sender.phoneNumber} to ${receiver.phoneNumber}`);
            await sendMessage(
                sender.id,
                receiver.phoneNumber as string,
                message
            );
            
            warmupLogs.push({
                from: sender.phoneNumber,
                to: receiver.phoneNumber,
                status: 'success'
            });
            
            // Random delay between 2-6 seconds between warmup tasks
            await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 4000));
        } catch (error: any) {
             logger.error(`Warmup message failed from ${sender.phoneNumber} to ${receiver.phoneNumber}: ${error.message}`);
             warmupLogs.push({
                from: sender.phoneNumber,
                to: receiver.phoneNumber,
                status: 'failed',
                error: error.message
            });
        }
    }
    
    return {
        success: true,
        message: 'Inter-account warmup completed',
        logs: warmupLogs
    };

  } catch (error: any) {
    logger.error('Failed to execute inter-account warmup:', error);
    return { success: false, error: error.message };
  }
}
