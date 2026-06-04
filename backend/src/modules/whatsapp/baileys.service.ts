import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import * as https from 'https';
import { lookup } from 'dns/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { logger } from '../../utils/logger';
import { broadcast } from '../../websocket/ws.handler';
import { db } from '../../database';
import { whatsappAccounts, contacts, accountContacts, messageLogs, conversations, groups as groupsSchema, groupMembers, autoReplyRules, autoReplyLogs, apiKeys, proxyProfiles, networkDiagnostics } from '../../database/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { rateLimiter } from './rate-limiter';
import { validatePhoneNumber, isWhatsAppEligible } from '../../utils/number-validator';
import { personalizeMessage } from '../../utils/message-personalizer';
import { decryptSecret } from '../../utils/secret-crypto';
import { applyAutoReplyBrainOutcome, evaluateAutoReplyBrain } from '../../services/auto-reply-brain.service';

const sessionsDir = path.join(process.cwd(), 'sessions');

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const activeSockets: Record<string, any> = {};
export const latestQrs: Record<string, string> = {};
export const latestPairingCodes: Record<string, { code: string; phone: string; generatedAt: string }> = {};

function extractPhoneFromJid(remoteJid: string): string {
  return String(remoteJid || '').split('@')[0].split(':')[0];
}

function safeJsonStringify(value: any): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

type ConnectionRuntimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'logged_out' | 'error';

interface AccountConnectionRuntime {
  status: ConnectionRuntimeStatus;
  isConnecting: boolean;
  reconnectAttempts: number;
  connectPromise?: Promise<any> | null;
  reconnectTimer?: NodeJS.Timeout | null;
  lastConnectedAt?: string;
  lastDisconnectAt?: string;
  lastDisconnectReason?: string;
}

interface ProxyProfileRecord {
  id: string;
  name?: string | null;
  type?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
}

interface NetworkProbeResult {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}

const connectionRuntime: Record<string, AccountConnectionRuntime> = {};
let cachedBaileysVersion: any;
const WHATSAPP_WS_HOST = 'web.whatsapp.com';
const CONNECTION_PREFLIGHT_ATTEMPTS = 3;
const CONNECTION_PREFLIGHT_DELAY_MS = 2000;
let networkMonitorTimer: NodeJS.Timeout | null = null;

type SupportedMediaType = 'image' | 'video' | 'audio' | 'document';

export interface MediaSendOptions {
  mediaPath: string;
  caption?: string;
  fileName?: string;
  mimeType?: string;
  mediaType?: SupportedMediaType;
  ptt?: boolean;
}

function getConnectionRuntime(accountId: string): AccountConnectionRuntime {
  if (!connectionRuntime[accountId]) {
    connectionRuntime[accountId] = {
      status: 'idle',
      isConnecting: false,
      reconnectAttempts: 0,
      connectPromise: null,
      reconnectTimer: null,
    };
  }

  return connectionRuntime[accountId];
}

function clearReconnectTimer(accountId: string) {
  const runtime = getConnectionRuntime(accountId);
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
}

function getSocketReadyState(sock: any): number | undefined {
  return sock?.ws?.readyState;
}

function isSocketReady(sock: any, accountId?: string): boolean {
  const runtime = accountId ? getConnectionRuntime(accountId) : undefined;
  const readyState = getSocketReadyState(sock);

  return !!sock && !!sock.user && (readyState === undefined || readyState === 1) && runtime?.status !== 'logged_out';
}

function closeSocketSilently(sock: any) {
  if (!sock) return;

  try {
    if (typeof sock.end === 'function') {
      sock.end(new Error('Socket reset for recovery'));
      return;
    }
  } catch (error) {
    logger.debug('Socket end() failed during recovery cleanup');
  }

  try {
    sock.ws?.close();
  } catch (error) {
    logger.debug('Socket ws.close() failed during recovery cleanup');
  }
}

async function getBaileysVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedBaileysVersion = version;
    return version;
  } catch (error) {
    if (cachedBaileysVersion) {
      logger.warn('Using cached Baileys version because latest version lookup failed');
      return cachedBaileysVersion;
    }

    throw error;
  }
}

function normalizeProxyType(type?: string | null): 'http' | 'socks4' | 'socks5' | null {
  const normalized = (type || '').toLowerCase().trim();

  if (normalized === 'http' || normalized === 'https') return 'http';
  if (normalized === 'socks4') return 'socks4';
  if (normalized === 'socks5' || normalized === 'socks') return 'socks5';

  return null;
}

function buildProxyUrl(profile: ProxyProfileRecord): string {
  const proxyType = normalizeProxyType(profile.type);
  if (!proxyType || !profile.host || !profile.port) {
    throw new Error('Assigned proxy profile is incomplete. Please check proxy host, port, and type.');
  }

  const auth = profile.username
    ? `${encodeURIComponent(profile.username)}:${encodeURIComponent(profile.password || '')}@`
    : '';

  return `${proxyType}://${auth}${profile.host}:${profile.port}`;
}

function getProxyLogLabel(profile: ProxyProfileRecord): string {
  const name = profile.name || 'Unnamed Proxy';
  return `${name} (${profile.host}:${profile.port})`;
}

function buildProxyAgents(profile: ProxyProfileRecord) {
  const proxyType = normalizeProxyType(profile.type);
  const proxyUrl = buildProxyUrl(profile);

  if (proxyType === 'http') {
    const agent = new HttpsProxyAgent(proxyUrl);
    return { agent, fetchAgent: agent };
  }

  const agent = new SocksProxyAgent(proxyUrl);
  return { agent, fetchAgent: agent };
}

function recordNetworkDiagnostic(host: string, status: 'online' | 'offline', pingMs: number) {
  try {
    db.insert(networkDiagnostics).values({
      id: uuidv4(),
      host,
      status,
      pingMs,
      checkedAt: new Date().toISOString(),
    }).run();
  } catch (error) {
    logger.debug(`Failed to persist network diagnostic for ${host}`);
  }
}

async function runHttpsProbe(host: string, agent?: https.Agent): Promise<NetworkProbeResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const request = https.request({
      host,
      port: 443,
      method: 'GET',
      path: '/',
      timeout: 15000,
      agent,
      headers: {
        'User-Agent': 'WhatsApp-Turbo-Diagnostics/1.0',
        'Accept': '*/*',
        'Cache-Control': 'no-cache',
      },
    }, (response) => {
      response.resume();
      const statusCode = Number(response.statusCode || 0);
      resolve({
        ok: statusCode >= 200 && statusCode < 500,
        latencyMs: Date.now() - startedAt,
        statusCode,
        error: statusCode >= 500 ? `Unexpected status code ${statusCode}` : undefined,
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`HTTPS probe timeout to ${host}`));
    });

    request.on('error', (error: Error) => {
      resolve({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error.message,
      });
    });

    request.end();
  });
}

