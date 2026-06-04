import { db } from '../../database';
import { queueJobs } from '../../database/schema';
import { eq, asc } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { processCampaignJob } from '../../services/campaign.executor';

let isWorkerRunning = false;
const workerRuntime = {
  startedAt: null as string | null,
  lastHeartbeatAt: null as string | null,
  lastRunStartedAt: null as string | null,
  lastSuccessfulRunAt: null as string | null,
  lastProcessedJobId: null as string | null,
  lastProcessedAt: null as string | null,
  lastRecoveredJobs: 0,
  consecutiveFailures: 0,
  lastError: null as string | null,
};

function parseJobPayload(payload: string | null | undefined) {
  if (!payload) {
    return {};
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new Error('Queue job payload is corrupted and could not be parsed');
  }
}

function getReadyJobs() {
  const now = Date.now();

  return db.select()
    .from(queueJobs)
    .all()
    .filter((job: any) => {
      if (!['pending', 'retry'].includes(job.status || '')) {
        return false;
      }

      const scheduledAt = job.scheduledAt ? new Date(job.scheduledAt).getTime() : null;
      return scheduledAt === null || !Number.isFinite(scheduledAt) || scheduledAt <= now;
    })
    .sort((left: any, right: any) => {
      const priorityDiff = Number(left.priority || 0) - Number(right.priority || 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
    })
    .slice(0, 3);
}

function recoverStaleProcessingJobs() {
  const now = Date.now();
  const staleThresholdMs = 5 * 60 * 1000;
  const jobs = db.select().from(queueJobs).all();
  let recoveredCount = 0;

  for (const job of jobs) {
    if (job.status !== 'processing' || !job.startedAt) {
      continue;
    }

    const startedAt = new Date(job.startedAt).getTime();
    if (!Number.isFinite(startedAt) || now - startedAt < staleThresholdMs) {
      continue;
    }

    const attempts = Number(job.attempts || 0);
    const maxAttempts = Number(job.maxAttempts || 3);
    const nextAttempts = attempts + 1;
    const shouldFail = nextAttempts >= maxAttempts;

    db.update(queueJobs)
      .set({
        status: shouldFail ? 'failed' : 'retry',
        attempts: nextAttempts,
        startedAt: null,
        completedAt: shouldFail ? new Date().toISOString() : null,
        scheduledAt: shouldFail ? job.scheduledAt || null : new Date(Date.now() + 5000).toISOString(),
        errorMessage: `Recovered stale processing job after timeout window (${Math.round((now - startedAt) / 1000)}s).`,
      })
      .where(eq(queueJobs.id, job.id))
      .run();

    recoveredCount += 1;
  }

  workerRuntime.lastRecoveredJobs = recoveredCount;
  return recoveredCount;
}

function scheduleRetry(job: any, errorMessage: string) {
  const attempts = Number(job.attempts || 0) + 1;
  const maxAttempts = Number(job.maxAttempts || 3);
  const shouldFail = attempts >= maxAttempts;
  const retryDelayMs = Math.min(60000, 2000 * Math.pow(2, Math.max(0, attempts - 1)));

  db.update(queueJobs)
    .set({
      status: shouldFail ? 'failed' : 'retry',
      attempts,
      errorMessage,
      startedAt: null,
      completedAt: shouldFail ? new Date().toISOString() : null,
      scheduledAt: shouldFail ? job.scheduledAt || null : new Date(Date.now() + retryDelayMs).toISOString(),
    })
    .where(eq(queueJobs.id, job.id))
    .run();
}

export function getQueueWorkerRuntime() {
  return { ...workerRuntime };
}

export function startQueueWorker() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  workerRuntime.startedAt = new Date().toISOString();
  
  logger.info('Starting Queue Worker...');
  
  setInterval(async () => {
    workerRuntime.lastHeartbeatAt = new Date().toISOString();
    workerRuntime.lastRunStartedAt = workerRuntime.lastHeartbeatAt;

    try {
      recoverStaleProcessingJobs();
      const pendingJobs = getReadyJobs();
        
      for (const job of pendingJobs) {
        db.update(queueJobs)
          .set({ status: 'processing', startedAt: new Date().toISOString(), completedAt: null })
          .where(eq(queueJobs.id, job.id))
          .run();
          
        try {
          logger.info(`Processing job ${job.id} of type ${job.type}`);
          
          let jobResult: any = null;
          const payload = parseJobPayload(job.payload);
          
          if (job.type === 'campaign_execution') {
            jobResult = await processCampaignJob(payload);
          } else {
            throw new Error(`Unsupported queue job type: ${job.type}`);
          }
          
          const status = jobResult?.success ? 'done' : 'failed';
          const completedAt = new Date().toISOString();
          
          db.update(queueJobs)
            .set({ status, completedAt, errorMessage: jobResult?.success ? null : (jobResult?.error || 'Job completed with errors') })
            .where(eq(queueJobs.id, job.id))
            .run();
            
          if (jobResult?.success) {
            logger.info(`Job ${job.id} completed successfully`);
            workerRuntime.lastProcessedJobId = job.id;
            workerRuntime.lastProcessedAt = completedAt;
            workerRuntime.lastSuccessfulRunAt = completedAt;
            workerRuntime.consecutiveFailures = 0;
            workerRuntime.lastError = null;
          } else {
            logger.warn(`Job ${job.id} completed with errors:`, jobResult?.error);
            scheduleRetry(job, jobResult?.error || 'Job completed with partial failure');
          }
            
        } catch (error: any) {
          logger.error(`Job ${job.id} failed:`, error);
          workerRuntime.consecutiveFailures += 1;
          workerRuntime.lastError = error.message;
          scheduleRetry(job, error.message);
        }
      }

      workerRuntime.lastHeartbeatAt = new Date().toISOString();
    } catch (error) {
      logger.error('Queue worker error:', error);
      workerRuntime.consecutiveFailures += 1;
      workerRuntime.lastError = error instanceof Error ? error.message : 'Unknown queue worker error';
    }
  }, 2000);
}
