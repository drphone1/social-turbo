const Database = require('better-sqlite3');

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const SELF_PHONE_CANDIDATES = ['+989363548118', '989363548118'];
const MESSAGE_TEMPLATE = 'سلام، این تست UTF-8 برای بررسی سلامت متن فارسی و ایموجی ✅🚀 است.';
const MAX_STATUS_POLLS = 50;
const STATUS_POLL_DELAY_MS = 3000;

if (typeof process.stdout.setDefaultEncoding === 'function') {
  process.stdout.setDefaultEncoding('utf8');
}

if (typeof process.stderr.setDefaultEncoding === 'function') {
  process.stderr.setDefaultEncoding('utf8');
}

async function requestJson(path, options) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status} ${text}`);
  }

  return data;
}

function findSelfContact(contacts) {
  const matches = contacts.filter((contact) => SELF_PHONE_CANDIDATES.includes(contact.phone));
  return matches.find((contact) => contact.phone === '+989363548118')
    || matches.find((contact) => contact.fullName === 'شماره من')
    || matches[0];
}

function hasSuspiciousQuestionMarks(value) {
  return typeof value === 'string' && /\?{3,}/.test(value);
}

async function main() {
  console.log('=== UTF-8 SELF TEST START ===');

  const health = await requestJson('/api/health');
  console.log('Health:', health.status);

  const accounts = await requestJson('/api/accounts');
  const connectedAccount = accounts.find((account) => account.status === 'connected');
  if (!connectedAccount) {
    throw new Error('No connected WhatsApp account found.');
  }

  console.log('Connected account:', connectedAccount.displayName, connectedAccount.id);

  const contacts = await requestJson('/api/contacts');
  const selfContact = findSelfContact(contacts);
  if (!selfContact) {
    throw new Error('Self contact was not found in CRM contacts.');
  }

  console.log('Self contact:', selfContact.fullName || 'بدون نام', selfContact.phone, selfContact.id);

  const campaignName = `UTF8_SELF_TEST_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const created = await requestJson('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      name: campaignName,
      accountIds: [connectedAccount.id],
      contactIds: [selfContact.id],
      messageTemplate: MESSAGE_TEMPLATE,
      scheduleType: 'immediate',
      maxPerHour: 10,
      maxPerDay: 20,
      delayMinMs: 500,
      delayMaxMs: 1000,
    }),
  });

  console.log('Campaign created:', created.id);
  if (Array.isArray(created.warnings) && created.warnings.length > 0) {
    console.log('Warnings:', JSON.stringify(created.warnings, null, 2));
  }

  await requestJson(`/api/campaigns/execute/${created.id}`, { method: 'POST' });
  console.log('Campaign queued. Polling status...');

  let finalStatus = null;
  for (let index = 0; index < MAX_STATUS_POLLS; index += 1) {
    const status = await requestJson(`/api/campaigns/${created.id}/status`);
    console.log(`Poll ${index}:`, status.status, `sent=${status.sentCount}`, `failed=${status.failedCount}`);

    if (['completed', 'failed', 'paused', 'cancelled'].includes(status.status)) {
      finalStatus = status;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_DELAY_MS));
  }

  if (!finalStatus) {
    throw new Error('Campaign status polling timed out.');
  }

  const db = new Database('database/whatsapp-turbo.db', { readonly: true });
  const campaignRow = db.prepare('SELECT id, name, message_template, status FROM campaigns WHERE id = ?').get(created.id);
  const logRow = db.prepare('SELECT content, status FROM message_logs WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 1').get(created.id);
  db.close();

  console.log('Stored campaign template:', campaignRow?.message_template);
  console.log('Stored last log content:', logRow?.content);

  if (hasSuspiciousQuestionMarks(campaignRow?.message_template) || hasSuspiciousQuestionMarks(logRow?.content)) {
    throw new Error('UTF-8 self test detected suspicious replacement question marks in stored text.');
  }

  console.log('=== UTF-8 SELF TEST PASSED ===');
  console.log(JSON.stringify({
    campaignId: created.id,
    finalStatus: finalStatus.status,
    sentCount: finalStatus.sentCount,
    failedCount: finalStatus.failedCount,
    template: campaignRow?.message_template,
    logContent: logRow?.content,
  }, null, 2));
}

main().catch((error) => {
  console.error('UTF-8 self test failed:', error.message);
  process.exit(1);
});