function delayMs(duration: number) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

export async function runNetworkProbe(host?: string) {
  const rawHost = String(host || WHATSAPP_WS_HOST).trim();
  const normalizedHost = rawHost
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '') || WHATSAPP_WS_HOST;
  const attempts = 3;
  const probeResults: Array<NetworkProbeResult & { recordedHost: string }> = [];

  try {
    await lookup(normalizedHost);
  } catch (error: any) {
    const timestamp = new Date().toISOString();
    recordNetworkDiagnostic(normalizedHost, 'offline', 0);

    return {
      success: false,
      host: normalizedHost,
      pingMs: 0,
      status: 'offline' as const,
      timestamp,
      error: `DNS lookup failed for ${normalizedHost}: ${error.message}`,
    };
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptResult = await runHttpsProbe(normalizedHost);
    probeResults.push({
      ...attemptResult,
      recordedHost: attempts > 1 ? `${normalizedHost}#${attempt + 1}` : normalizedHost,
    });
    recordNetworkDiagnostic(
      attempts > 1 ? `${normalizedHost}#${attempt + 1}` : normalizedHost,
      attemptResult.ok ? 'online' : 'offline',
      attemptResult.latencyMs,
    );

    if (attempt < attempts - 1) {
      await delayMs(1000);
    }
  }

  const successfulResults = probeResults.filter((result) => result.ok);
  const successCount = successfulResults.length;
  const failureCount = probeResults.length - successCount;
  const status = successCount >= Math.ceil(attempts / 2) ? 'online' : 'offline';
  const timestamp = new Date().toISOString();
  const pingMs = successfulResults.length > 0
    ? Math.round(successfulResults.reduce((sum, result) => sum + result.latencyMs, 0) / successfulResults.length)
    : Math.round(probeResults.reduce((sum, result) => sum + result.latencyMs, 0) / Math.max(1, probeResults.length));
  const lastError = probeResults.slice().reverse().find((result) => !result.ok)?.error || null;

  recordNetworkDiagnostic(normalizedHost, status, pingMs);

  return {
    success: status === 'online',
    host: normalizedHost,
    pingMs,
    status,
    timestamp,
    attempts,
    successCount,
    failureCount,
    error: lastError,
  };
}

export function startNetworkDiagnosticsMonitor(intervalMs = 5 * 60 * 1000) {
  if (networkMonitorTimer) {
    return;
  }

  const runProbe = () => {
    runNetworkProbe().catch((error) => {
      logger.warn(`Background network probe failed: ${error.message}`);
    });
  };

  runProbe();
  networkMonitorTimer = setInterval(runProbe, intervalMs);
  logger.info(`Network diagnostics monitor started with ${Math.round(intervalMs / 1000)}s interval`);
}

async function getAccountProxyProfile(accountId: string) {
  const account = db.select().from(whatsappAccounts).where(eq(whatsappAccounts.id, accountId)).get();
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }

  if (!account.proxyProfileId) {
    return {
      account,
      proxyProfile: null as ProxyProfileRecord | null,
      proxyAgents: null as { agent: https.Agent; fetchAgent: https.Agent } | null,
    };
  }

  const proxyProfile = db.select().from(proxyProfiles).where(eq(proxyProfiles.id, account.proxyProfileId)).get() as ProxyProfileRecord | undefined;
  if (!proxyProfile) {
    throw new Error('Assigned proxy profile was not found. Please reassign the account proxy.');
  }

  return {
    account,
    proxyProfile,
    proxyAgents: buildProxyAgents(proxyProfile),
  };
}

async function runConnectionPreflight(accountId: string) {
  const { proxyProfile, proxyAgents } = await getAccountProxyProfile(accountId);
  const probeTarget = proxyProfile?.host || WHATSAPP_WS_HOST;

  let lastPreflightError = '';
  let successfulProbe: NetworkProbeResult | null = null;

  for (let attempt = 1; attempt <= CONNECTION_PREFLIGHT_ATTEMPTS; attempt += 1) {
    try {
      await lookup(probeTarget);
    } catch (error: any) {
      lastPreflightError = `DNS lookup failed for ${probeTarget}: ${error.message}`;
      recordNetworkDiagnostic(probeTarget, 'offline', 0);

      if (attempt < CONNECTION_PREFLIGHT_ATTEMPTS) {
        await delayMs(CONNECTION_PREFLIGHT_DELAY_MS * attempt);
        continue;
      }

      throw new Error(lastPreflightError);
    }

    const httpsProbe = await runHttpsProbe(WHATSAPP_WS_HOST, proxyAgents?.agent);
    recordNetworkDiagnostic(
      proxyProfile ? `${proxyProfile.host}:${proxyProfile.port}->${WHATSAPP_WS_HOST}` : WHATSAPP_WS_HOST,
      httpsProbe.ok ? 'online' : 'offline',
      httpsProbe.latencyMs,
    );

    if (httpsProbe.ok) {
      successfulProbe = httpsProbe;
      break;
    }

    lastPreflightError = proxyProfile
      ? `Proxy connectivity failed via ${getProxyLogLabel(proxyProfile)}: ${httpsProbe.error}`
      : `WhatsApp network preflight failed: ${httpsProbe.error}`;

    if (attempt < CONNECTION_PREFLIGHT_ATTEMPTS) {
      await delayMs(CONNECTION_PREFLIGHT_DELAY_MS * attempt);
    }
  }

  if (!successfulProbe) {
    throw new Error(lastPreflightError || 'WhatsApp network preflight failed');
  }

  if (proxyProfile) {
    logger.info(`Using assigned proxy for ${accountId}: ${getProxyLogLabel(proxyProfile)}`);
  }

  return {
    proxyProfile,
    proxyAgents,
  };
}

function updateAccountStatus(accountId: string, status: string, lastError?: string | null) {
  const values: Record<string, any> = {
    status,
  };

  if (status === 'connected') {
    values.lastActive = new Date().toISOString();
    values.lastError = null;
  } else if (lastError !== undefined) {
    values.lastError = lastError;
  }

  db.update(whatsappAccounts)
    .set(values)
    .where(eq(whatsappAccounts.id, accountId))
    .run();

  broadcast('account_status', { accountId, status, lastError: lastError || undefined });
}

function scheduleReconnect(accountId: string, reason?: string) {
  const runtime = getConnectionRuntime(accountId);
  clearReconnectTimer(accountId);

  runtime.reconnectAttempts += 1;
  runtime.status = 'reconnecting';

  const delay = Math.min(30000, 3000 * Math.max(1, runtime.reconnectAttempts));
  logger.warn(`Scheduling reconnect for ${accountId} in ${delay}ms${reason ? `: ${reason}` : ''}`);

  updateAccountStatus(accountId, 'connecting', reason || null);

  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    connectAccount(accountId).catch((error) => {
      logger.error(`Reconnect failed for ${accountId}:`, error);
    });
  }, delay);
}

