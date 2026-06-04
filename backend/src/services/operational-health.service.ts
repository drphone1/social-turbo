import { db } from '../database';
import { campaigns, networkDiagnostics, proxyProfiles, queueJobs, whatsappAccounts } from '../database/schema';
import { getQueueWorkerRuntime } from '../modules/queue/queue.service';

type ConnectionWindowKey = '1m' | '5m' | '10m';

type RouteMode = 'tunneled' | 'local' | 'unknown';

type HealthRange = 'today' | '7days' | '30days' | '90days';

type AlertSeverity = 'info' | 'warning' | 'critical';

interface RuntimeAlert {
  id: string;
  severity: AlertSeverity;
  category: 'queue' | 'account' | 'network' | 'worker';
  title: string;
  message: string;
  metric?: number | null;
  createdAt: string;
}

function resolveRange(range?: string): HealthRange {
  if (range === 'today' || range === '30days' || range === '90days') {
    return range;
  }

  return '7days';
}

function getStartDate(range?: string) {
  const normalizedRange = resolveRange(range);
  const daysBack = normalizedRange === 'today'
    ? 1
    : normalizedRange === '30days'
      ? 30
      : normalizedRange === '90days'
        ? 90
        : 7;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);
  return startDate;
}

function parseIsoDate(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function roundMetric(value: number, digits = 1) {
  const precision = Math.pow(10, digits);
  return Math.round(value * precision) / precision;
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'whatsapp-turbo-crm/connection-widget',
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function calculateJitter(latencies: number[]) {
  if (latencies.length < 2) {
    return 0;
  }

  let totalDelta = 0;
  for (let index = 1; index < latencies.length; index += 1) {
    totalDelta += Math.abs(latencies[index] - latencies[index - 1]);
  }

  return totalDelta / (latencies.length - 1);
}

function normalizeDiagnosticHost(host: string | null | undefined) {
  if (!host) {
    return 'unknown';
  }

  return String(host).replace(/#\d+$/, '');
}

function deriveRouteMode(countryCode: string | null | undefined): RouteMode {
  if (!countryCode) {
    return 'unknown';
  }

  return String(countryCode).toUpperCase() === 'IR' ? 'local' : 'tunneled';
}

function buildWindowMetrics(diagnostics: any[], windowMs: number) {
  const now = Date.now();
  const items = diagnostics.filter((item: any) => {
    const checkedAt = parseIsoDate(item.checkedAt);
    return checkedAt !== null && now - checkedAt <= windowMs;
  });
  const latencyValues = items
    .map((item: any) => Number(item.pingMs || 0))
    .filter((value: number) => Number.isFinite(value) && value >= 0);
  const onlineChecks = items.filter((item: any) => item.status === 'online').length;
  const offlineChecks = items.filter((item: any) => item.status === 'offline').length;
  const sampleCount = items.length;

  return {
    sampleCount,
    onlineChecks,
    offlineChecks,
    uptime: roundMetric(sampleCount > 0 ? (onlineChecks / sampleCount) * 100 : 0),
    avgLatency: roundMetric(
      latencyValues.length > 0
        ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
        : 0,
      0,
    ),
    packetLoss: roundMetric(sampleCount > 0 ? (offlineChecks / sampleCount) * 100 : 0, 1),
  };
}

function buildTrendPoints(diagnostics: any[]) {
  const now = Date.now();
  const minuteMs = 60 * 1000;

  return Array.from({ length: 10 }, (_, index) => {
    const bucketStart = now - (9 - index) * minuteMs;
    const bucketEnd = bucketStart + minuteMs;
    const items = diagnostics.filter((item: any) => {
      const checkedAt = parseIsoDate(item.checkedAt);
      return checkedAt !== null && checkedAt >= bucketStart && checkedAt < bucketEnd;
    });
    const latencyValues = items
      .map((item: any) => Number(item.pingMs || 0))
      .filter((value: number) => Number.isFinite(value) && value >= 0);
    const onlineChecks = items.filter((item: any) => item.status === 'online').length;
    const offlineChecks = items.filter((item: any) => item.status === 'offline').length;
    const labelDate = new Date(bucketStart);
    const label = `${String(labelDate.getHours()).padStart(2, '0')}:${String(labelDate.getMinutes()).padStart(2, '0')}`;

    return {
      label,
      latency: roundMetric(
        latencyValues.length > 0
          ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
          : 0,
        0,
      ),
      status: items.length === 0 ? 'unknown' : onlineChecks >= offlineChecks ? 'online' : 'offline',
      sampleCount: items.length,
      checkedAt: items[items.length - 1]?.checkedAt || new Date(bucketEnd).toISOString(),
    };
  });
}

async function fetchPublicNetworkIdentity() {
  try {
    const payload = await fetchJsonWithTimeout('https://ipwho.is/', 4500);
    if (payload?.success !== false) {
      return {
        ip: payload?.ip || null,
        country: payload?.country || null,
        countryCode: payload?.country_code || null,
        city: payload?.city || null,
        region: payload?.region || null,
        isp: payload?.connection?.isp || payload?.connection?.org || null,
        source: 'ipwho.is',
        routeMode: deriveRouteMode(payload?.country_code),
      };
    }
  } catch {
    // Ignore and continue to fallbacks.
  }

  try {
    const payload = await fetchJsonWithTimeout('https://ipapi.co/json/', 4500);
    return {
      ip: payload?.ip || null,
      country: payload?.country_name || null,
      countryCode: payload?.country_code || null,
      city: payload?.city || null,
      region: payload?.region || null,
      isp: payload?.org || null,
      source: 'ipapi.co',
      routeMode: deriveRouteMode(payload?.country_code),
    };
  } catch {
    return {
      ip: null,
      country: null,
      countryCode: null,
      city: null,
      region: null,
      isp: null,
      source: 'unavailable',
      routeMode: 'unknown' as RouteMode,
    };
  }
}

function isPayloadCorrupted(payload: string | null | undefined) {
  if (!payload) {
    return false;
  }

  try {
    JSON.parse(payload);
    return false;
  } catch {
    return true;
  }
}

function parseJobPayload(payload: string | null | undefined) {
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function resolvePrimaryAccountId(payload: any) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (typeof payload.accountId === 'string' && payload.accountId) {
    return payload.accountId;
  }

  if (Array.isArray(payload.accountIds)) {
    const accountId = payload.accountIds.find((value: unknown) => typeof value === 'string' && value);
    return typeof accountId === 'string' ? accountId : null;
  }

  return null;
}

function isConfiguredAccount(account: any) {
  if (!account) {
    return false;
  }

  return Boolean(
    account.phoneNumber
    || account.sessionPath
    || account.lastActive
    || account.lastError
    || account.proxyProfileId
  );
}

export function listNetworkDiagnostics(range?: string) {
  const startDate = getStartDate(range);

  return db.select()
    .from(networkDiagnostics)
    .all()
    .filter((item: any) => {
      const checkedAt = parseIsoDate(item.checkedAt);
      return checkedAt !== null && checkedAt >= startDate.getTime();
    })
    .sort((left: any, right: any) => {
      return (parseIsoDate(right.checkedAt) || 0) - (parseIsoDate(left.checkedAt) || 0);
    });
}

function buildEndpointSummaries(range?: string) {
  const diagnostics = listNetworkDiagnostics(range);
  const groupedDiagnostics = new Map<string, any[]>();

  diagnostics.forEach((item: any) => {
    const host = normalizeDiagnosticHost(item.host);
    if (!groupedDiagnostics.has(host)) {
      groupedDiagnostics.set(host, []);
    }
    groupedDiagnostics.get(host)?.push(item);
  });

  const proxyEntries = db.select().from(proxyProfiles).all();
  const knownHosts = new Set<string>();

  const endpointSummaries = proxyEntries.map((proxy: any) => {
    const hostKey = proxy.host || proxy.name || proxy.id;
    knownHosts.add(hostKey);
    const items = groupedDiagnostics.get(hostKey) || [];
    const onlineCount = items.filter((item: any) => item.status === 'online').length;
    const latencyItems = items.map((item: any) => Number(item.pingMs || 0)).filter((value: number) => Number.isFinite(value) && value >= 0);
    const latestItem = items[0] || null;
    const packetLoss = items.length > 0 ? ((items.length - onlineCount) / items.length) * 100 : proxy.testStatus === 'healthy' ? 0 : 100;
    const latency = latencyItems.length > 0
      ? latencyItems.reduce((sum, value) => sum + value, 0) / latencyItems.length
      : (proxy.testStatus === 'healthy' ? 0 : 0);

    return {
      name: proxy.name || hostKey,
      host: hostKey,
      latency: roundMetric(latency, 0),
      status: latestItem?.status === 'online' || proxy.testStatus === 'healthy' ? 'online' : 'offline',
      packetLoss: roundMetric(packetLoss, 2),
      lastChecked: latestItem?.checkedAt || proxy.lastTested || null,
    };
  });

  for (const [host, items] of groupedDiagnostics.entries()) {
    if (knownHosts.has(host)) {
      continue;
    }

    const onlineCount = items.filter((item: any) => item.status === 'online').length;
    const latencyItems = items.map((item: any) => Number(item.pingMs || 0)).filter((value: number) => Number.isFinite(value) && value >= 0);

    endpointSummaries.push({
      name: host,
      host,
      latency: roundMetric(latencyItems.length > 0 ? latencyItems.reduce((sum, value) => sum + value, 0) / latencyItems.length : 0, 0),
      status: items[0]?.status === 'online' ? 'online' : 'offline',
      packetLoss: roundMetric(items.length > 0 ? ((items.length - onlineCount) / items.length) * 100 : 0, 2),
      lastChecked: items[0]?.checkedAt || null,
    });
  }

  return endpointSummaries.sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeQueue() {
  const jobs = db.select().from(queueJobs).all();
  const campaignMap = new Map(
    db.select().from(campaigns).all().map((campaign: any) => [campaign.id, campaign])
  );
  const accountMap = new Map(
    db.select().from(whatsappAccounts).all().map((account: any) => [account.id, account])
  );
  const now = Date.now();
  const staleThresholdMs = 5 * 60 * 1000;
  const recentFailureWindowMs = 60 * 60 * 1000;

  const oldestReadyJobTimestamp = jobs
    .filter((job: any) => ['pending', 'retry'].includes(job.status || ''))
    .map((job: any) => parseIsoDate(job.createdAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)[0] || null;

  const staleProcessing = jobs.filter((job: any) => {
    if (job.status !== 'processing') {
      return false;
    }

    const startedAt = parseIsoDate(job.startedAt);
    return startedAt !== null && now - startedAt >= staleThresholdMs;
  }).length;

  const failedJobDetails = jobs
    .filter((job: any) => job.status === 'failed')
    .map((job: any) => {
      const payload = parseJobPayload(job.payload);
      const createdAt = parseIsoDate(job.createdAt);
      const completedAt = parseIsoDate(job.completedAt) || createdAt;
      const campaignId = typeof payload?.campaignId === 'string' ? payload.campaignId : null;
      const accountId = resolvePrimaryAccountId(payload);
      const relatedCampaign = campaignId ? campaignMap.get(campaignId) : null;
      const relatedAccount = accountId ? accountMap.get(accountId) : null;
      const fingerprint = [job.type || 'unknown', campaignId || 'none', accountId || 'none'].join(':');
      const hasLaterSuccess = jobs.some((otherJob: any) => {
        if (otherJob.id === job.id || otherJob.status !== 'done') {
          return false;
        }

        const otherPayload = parseJobPayload(otherJob.payload);
        const otherFingerprint = [
          otherJob.type || 'unknown',
          typeof otherPayload?.campaignId === 'string' ? otherPayload.campaignId : 'none',
          resolvePrimaryAccountId(otherPayload) || 'none',
        ].join(':');

        const otherTimestamp = parseIsoDate(otherJob.completedAt) || parseIsoDate(otherJob.createdAt) || 0;
        return otherFingerprint === fingerprint && otherTimestamp > (completedAt || 0);
      });

      const isCampaignTerminal = ['completed', 'cancelled', 'failed'].includes(String(relatedCampaign?.status || '').toLowerCase());
      const isOrphaned = Boolean(accountId && !relatedAccount);
      const isConfiguredManagedAccount = isConfiguredAccount(relatedAccount);
      const isRecentFailure = completedAt !== null && now - completedAt <= recentFailureWindowMs;
      const actionable = !hasLaterSuccess
        && !isCampaignTerminal
        && !isOrphaned
        && (accountId ? isConfiguredManagedAccount : isRecentFailure);

      return {
        actionable,
        isOrphaned,
        hasLaterSuccess,
      };
    });

  const actionableFailed = failedJobDetails.filter((job) => job.actionable).length;
  const orphanedFailed = failedJobDetails.filter((job) => job.isOrphaned).length;
  const resolvedHistoricalFailed = failedJobDetails.filter((job) => job.hasLaterSuccess).length;
  const historicalFailed = Math.max(0, failedJobDetails.length - actionableFailed);

  return {
    total: jobs.length,
    pending: jobs.filter((job: any) => job.status === 'pending').length,
    retry: jobs.filter((job: any) => job.status === 'retry').length,
    processing: jobs.filter((job: any) => job.status === 'processing').length,
    done: jobs.filter((job: any) => job.status === 'done').length,
    failed: jobs.filter((job: any) => job.status === 'failed').length,
    actionableFailed,
    historicalFailed,
    orphanedFailed,
    resolvedHistoricalFailed,
    staleProcessing,
    corruptedPayloads: jobs.filter((job: any) => isPayloadCorrupted(job.payload)).length,
    oldestReadyJobMinutes: oldestReadyJobTimestamp !== null ? roundMetric((now - oldestReadyJobTimestamp) / 60000, 1) : 0,
  };
}

function summarizeAccounts() {
  const accounts = db.select().from(whatsappAccounts).all();
  const managedAccounts = accounts.filter((account: any) => isConfiguredAccount(account));
  const placeholderAccounts = accounts.length - managedAccounts.length;

  return {
    total: accounts.length,
    managedTotal: managedAccounts.length,
    placeholderTotal: placeholderAccounts,
    connected: accounts.filter((account: any) => account.status === 'connected').length,
    connecting: accounts.filter((account: any) => account.status === 'connecting').length,
    disconnected: accounts.filter((account: any) => account.status === 'disconnected').length,
    withLastError: accounts.filter((account: any) => !!account.lastError).length,
    managedConnected: managedAccounts.filter((account: any) => account.status === 'connected').length,
    managedConnecting: managedAccounts.filter((account: any) => account.status === 'connecting').length,
    managedDisconnected: managedAccounts.filter((account: any) => account.status === 'disconnected').length,
    managedWithLastError: managedAccounts.filter((account: any) => !!account.lastError).length,
  };
}

function summarizeNetwork(range?: string) {
  const diagnostics = listNetworkDiagnostics(range);
  const endpointSummaries = buildEndpointSummaries(range);
  const now = Date.now();
  const activeWindowMs = 60 * 60 * 1000;
  const onlineChecks = diagnostics.filter((item: any) => item.status === 'online').length;
  const offlineChecks = diagnostics.filter((item: any) => item.status === 'offline').length;
  const totalChecks = diagnostics.length;
  const latencyValues = diagnostics
    .map((item: any) => Number(item.pingMs || 0))
    .filter((value: number) => Number.isFinite(value) && value >= 0);

  const avgLatency = latencyValues.length > 0
    ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
    : 0;

  const minLatency = latencyValues.length > 0 ? Math.min(...latencyValues) : 0;
  const maxLatency = latencyValues.length > 0 ? Math.max(...latencyValues) : 0;
  const packetLoss = totalChecks > 0 ? (offlineChecks / totalChecks) * 100 : 0;
  const uptime = totalChecks > 0 ? (onlineChecks / totalChecks) * 100 : 100;
  const lastChecked = diagnostics[0]?.checkedAt || new Date().toISOString();
  const freshnessMinutes = Math.max(0, roundMetric((now - new Date(lastChecked).getTime()) / 60000, 1));
  const activeDiagnostics = diagnostics.filter((item: any) => {
    const checkedAt = parseIsoDate(item.checkedAt);
    return checkedAt !== null && now - checkedAt <= activeWindowMs;
  });
  const statusDiagnostics = activeDiagnostics.length > 0 ? activeDiagnostics : diagnostics.slice(0, Math.min(5, diagnostics.length));
  const statusLatencyValues = statusDiagnostics
    .map((item: any) => Number(item.pingMs || 0))
    .filter((value: number) => Number.isFinite(value) && value >= 0);
  const statusOnlineChecks = statusDiagnostics.filter((item: any) => item.status === 'online').length;
  const statusOfflineChecks = statusDiagnostics.filter((item: any) => item.status === 'offline').length;
  const statusTotalChecks = statusDiagnostics.length;
  const currentAvgLatency = statusLatencyValues.length > 0
    ? statusLatencyValues.reduce((sum, value) => sum + value, 0) / statusLatencyValues.length
    : 0;
  const currentPacketLoss = statusTotalChecks > 0 ? (statusOfflineChecks / statusTotalChecks) * 100 : 0;
  const currentUptime = statusTotalChecks > 0 ? (statusOnlineChecks / statusTotalChecks) * 100 : 100;
  const hasReliableCurrentSample = statusTotalChecks >= 3;

  let overallStatus: 'healthy' | 'degraded' | 'offline' = 'healthy';
  if (totalChecks === 0 || uptime < 90 || packetLoss > 15) {
    overallStatus = 'offline';
  } else if (
    freshnessMinutes > 60
    || currentAvgLatency > 900
    || (hasReliableCurrentSample && currentUptime < 97)
    || (hasReliableCurrentSample && currentPacketLoss > 3)
  ) {
    overallStatus = 'degraded';
  }

  return {
    overallStatus,
    avgLatency: roundMetric(avgLatency),
    currentAvgLatency: roundMetric(currentAvgLatency),
    minLatency: roundMetric(minLatency),
    maxLatency: roundMetric(maxLatency),
    packetLoss: roundMetric(packetLoss, 2),
    uptime: roundMetric(uptime),
    currentPacketLoss: roundMetric(currentPacketLoss, 2),
    currentUptime: roundMetric(currentUptime),
    currentSampleCount: statusTotalChecks,
    freshnessMinutes,
    onlineChecks,
    offlineChecks,
    recentDiagnostics: diagnostics,
    endpoints: endpointSummaries,
    lastChecked,
  };
}

export function buildOperationalAlerts(range?: string): RuntimeAlert[] {
  const queue = summarizeQueue();
  const accounts = summarizeAccounts();
  const network = summarizeNetwork(range);
  const worker = getQueueWorkerRuntime();
  const nowIso = new Date().toISOString();
  const alerts: RuntimeAlert[] = [];

  if (queue.actionableFailed > 0) {
    alerts.push({
      id: 'queue-failed-jobs',
      severity: 'critical',
      category: 'queue',
      title: 'Queue failure backlog detected',
      message: `${queue.actionableFailed} failed job is still operationally active and needs review.`,
      metric: queue.actionableFailed,
      createdAt: nowIso,
    });
  }

  if (queue.historicalFailed > 0) {
    alerts.push({
      id: 'queue-historical-failures',
      severity: 'info',
      category: 'queue',
      title: 'Historical queue failures preserved',
      message: `${queue.historicalFailed} failed job remains in history for traceability but is not blocking the live runtime.`,
      metric: queue.historicalFailed,
      createdAt: nowIso,
    });
  }

  if (queue.staleProcessing > 0) {
    alerts.push({
      id: 'queue-stale-processing',
      severity: 'critical',
      category: 'queue',
      title: 'Stale queue processing detected',
      message: `${queue.staleProcessing} job appears stuck in processing state.`,
      metric: queue.staleProcessing,
      createdAt: nowIso,
    });
  }

  if (queue.retry > 0 || queue.oldestReadyJobMinutes >= 10) {
    alerts.push({
      id: 'queue-retry-pressure',
      severity: 'warning',
      category: 'queue',
      title: 'Queue retry pressure is elevated',
      message: `${queue.retry} retry job and oldest ready job age ${queue.oldestReadyJobMinutes} minutes.`,
      metric: queue.retry,
      createdAt: nowIso,
    });
  }

  if (queue.corruptedPayloads > 0) {
    alerts.push({
      id: 'queue-corrupted-payloads',
      severity: 'critical',
      category: 'queue',
      title: 'Corrupted queue payloads detected',
      message: `${queue.corruptedPayloads} job payload could not be parsed.`,
      metric: queue.corruptedPayloads,
      createdAt: nowIso,
    });
  }

  if (accounts.managedDisconnected > 0 || accounts.managedWithLastError > 0) {
    alerts.push({
      id: 'account-connection-risk',
      severity: accounts.managedDisconnected > 0 ? 'critical' : 'warning',
      category: 'account',
      title: 'Account connectivity needs attention',
      message: `${accounts.managedDisconnected} managed account is disconnected and ${accounts.managedWithLastError} managed account has lastError.`,
      metric: accounts.managedDisconnected + accounts.managedWithLastError,
      createdAt: nowIso,
    });
  }

  if (network.overallStatus !== 'healthy') {
    const freshnessMessage = network.freshnessMinutes > 60
      ? ` Latest diagnostic is ${network.freshnessMinutes} minutes old.`
      : '';
    alerts.push({
      id: 'network-health-risk',
      severity: network.overallStatus === 'offline' ? 'critical' : 'warning',
      category: 'network',
      title: 'Network health degraded',
      message: `Network current uptime ${network.currentUptime}% with packet loss ${network.currentPacketLoss}% and average latency ${network.currentAvgLatency}ms.${freshnessMessage}`,
      metric: network.currentAvgLatency,
      createdAt: nowIso,
    });
  }

  const heartbeatAgeMs = worker.lastHeartbeatAt ? Date.now() - new Date(worker.lastHeartbeatAt).getTime() : null;
  if (heartbeatAgeMs === null || heartbeatAgeMs > 15000) {
    alerts.push({
      id: 'queue-worker-heartbeat',
      severity: 'critical',
      category: 'worker',
      title: 'Queue worker heartbeat is stale',
      message: 'Background queue worker has not reported a recent heartbeat.',
      metric: heartbeatAgeMs !== null ? roundMetric(heartbeatAgeMs / 1000, 1) : null,
      createdAt: nowIso,
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'runtime-healthy',
      severity: 'info',
      category: 'worker',
      title: 'Runtime looks healthy',
      message: 'No active operational alert is currently open.',
      metric: null,
      createdAt: nowIso,
    });
  }

  return alerts;
}

export function getNetworkLatencyHistory(range?: string) {
  const diagnostics = listNetworkDiagnostics(range);
  const latencyByTime: Record<string, { latency: number; count: number }> = {};

  diagnostics.forEach((item: any) => {
    const time = String(item.checkedAt || '').split('T')[0];
    if (!time) {
      return;
    }

    if (!latencyByTime[time]) {
      latencyByTime[time] = { latency: 0, count: 0 };
    }

    latencyByTime[time].latency += Number(item.pingMs || 0);
    latencyByTime[time].count += 1;
  });

  return Object.entries(latencyByTime)
    .map(([time, data]) => ({
      time,
      latency: roundMetric(data.count > 0 ? data.latency / data.count : 0),
    }))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
}

export function getNetworkDiagnosticsTable(range?: string) {
  const groupedByHost = new Map<string, number[]>();

  listNetworkDiagnostics(range).forEach((item: any) => {
    const host = normalizeDiagnosticHost(item.host);
    if (!groupedByHost.has(host)) {
      groupedByHost.set(host, []);
    }
    groupedByHost.get(host)?.push(Number(item.pingMs || 0));
  });

  return listNetworkDiagnostics(range).map((item: any) => {
    const normalizedHost = normalizeDiagnosticHost(item.host);
    const hostSamples = groupedByHost.get(normalizedHost) || [];
    const packetLoss = hostSamples.length > 0
      ? roundMetric((hostSamples.filter((value) => value <= 0).length / hostSamples.length) * 100, 2)
      : 0;

    return {
      id: item.id,
      timestamp: item.checkedAt,
      endpoint: normalizedHost,
      latency: Number(item.pingMs || 0),
      status: item.status,
      packetLoss,
      jitter: roundMetric(calculateJitter(hostSamples), 2),
    };
  });
}

export function getOperationalHealthOverview(range?: string) {
  const network = summarizeNetwork(range);
  const queue = summarizeQueue();
  const accounts = summarizeAccounts();
  const worker = getQueueWorkerRuntime();
  const alerts = buildOperationalAlerts(range);
  const hasCriticalAlert = alerts.some((alert) => alert.severity === 'critical');
  const hasWarningAlert = alerts.some((alert) => alert.severity === 'warning');

  return {
    overallStatus: hasCriticalAlert ? 'offline' : hasWarningAlert ? 'degraded' : network.overallStatus,
    avgLatency: network.avgLatency,
    currentAvgLatency: network.currentAvgLatency,
    minLatency: network.minLatency,
    maxLatency: network.maxLatency,
    packetLoss: network.packetLoss,
    uptime: network.uptime,
    currentPacketLoss: network.currentPacketLoss,
    currentUptime: network.currentUptime,
    currentSampleCount: network.currentSampleCount,
    freshnessMinutes: network.freshnessMinutes,
    onlineChecks: network.onlineChecks,
    offlineChecks: network.offlineChecks,
    lastChecked: network.lastChecked,
    endpoints: network.endpoints,
    queue,
    accounts,
    worker,
    alerts,
  };
}

export async function getConnectionWidgetOverview() {
  const network = summarizeNetwork('today');
  const diagnostics = listNetworkDiagnostics('today');
  const latestDiagnostic = diagnostics[0] || null;
  const identity = await fetchPublicNetworkIdentity();
  const windows = {
    '1m': buildWindowMetrics(diagnostics, 1 * 60 * 1000),
    '5m': buildWindowMetrics(diagnostics, 5 * 60 * 1000),
    '10m': buildWindowMetrics(diagnostics, 10 * 60 * 1000),
  } as Record<ConnectionWindowKey, ReturnType<typeof buildWindowMetrics>>;
  const trend = buildTrendPoints(diagnostics);
  const currentWindow = windows['1m'].sampleCount > 0
    ? windows['1m']
    : windows['5m'].sampleCount > 0
      ? windows['5m']
      : windows['10m'];
  let widgetStatus: 'healthy' | 'degraded' | 'offline' = 'healthy';

  if (
    currentWindow.sampleCount === 0
    || network.freshnessMinutes > 3
    || latestDiagnostic?.status === 'offline'
    || currentWindow.uptime < 90
    || currentWindow.packetLoss > 15
    || currentWindow.avgLatency > 1200
  ) {
    widgetStatus = 'offline';
  } else if (
    currentWindow.uptime < 97
    || currentWindow.packetLoss > 3
    || currentWindow.avgLatency > 650
  ) {
    widgetStatus = 'degraded';
  }

  return {
    status: widgetStatus,
    checkedAt: network.lastChecked,
    freshnessMinutes: network.freshnessMinutes,
    latestProbe: {
      host: normalizeDiagnosticHost(latestDiagnostic?.host),
      status: latestDiagnostic?.status || 'offline',
      latency: roundMetric(Number(latestDiagnostic?.pingMs || 0), 0),
    },
    current: {
      latency: currentWindow.sampleCount > 0 ? currentWindow.avgLatency : roundMetric(Number(latestDiagnostic?.pingMs || 0), 0),
      uptime: currentWindow.uptime,
      packetLoss: currentWindow.packetLoss,
      sampleCount: currentWindow.sampleCount,
    },
    windows,
    trend,
    identity,
  };
}