async function waitForSocketOpen(accountId: string, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const runtime = getConnectionRuntime(accountId);
    const sock = activeSockets[accountId];

    if (isSocketReady(sock, accountId) && runtime.status === 'open') {
      return sock;
    }

    if (runtime.status === 'logged_out') {
      throw new Error('Account is logged out. Please reconnect and scan the QR code again.');
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const runtime = getConnectionRuntime(accountId);
  throw new Error(runtime.lastDisconnectReason || `Account ${accountId} did not become ready within ${timeoutMs / 1000} seconds.`);
}

async function resetAndReconnect(accountId: string, reason: string) {
  const runtime = getConnectionRuntime(accountId);
  runtime.connectPromise = null;
  runtime.isConnecting = false;
  runtime.status = 'reconnecting';
  clearReconnectTimer(accountId);

  const existingSock = activeSockets[accountId];
  delete activeSockets[accountId];
  closeSocketSilently(existingSock);

  updateAccountStatus(accountId, 'connecting', reason);

  await connectAccount(accountId);
  return waitForSocketOpen(accountId, 30000);
}

function resolveMediaAbsolutePath(mediaPath: string): string {
  return path.isAbsolute(mediaPath) ? mediaPath : path.join(process.cwd(), mediaPath);
}

function inferMediaType(filePath: string, mimeType?: string, forcedType?: SupportedMediaType): SupportedMediaType {
  if (forcedType) return forcedType;

  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime) return 'document';

  const ext = path.extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus'].includes(ext)) return 'audio';
  return 'document';
}

function inferMimeType(filePath: string, mediaType: SupportedMediaType, providedMimeType?: string): string {
  if (providedMimeType) return providedMimeType;

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.opus': 'audio/ogg; codecs=opus',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
  };

  return mimeMap[ext] || (mediaType === 'document' ? 'application/octet-stream' : `${mediaType}/*`);
}

function buildMediaMessageContent(options: MediaSendOptions) {
  const absoluteMediaPath = resolveMediaAbsolutePath(options.mediaPath);
  if (!fs.existsSync(absoluteMediaPath)) {
    throw new Error(`Media file not found: ${absoluteMediaPath}`);
  }

  const mediaType = inferMediaType(absoluteMediaPath, options.mimeType, options.mediaType);
  const mimeType = inferMimeType(absoluteMediaPath, mediaType, options.mimeType);
  const fileName = options.fileName || path.basename(absoluteMediaPath);
  const caption = options.caption || '';

  if (mediaType === 'image') {
    return {
      mediaType,
      absoluteMediaPath,
      messageContent: {
        image: { url: absoluteMediaPath },
        caption,
        mimetype: mimeType,
      },
    };
  }

  if (mediaType === 'video') {
    return {
      mediaType,
      absoluteMediaPath,
      messageContent: {
        video: { url: absoluteMediaPath },
        caption,
        mimetype: mimeType,
      },
    };
  }

  if (mediaType === 'audio') {
    return {
      mediaType,
      absoluteMediaPath,
      messageContent: {
        audio: { url: absoluteMediaPath },
        mimetype: mimeType,
        ptt: options.ptt === true,
      },
    };
  }

  return {
    mediaType,
    absoluteMediaPath,
    messageContent: {
      document: { url: absoluteMediaPath },
      fileName,
      mimetype: mimeType,
      caption,
    },
  };
}

// Helper function to call AI API for auto-reply
async function generateAutoReply(message: string, rule: any): Promise<string> {
  try {
    const aiProvider = rule.aiProviderId || 'openai';
    const aiModel = rule.aiModel;
    const systemPrompt = rule.systemPrompt || 'You are a helpful assistant';

    // Get API keys for the provider
    const apiKey = db.select().from(apiKeys)
      .where(and(eq(apiKeys.provider, aiProvider)))
      .get();

    if (!apiKey || !apiKey.apiKey) {
      logger.warn(`No API key found for provider: ${aiProvider}`);
      return '';
    }

    const resolvedApiKey = decryptSecret(apiKey.apiKey);

    if (aiProvider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: aiModel || 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
          ],
          temperature: 0.7,
          max_tokens: 500
        })
      });

      if (!response.ok) {
        const error = await response.json();
        logger.error('OpenAI API error:', error);
        return '';
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } else if (aiProvider === 'gemini') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${aiModel}:generateContent?key=${resolvedApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: `System: ${systemPrompt}\n\nUser: ${message}` }
              ]
            }
          ]
        })
      });

      if (!response.ok) {
        logger.error('Gemini API error');
        return '';
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (aiProvider === 'claude') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': resolvedApiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: aiModel || 'claude-3-sonnet-20240229',
          max_tokens: 500,
          system: systemPrompt,
          messages: [
            { role: 'user', content: message }
          ]
        })
      });

      if (!response.ok) {
        logger.error('Claude API error');
        return '';
      }

      const data = await response.json();
      return data.content?.[0]?.text || '';
    }

    return '';
  } catch (error) {
    logger.error('Error generating auto-reply:', error);
    return '';
  }
}

// Helper function to check if rule matches the message
function matchesRule(message: string, rule: any): boolean {
  const triggerType = rule.triggerType || 'keyword';

  if (triggerType === 'all') {
    return true;
  } else if (triggerType === 'keyword') {
    if (!rule.keywords) return false;
    const keywords = rule.keywords.split(',').map((k: string) => k.trim().toLowerCase());
    return keywords.some((keyword: string) => message.toLowerCase().includes(keyword));
  } else if (triggerType === 'regex') {
    if (!rule.keywords) return false;
    try {
      const regex = new RegExp(rule.keywords, 'i');
      return regex.test(message);
    } catch (error) {
      logger.error('Invalid regex pattern:', rule.keywords);
      return false;
    }
  }

  return false;
}

// Helper function to check if current time is within working hours
function isWithinWorkingHours(rule: any): boolean {
  if (!rule.workingHours) return true;

  try {
    const [startStr, endStr] = rule.workingHours.split('-');
    const startHour = parseInt(startStr);
    const endHour = parseInt(endStr);
    const currentHour = new Date().getHours();

    if (startHour <= endHour) {
      return currentHour >= startHour && currentHour < endHour;
    } else {
      return currentHour >= startHour || currentHour < endHour;
    }
  } catch (error) {
    return true;
  }
}

// Main auto-reply handler
async function handleAutoReply(accountId: string, remoteJid: string, message: string, sock: any, context?: { contactId?: string | null; conversationId?: string | null }) {
  try {
    // Get all active rules for this account
    const rules = db.select()
      .from(autoReplyRules)
      .where(and(eq(autoReplyRules.accountId, accountId), eq(autoReplyRules.isActive, 1)))
      .all();

    const contact = context?.contactId
      ? db.select().from(contacts).where(eq(contacts.id, context.contactId)).get()
      : db.select().from(contacts).where(eq(contacts.phone, extractPhoneFromJid(remoteJid))).get();
    const conversation = context?.conversationId
      ? db.select().from(conversations).where(eq(conversations.id, context.conversationId)).get()
      : (contact
        ? db.select().from(conversations).where(and(eq(conversations.whatsappAccountId, accountId), eq(conversations.contactId, contact.id))).get()
        : null);

    for (const rule of rules) {
      // Check if rule matches and within working hours
      if (matchesRule(message, rule) && isWithinWorkingHours(rule)) {
        const decision = await evaluateAutoReplyBrain({
          accountId,
          remoteJid,
          message,
          rule,
          contact,
          conversation,
        });

        if (!decision.shouldReply) {
          db.insert(autoReplyLogs).values({
            id: uuidv4(),
            ruleId: rule.id,
            fromPhone: remoteJid,
            incomingMessage: message,
            autoReply: '',
            mediaPath: null,
            mediaType: null,
            status: 'skipped',
            decisionType: decision.decisionType,
            detectedIntent: decision.detectedIntent,
            detectedLanguage: decision.detectedLanguage,
            escalationReason: decision.silentReason || null,
            brainContext: safeJsonStringify(decision.contextSummary),
            createdAt: new Date().toISOString()
          }).run();

          applyAutoReplyBrainOutcome({ decision, contact, conversation, rule });
          break;
        }

        const autoReplyText = decision.replyText || await generateAutoReply(message, rule);

        const hasMediaAttachment = !!rule.mediaPath;

        if (autoReplyText || hasMediaAttachment) {
          // Apply delay
          const delayMin = rule.responseDelayMinMs || 3000;
          const delayMax = rule.responseDelayMaxMs || 8000;
          const delay = Math.random() * (delayMax - delayMin) + delayMin;

          await new Promise(resolve => setTimeout(resolve, delay));

          // Send auto-reply
          try {
            if (hasMediaAttachment) {
              const preparedMedia = buildMediaMessageContent({
                mediaPath: rule.mediaPath as string,
                caption: autoReplyText || '',
                fileName: rule.mediaFileName || undefined,
                mimeType: rule.mediaMimeType || undefined,
                mediaType: (rule.mediaType as SupportedMediaType | undefined) || undefined,
                ptt: rule.sendAsVoiceNote === 1,
              });
              await sock.sendMessage(remoteJid, preparedMedia.messageContent);
            } else {
              await sock.sendMessage(remoteJid, { text: autoReplyText });
            }
            logger.info(`Auto-reply sent for rule ${rule.id}`);

            applyAutoReplyBrainOutcome({ decision, contact, conversation, rule });

            // Log the auto-reply
            db.insert(autoReplyLogs).values({
              id: uuidv4(),
              ruleId: rule.id,
              fromPhone: remoteJid,
              incomingMessage: message,
              autoReply: autoReplyText,
              mediaPath: rule.mediaPath || null,
              mediaType: rule.mediaType || null,
              status: 'sent',
              decisionType: decision.decisionType,
              detectedIntent: decision.detectedIntent,
              detectedLanguage: decision.detectedLanguage,
              escalationReason: decision.escalationReason,
              brainContext: safeJsonStringify(decision.contextSummary),
              createdAt: new Date().toISOString()
            }).run();
          } catch (sendError) {
            logger.error('Error sending auto-reply:', sendError);
            db.insert(autoReplyLogs).values({
              id: uuidv4(),
              ruleId: rule.id,
              fromPhone: remoteJid,
              incomingMessage: message,
              autoReply: autoReplyText,
              mediaPath: rule.mediaPath || null,
              mediaType: rule.mediaType || null,
              status: 'failed',
              decisionType: decision.decisionType,
              detectedIntent: decision.detectedIntent,
              detectedLanguage: decision.detectedLanguage,
              escalationReason: decision.escalationReason,
              brainContext: safeJsonStringify(decision.contextSummary),
              createdAt: new Date().toISOString()
            }).run();
          }
        }
        break; // Only apply first matching rule
      }
    }
  } catch (error) {
    logger.error('Error in handleAutoReply:', error);
  }
}

export async function connectAccount(accountId: string) {
  logger.info(`Connecting WhatsApp account: ${accountId}`);
  const runtime = getConnectionRuntime(accountId);

  if (runtime.connectPromise) {
    return runtime.connectPromise;
  }

  const existingSock = activeSockets[accountId];
  if (isSocketReady(existingSock, accountId) && runtime.status === 'open') {
    return existingSock;
  }

  clearReconnectTimer(accountId);
  runtime.isConnecting = true;
  runtime.status = runtime.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  updateAccountStatus(accountId, 'connecting', null);
  
  runtime.connectPromise = (async () => {
    try {
      const preflight = await runConnectionPreflight(accountId);

      const sessionPath = path.join(sessionsDir, accountId, 'auth_info_baileys');
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const version = await getBaileysVersion();

      const previousSocket = activeSockets[accountId];
      if (previousSocket && previousSocket !== existingSock) {
        closeSocketSilently(previousSocket);
      }

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        defaultQueryTimeoutMs: 60000,
        markOnlineOnConnect: false,
        browser: ['WhatsApp Turbo AI', 'Chrome', '1.0.0'],
        agent: preflight.proxyAgents?.agent,
        fetchAgent: preflight.proxyAgents?.fetchAgent,
      });

      activeSockets[accountId] = sock;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const isCurrentSocket = activeSockets[accountId] === sock;

        if (qr) {
          logger.info(`QR Code received for account ${accountId}`);
          latestQrs[accountId] = qr;
          broadcast('qr_code', { accountId, qr });
        }

        if (!isCurrentSocket && connection !== 'open') {
          logger.info(`Ignoring connection update from stale socket for ${accountId}`);
          return;
        }

        if (connection === 'connecting') {
          runtime.status = 'connecting';
        }

        if (connection === 'close') {
          delete latestQrs[accountId];
          if (activeSockets[accountId] === sock) {
            delete activeSockets[accountId];
          }

          const disconnectError = lastDisconnect?.error as Boom | Error | undefined;
          const disconnectMessage = disconnectError instanceof Error
            ? disconnectError.message
            : (disconnectError as any)?.message || 'Connection closed';
          const statusCode = (disconnectError as Boom | undefined)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          runtime.isConnecting = false;
          runtime.connectPromise = null;
          runtime.lastDisconnectAt = new Date().toISOString();
          runtime.lastDisconnectReason = disconnectMessage;
          runtime.status = shouldReconnect ? 'error' : 'logged_out';

          logger.info(`Connection closed for ${accountId}. Reconnecting: ${shouldReconnect}. Reason: ${disconnectMessage}`);

          if (shouldReconnect) {
            updateAccountStatus(accountId, 'error', disconnectMessage);
            scheduleReconnect(accountId, disconnectMessage);
          } else {
            runtime.reconnectAttempts = 0;
            clearReconnectTimer(accountId);
            updateAccountStatus(accountId, 'disconnected', disconnectMessage);
          }
        } else if (connection === 'open') {
          logger.info(`Connection opened for ${accountId}`);

          clearReconnectTimer(accountId);
          runtime.status = 'open';
          runtime.isConnecting = false;
          runtime.connectPromise = null;
          runtime.reconnectAttempts = 0;
          runtime.lastConnectedAt = new Date().toISOString();
          runtime.lastDisconnectReason = undefined;

          updateAccountStatus(accountId, 'connected', null);
        }
      });

      sock.ev.on('creds.update', saveCreds);

      return sock;
    } catch (error: any) {
      runtime.isConnecting = false;
      runtime.connectPromise = null;
      runtime.status = 'error';
      runtime.lastDisconnectReason = error.message;
      updateAccountStatus(accountId, 'error', error.message);
      scheduleReconnect(accountId, error.message);
      throw error;
    }
  })();

  const sock = await runtime.connectPromise;

  sock.ev.on('contacts.upsert', async (contacts: any[]) => {
    for (const c of contacts) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      let phone = c.id.split('@')[0].split(':')[0];
      // Convert hex to decimal if needed
      if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
        phone = parseInt(phone, 16).toString();
      }
      if (!/^\d{7,15}$/.test(phone)) continue;
      
      const existing = db.select().from(accountContacts).where(and(eq(accountContacts.accountId, accountId), eq(accountContacts.phone, phone))).all();
      const name = c.name || c.notify || '';
      const now = new Date().toISOString();
      if (existing.length === 0) {
        db.insert(accountContacts).values({
          id: uuidv4(),
          accountId,
          phone,
          name,
          source: 'contact',
          lastInteraction: now,
          createdAt: now
        }).run();
      } else {
        // Update name if provided and different, and always update lastInteraction
        const updates: any = { lastInteraction: now };
        if (name && !existing[0].name) {
          updates.name = name;
          updates.source = 'contact';
        }
        db.update(accountContacts).set(updates).where(eq(accountContacts.id, existing[0].id)).run();
      }
    }
  });

  sock.ev.on('messaging-history.set', async ({ contacts }: { contacts: any[] }) => {
    for (const c of contacts) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      let phone = c.id.split('@')[0].split(':')[0];
      // Convert hex to decimal if needed
      if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
        phone = parseInt(phone, 16).toString();
      }
      if (!/^\d{7,15}$/.test(phone)) continue;
      
      const existing = db.select().from(accountContacts).where(and(eq(accountContacts.accountId, accountId), eq(accountContacts.phone, phone))).all();
      const name = c.name || c.notify || '';
      const now = new Date().toISOString();
      if (existing.length === 0) {
        db.insert(accountContacts).values({
          id: uuidv4(),
          accountId,
          phone,
          name,
          source: 'chat_history',
          lastInteraction: now,
          createdAt: now
        }).run();
      } else {
        // Update name if provided and update lastInteraction
        const updates: any = { lastInteraction: now };
        if (name && !existing[0].name) {
          updates.name = name;
        }
        db.update(accountContacts).set(updates).where(eq(accountContacts.id, existing[0].id)).run();
      }
    }
  });

  sock.ev.on('messages.upsert', async (m: any) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        if (!msg.key.fromMe && msg.message) {
          const remoteJid = msg.key.remoteJid || '';
          const isGroup = remoteJid.endsWith('@g.us');
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          
          logger.info(`New message received on ${accountId} from ${remoteJid}`);
          
          // Basic Data Parsing (Extracting emails and order numbers as an example)
          const extractedData: any = {};
          const emailMatch = text.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/);
          if (emailMatch) extractedData.email = emailMatch[0];
          const orderMatch = text.match(/(?:order|سفارش|کد)\s*[:\-#]?\s*(\d{4,10})/i);
          if (orderMatch) extractedData.orderNumber = orderMatch[1];
          const parsedDataStr = Object.keys(extractedData).length > 0 ? JSON.stringify(extractedData) : null;

          let contactId = '';
          let phone = '';

          if (!isGroup) {
            phone = remoteJid.split('@')[0].split(':')[0];
            // Convert hex to decimal if needed
            if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
              phone = parseInt(phone, 16).toString();
            }
            // Contact Sync
            let contact = db.select().from(contacts).where(eq(contacts.phone, phone)).get();
            if (!contact) {
              contactId = uuidv4();
              db.insert(contacts).values({
                id: contactId,
                phone,
                fullName: msg.pushName || 'Unknown',
                source: 'whatsapp_inbound',
                parsedData: parsedDataStr,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lastInteraction: new Date().toISOString()
              }).run();
            } else {
              contactId = contact.id;
              // Update parsed data if new info found
              if (parsedDataStr) {
                const existingData = contact.parsedData ? JSON.parse(contact.parsedData) : {};
                const mergedData = { ...existingData, ...extractedData };
                db.update(contacts).set({ 
                  parsedData: JSON.stringify(mergedData),
                  lastInteraction: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                }).where(eq(contacts.id, contactId)).run();
              } else {
                db.update(contacts).set({ 
                  lastInteraction: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                }).where(eq(contacts.id, contactId)).run();
              }
            }

            // Shared Inbox: Conversation Sync
            let conversation = db.select().from(conversations)
              .where(and(eq(conversations.whatsappAccountId, accountId), eq(conversations.contactId, contactId)))
              .get();
            
            let conversationId = '';
            if (!conversation) {
              conversationId = uuidv4();
              db.insert(conversations).values({
                id: conversationId,
                whatsappAccountId: accountId,
                contactId,
                status: 'open',
                unreadCount: 1,
                lastMessageAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }).run();
            } else {
              conversationId = conversation.id;
              db.update(conversations).set({
                unreadCount: (conversation.unreadCount || 0) + 1,
                lastMessageAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: 'open'
              }).where(eq(conversations.id, conversationId)).run();
            }

            // Save Message Log
            db.insert(messageLogs).values({
              id: uuidv4(),
              whatsappAccountId: accountId,
              contactId,
              conversationId,
              direction: 'inbound',
              messageType: Object.keys(msg.message)[0] || 'text',
              content: text,
              parsedData: parsedDataStr,
              status: 'received',
              createdAt: new Date().toISOString()
            }).run();

            // Handle auto-reply asynchronously
            handleAutoReply(accountId, remoteJid, text, sock, { contactId, conversationId }).catch(err => 
              logger.error('Auto-reply handler error:', err)
            );
          }

          // Update group last message timestamp if it's a group message
          if (isGroup) {
            const groupRecord = db.select().from(groupsSchema).where(and(eq(groupsSchema.whatsappAccountId, accountId), eq(groupsSchema.jid, remoteJid))).get();
            if (groupRecord) {
              db.update(groupsSchema).set({ 
                lastMessageAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }).where(eq(groupsSchema.id, groupRecord.id)).run();
            }
          }

          broadcast('new_inbound_message', {
            accountId,
            from: remoteJid,
            text,
            parsedData: extractedData
          });
        }
      }
    }
  });

  return sock;
}

export async function requestPairingCode(accountId: string, phoneNumber: string) {
  const normalizedPhone = phoneNumber.replace(/\D/g, '');

  if (!normalizedPhone || normalizedPhone.length < 10) {
    throw new Error('A valid phone number is required for pairing code generation.');
  }

  let sock = activeSockets[accountId];
  if (!sock) {
    await connectAccount(accountId);
    sock = activeSockets[accountId];
  }

  if (!sock) {
    throw new Error(`No active socket found for account ${accountId}`);
  }

  const pairingSocket = sock as typeof sock & {
    requestPairingCode?: (phone: string) => Promise<string>;
  };

  if (typeof pairingSocket.requestPairingCode !== 'function') {
    throw new Error('Current WhatsApp socket does not support pairing code requests.');
  }

  const code = await pairingSocket.requestPairingCode(normalizedPhone);
  const generatedAt = new Date().toISOString();

  latestPairingCodes[accountId] = {
    code,
    phone: normalizedPhone,
    generatedAt,
  };

  broadcast('pairing_code', {
    accountId,
    code,
    phone: normalizedPhone,
    generatedAt,
  });

  return latestPairingCodes[accountId];
}

export async function disconnectAccount(accountId: string) {
  clearReconnectTimer(accountId);
  const runtime = getConnectionRuntime(accountId);
  runtime.status = 'closed';
  runtime.isConnecting = false;
  runtime.connectPromise = null;
  runtime.reconnectAttempts = 0;

  const sock = activeSockets[accountId];
  if (sock) {
    try { sock.logout(); } catch (e) {}
    delete activeSockets[accountId];
    delete latestQrs[accountId];
  }

  updateAccountStatus(accountId, 'disconnected', null);
}

export async function deleteSession(accountId: string) {
  try {
    clearReconnectTimer(accountId);
    const runtime = getConnectionRuntime(accountId);
    runtime.status = 'idle';
    runtime.isConnecting = false;
    runtime.connectPromise = null;
    runtime.reconnectAttempts = 0;

    const sock = activeSockets[accountId];
    if (sock) {
      try { sock.logout(); } catch (e) {}
      delete activeSockets[accountId];
    }
    delete latestQrs[accountId];
    
    const sessionPath = path.join(sessionsDir, accountId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  } catch (error) {
    logger.error(`Error deleting session for ${accountId}:`, error);
  }
}

async function ensureConnected(accountId: string, timeoutMs = 30000) {
  let sock = activeSockets[accountId];
  const runtime = getConnectionRuntime(accountId);

  if (!isSocketReady(sock, accountId) || runtime.status !== 'open') {
    await connectAccount(accountId);
    sock = await waitForSocketOpen(accountId, timeoutMs);
  }

  if (!isSocketReady(sock, accountId)) {
    sock = await waitForSocketOpen(accountId, timeoutMs);
  }

  return sock;
}

export async function getGroups(accountId: string) {
  const sock = await ensureConnected(accountId);
  
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups).map((g: any) => {
      let realCount = 0;
      let hiddenCount = 0;
      if (g.participants) {
        for (const p of g.participants) {
          let isHidden = true;
          let phone = '';

          if (p.id && p.id.endsWith('@s.whatsapp.net')) {
            const beforeAt = p.id.split('@')[0];
            phone = beforeAt.split(':')[0];
            if (/^\d{7,15}$/.test(phone)) {
              isHidden = false;
            }
          } else if (p.id && p.id.endsWith('@lid') && p.phoneNumber) {
            const pn = p.phoneNumber.includes('@')
              ? p.phoneNumber.split('@')[0]
              : p.phoneNumber;
            phone = pn.split(':')[0];
            if (/^\d{7,15}$/.test(phone)) {
              isHidden = false;
            }
          }
          
          if (isHidden) hiddenCount++;
          else realCount++;
        }
      }
      
      // Get last message time from database if available
      const groupRecord = db.select().from(groupsSchema).where(and(eq(groupsSchema.whatsappAccountId, accountId), eq(groupsSchema.jid, g.id))).get();
      const lastMessageAt = groupRecord?.lastMessageAt;
      
      return {
        id: g.id,
        subject: g.subject,
        participantsCount: g.participants?.length || 0,
        realCount,
        hiddenCount,
        creation: g.creation,
        desc: g.desc,
        isCommunity: g.isCommunity || g.subtype === 'parent',
        linkedParent: g.linkedParent,
        lastMessageAt: lastMessageAt || null
      };
    });
    
    // Sort by lastMessageAt descending (most recent first), then by subject
    return groupList.sort((a, b) => {
      if (a.lastMessageAt && b.lastMessageAt) {
        return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
      }
      if (a.lastMessageAt && !b.lastMessageAt) return -1;
      if (!a.lastMessageAt && b.lastMessageAt) return 1;
      return a.subject.localeCompare(b.subject);
    });
  } catch (error: any) {
    logger.error(`Failed to fetch groups for account ${accountId}:`, error);
    throw new Error(`Failed to fetch groups: ${error.message}. Ensure account is fully connected. Try reconnecting.`);
  }
}

export async function extractGroupMembers(accountId: string, groupId: string) {
  const sock = await ensureConnected(accountId);

  try {
    if (groupId.includes('@newsletter')) {
      const meta = await sock.newsletterMetadata("jid", groupId);
      let phone = meta.owner ? meta.owner.split('@')[0] : null;
      // Convert hex to decimal if needed
      if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
        phone = parseInt(phone, 16).toString();
      }
      if (phone) {
        const existing = db.select().from(contacts).where(eq(contacts.phone, phone)).all();
        if (existing.length === 0) {
          db.insert(contacts).values({
            id: uuidv4(),
            fullName: `Channel Owner (${meta.name})`,
            phone: phone,
            tags: JSON.stringify([
              `Channel: ${meta.name}`, 
              `Type: Channel`, 
              `Subscribers: ${meta.subscribers || 0}`,
              ...(meta.description ? [`Desc: ${meta.description.substring(0, 50)}`] : [])
            ]),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }).run();
        }
        return { total: 1, added: existing.length === 0 ? 1 : 0, subject: meta.name };
      }
      return { total: 0, added: 0, subject: meta.name };
    }

    const metadata = await sock.groupMetadata(groupId);
    const participants = metadata.participants;

    // Sync Group to DB
    let groupRecord = db.select().from(groupsSchema).where(and(eq(groupsSchema.whatsappAccountId, accountId), eq(groupsSchema.jid, groupId))).get();
    let dbGroupId = groupRecord?.id;
    if (!groupRecord) {
      dbGroupId = uuidv4();
       db.insert(groupsSchema).values({
        id: dbGroupId,
        whatsappAccountId: accountId,
        jid: groupId,
        name: metadata.subject,
        description: metadata.desc || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).run();
    } else if (dbGroupId) {
      db.update(groupsSchema).set({ name: metadata.subject, description: metadata.desc || '', updatedAt: new Date().toISOString() }).where(eq(groupsSchema.id, dbGroupId)).run();
    }

    let addedCount = 0;
    for (const p of participants) {
      let isHidden = true;
      let phone = '';
      
      if (p.id && p.id.endsWith('@s.whatsapp.net')) {
        const beforeAt = p.id.split('@')[0];
        phone = beforeAt.split(':')[0];
        // Convert hex to decimal if needed
        if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
          phone = parseInt(phone, 16).toString();
        }
        if (/^\d{7,15}$/.test(phone)) {
          isHidden = false;
        }
      } else if (p.id && p.id.endsWith('@lid') && p.phoneNumber) {
        const pn = p.phoneNumber.includes('@')
          ? p.phoneNumber.split('@')[0]
          : p.phoneNumber;
        phone = pn.split(':')[0];
        // Convert hex to decimal if needed
        if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
          phone = parseInt(phone, 16).toString();
        }
        if (/^\d{7,15}$/.test(phone)) {
          isHidden = false;
        }
      }
      
      if (isHidden) continue;
      
      // Check if exists
      let contactRecord = db.select().from(contacts).where(eq(contacts.phone, phone)).get();
      let contactId: string = contactRecord?.id || '';
      
      if (!contactRecord) {
        contactId = uuidv4();
        db.insert(contacts).values({
          id: contactId,
          fullName: `Group Member (${metadata.subject})`,
          phone: phone,
          tags: JSON.stringify([`Group: ${metadata.subject}`]),
          source: 'group_extract',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastInteraction: new Date().toISOString()
        }).run();
        addedCount++;
      } else {
        // Merge data - preserve existing data, only add missing info
        const updates: any = { updatedAt: new Date().toISOString(), lastInteraction: new Date().toISOString() };
        
        // Update tags if not already present
        const currentTags = contactRecord.tags ? JSON.parse(contactRecord.tags) : [];
        const newTag = `Group: ${metadata.subject}`;
        if (!currentTags.includes(newTag)) {
          currentTags.push(newTag);
          updates.tags = JSON.stringify(currentTags);
        }
        
        // Update source if not set
        if (!contactRecord.source) {
          updates.source = 'group_extract';
        }
        
        db.update(contacts).set(updates).where(eq(contacts.id, contactId)).run();
      }

      // Sync Group Member
      if (dbGroupId && contactId) {
        const memberExists = db.select().from(groupMembers).where(and(eq(groupMembers.groupId, dbGroupId), eq(groupMembers.contactId, contactId))).get();
        if (!memberExists) {
          db.insert(groupMembers).values({
            id: uuidv4(),
            groupId: dbGroupId,
            contactId: contactId,
            role: p.admin || 'member',
            joinedAt: new Date().toISOString()
          }).run();
        } else if (memberExists.role !== (p.admin || 'member')) {
          db.update(groupMembers).set({ role: p.admin || 'member' }).where(eq(groupMembers.id, memberExists.id)).run();
        }
      }
    }
    return { total: participants.length, added: addedCount, subject: metadata.subject };
  } catch (error: any) {
    logger.error(`Failed to extract members for account ${accountId}, group ${groupId}:`, error);
    throw new Error(`Failed to extract members: ${error.message}. Ensure account is fully connected.`);
  }
}

export async function getGroupMembers(accountId: string, groupId: string) {
  const sock = await ensureConnected(accountId);

  try {
    if (groupId.includes('@newsletter')) {
      const meta = await sock.newsletterMetadata("jid", groupId);
      let phone = meta.owner ? meta.owner.split('@')[0] : 'Unknown';
      // Convert hex to decimal for phone numbers that might be in hex format
      if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
        phone = parseInt(phone, 16).toString();
      }
      return {
        subject: meta.name,
        participants: [{
          phone: phone,
          admin: 'owner',
          isHidden: false,
          type: 'Channel',
          description: meta.description || '',
          subscriberCount: meta.subscribers || 0
        }]
      };
    }

    const metadata = await sock.groupMetadata(groupId);
    return {
      subject: metadata.subject,
      participants: metadata.participants.map((p: any) => {
        let isHidden = true;
        let phone = '';

        if (p.id && p.id.endsWith('@s.whatsapp.net')) {
          const beforeAt = p.id.split('@')[0];
          phone = beforeAt.split(':')[0];
          // Convert hex to decimal if needed
          if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
            phone = parseInt(phone, 16).toString();
          }
          if (/^\d{7,15}$/.test(phone)) {
            isHidden = false;
          }
        } else if (p.id && p.id.endsWith('@lid') && p.phoneNumber) {
          const pn = p.phoneNumber.includes('@')
            ? p.phoneNumber.split('@')[0]
            : p.phoneNumber;
          phone = pn.split(':')[0];
          // Convert hex to decimal if needed
          if (phone && /^[0-9a-fA-F]+$/.test(phone) && !/^\d+$/.test(phone)) {
            phone = parseInt(phone, 16).toString();
          }
          if (/^\d{7,15}$/.test(phone)) {
            isHidden = false;
          }
        }

        return {
          phone,
          admin: p.admin,
          isHidden
        };
      }).filter((p: any) => !p.isHidden)
    };
  } catch (error: any) {
    logger.error(`Failed to fetch group members for account ${accountId}, group ${groupId}:`, error);
    throw new Error(`Failed to fetch group members: ${error.message}. Ensure account is fully connected.`);
  }
}

/**
 * Check connection health before sending
 */
async function checkConnectionHealth(accountId: string): Promise<boolean> {
  try {
    const sock = activeSockets[accountId];
    const runtime = getConnectionRuntime(accountId);

    if (!sock || !sock.user) {
      logger.warn(`Account ${accountId} not properly connected`);
      return false;
    }

    const readyState = getSocketReadyState(sock);
    if (readyState !== undefined && readyState !== 1) {
      logger.warn(`Account ${accountId} socket readyState is ${readyState}`);
      return false;
    }

    if (runtime.status !== 'open') {
      logger.warn(`Account ${accountId} runtime status is ${runtime.status}`);
      return false;
    }
    
    logger.info(`Checking connection health for account ${accountId}`);
    return true;
  } catch (error: any) {
    logger.error(`Connection health check failed for ${accountId}:`, error);
    return false;
  }
}

/**
 * Send message with retry mechanism for unstable connections
 * Retries up to 5 times with exponential backoff
 */
export async function sendMessage(accountId: string, toPhone: string, text: string) {
  // Validate phone number first
  const validation = validatePhoneNumber(toPhone);
  if (!validation.isValid) {
    throw new Error(`Invalid phone number: ${validation.error}`);
  }

  // Check if number is WhatsApp eligible
  if (!isWhatsAppEligible(toPhone)) {
    throw new Error('Phone number is blocked or marked as service/toll-free.');
  }

  // Apply rate limiting to prevent account ban
  const waitTime = await rateLimiter.waitBeforeSend(accountId);
  if (waitTime > 0) {
    logger.info(`Rate limit applied for account ${accountId}: waited ${waitTime.toFixed(0)}ms`);
  }

  const maxRetries = 5;
  const baseDelay = 1000; // 1 second
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[Attempt ${attempt}/${maxRetries}] Sending message to ${validation.formattedNumber}`);
      
      const isHealthy = await checkConnectionHealth(accountId);
      const sock = isHealthy
        ? await ensureConnected(accountId, 30000)
        : await resetAndReconnect(accountId, `Send attempt ${attempt} required reconnection`);
      const jid = `${validation.formattedNumber}@s.whatsapp.net`;
      
      // Check if number is registered on WhatsApp
      const results = await sock.onWhatsApp(jid);
      
      // Handle various response types from Baileys
      if (!results || (Array.isArray(results) && results.length === 0)) {
        throw new Error('Phone number check failed or not registered on WhatsApp.');
      }
      
      const result = Array.isArray(results) ? results[0] : results;
      if (!result || !result.exists) {
        throw new Error('Phone number is not registered on WhatsApp.');
      }
      
      await sock.sendMessage(result.jid, { text });
      logger.info(`✅ Message sent successfully from ${accountId} to ${validation.formattedNumber} on attempt ${attempt}`);
      
      return { 
        success: true, 
        jid: result.jid, 
        waitTime, 
        validatedNumber: validation.formattedNumber,
        attempts: attempt
      };

    } catch (error: any) {
      lastError = error;
      logger.warn(`[Attempt ${attempt}/${maxRetries}] Failed to send message: ${error.message}`);
      
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.info(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted
  const errorMsg = `Failed to send message after ${maxRetries} attempts. Last error: ${lastError?.message || 'Unknown error'}`;
  logger.error(`❌ ${errorMsg}`);
  throw new Error(errorMsg);
}

/**
 * Send media message with retry mechanism for unstable connections.
 * Supports image, video, audio, and document payloads.
 */
export async function sendMediaMessage(accountId: string, toPhone: string, options: MediaSendOptions) {
  if (!options?.mediaPath) {
    throw new Error('mediaPath is required for media messages.');
  }

  const validation = validatePhoneNumber(toPhone);
  if (!validation.isValid) {
    throw new Error(`Invalid phone number: ${validation.error}`);
  }

  if (!isWhatsAppEligible(toPhone)) {
    throw new Error('Phone number is blocked or marked as service/toll-free.');
  }

  const waitTime = await rateLimiter.waitBeforeSend(accountId);
  if (waitTime > 0) {
    logger.info(`Rate limit applied for account ${accountId}: waited ${waitTime.toFixed(0)}ms before media send`);
  }

  const maxRetries = 5;
  const baseDelay = 1000;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[Attempt ${attempt}/${maxRetries}] Sending media to ${validation.formattedNumber}`);

      const isHealthy = await checkConnectionHealth(accountId);
      const sock = isHealthy
        ? await ensureConnected(accountId, 30000)
        : await resetAndReconnect(accountId, `Media send attempt ${attempt} required reconnection`);
      const jid = `${validation.formattedNumber}@s.whatsapp.net`;
      const results = await sock.onWhatsApp(jid);

      if (!results || (Array.isArray(results) && results.length === 0)) {
        throw new Error('Phone number check failed or not registered on WhatsApp.');
      }

      const result = Array.isArray(results) ? results[0] : results;
      if (!result || !result.exists) {
        throw new Error('Phone number is not registered on WhatsApp.');
      }

      const preparedMedia = buildMediaMessageContent(options);
      await sock.sendMessage(result.jid, preparedMedia.messageContent);

      logger.info(`✅ Media sent successfully from ${accountId} to ${validation.formattedNumber} on attempt ${attempt}`);

      return {
        success: true,
        jid: result.jid,
        waitTime,
        validatedNumber: validation.formattedNumber,
        attempts: attempt,
        mediaType: preparedMedia.mediaType,
        mediaPath: preparedMedia.absoluteMediaPath,
      };
    } catch (error: any) {
      lastError = error;
      logger.warn(`[Attempt ${attempt}/${maxRetries}] Failed to send media: ${error.message}`);

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.info(`Waiting ${delay}ms before media retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  const errorMsg = `Failed to send media after ${maxRetries} attempts. Last error: ${lastError?.message || 'Unknown error'}`;
  logger.error(`❌ ${errorMsg}`);
  throw new Error(errorMsg);
}

/**
 * Sends a personalized message to a contact
 * Replaces template variables with contact data
 */
export async function sendPersonalizedMessage(
  accountId: string,
  toPhone: string,
  messageTemplate: string,
  contactData: Record<string, any>
) {
  try {
    // Personalize the message
    const personalization = personalizeMessage(messageTemplate, {
      name: contactData.name,
      phone: toPhone,
      email: contactData.email,
      company: contactData.company,
      customFields: contactData.customFields || {},
    });

    if (personalization.missingVariables.length > 0) {
      logger.warn(`Missing variables for ${toPhone}: ${personalization.missingVariables.join(', ')}`);
    }

    // Send the personalized message
    return await sendMessage(accountId, toPhone, personalization.personalizedMessage);
  } catch (error: any) {
    logger.error(`Failed to send personalized message to ${toPhone}:`, error);
    throw new Error(error.message || 'Failed to send personalized message.');
  }
}
