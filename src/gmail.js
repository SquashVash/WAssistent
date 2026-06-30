import { google } from 'googleapis';
import { sendDocument } from './messaging.js';
import { getSetting, setSetting } from './settings.js';

// Keywords used to identify ticket/booking emails by subject
const TICKET_KEYWORDS = /ticket|booking|reservation|boarding|e-ticket|confirmation|voucher/i;

// Keywords used to identify receipt emails by subject
const RECEIPT_KEYWORDS = /receipt|invoice|order|payment|purchase|charged|bill|transaction/i;

const DEFAULT_POLL_MINUTES = 15;

// Tracks message IDs already evaluated this session to avoid redundant API calls
const seenIds = new Set();

let pollTimer = null;

function getPollMs() {
  return parseInt(getSetting('gmailPollMinutes', 'GMAIL_POLL_MINUTES', DEFAULT_POLL_MINUTES), 10) * 60 * 1000;
}

function getAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing Google credentials in .env (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
  }
  // NOTE: GOOGLE_REFRESH_TOKEN must include the Gmail scope (gmail.modify).
  // If it was created only for Calendar, re-run your OAuth flow with both scopes.
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return auth;
}

function getHeader(message, name) {
  return message.payload?.headers?.find(
    h => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

async function processMessage(gmail, messageId) {
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const subject = getHeader(msg.data, 'Subject');
  const from = getHeader(msg.data, 'From');

  console.log(`📧 Gmail: scanning — "${subject}" from ${from}`);

  if (!TICKET_KEYWORDS.test(subject)) {
    console.log(`   ↳ skipped (no ticket keywords in subject)`);
    return;
  }

  const parts = msg.data.payload?.parts || [];
  let pdfCount = 0;

  for (const part of parts) {
    const isPdf = part.mimeType === 'application/pdf' || part.filename?.toLowerCase().endsWith('.pdf');
    if (!isPdf || !part.body?.attachmentId) continue;

    const filename = part.filename || 'ticket.pdf';
    console.log(`   ↳ found PDF: "${filename}" — downloading...`);

    const att = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.body.attachmentId,
    });

    // Gmail returns base64url — convert to standard base64
    const base64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
    const caption = `📧 *${subject}*\nFrom: ${from}`;

    await sendDocument(process.env.MY_CHAT_ID, base64, filename, caption);
    console.log(`   ↳ sent "${filename}" to WhatsApp ✅`);
    pdfCount++;
  }

  if (pdfCount === 0) {
    console.log(`   ↳ matched keywords but no PDF attachments found`);
  }

  // Mark processed email as read so it won't appear in future polls
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function poll() {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread has:attachment filename:pdf',
    maxResults: 10,
  });

  const messages = res.data.messages || [];
  const newMessages = messages.filter(({ id }) => !seenIds.has(id));

  console.log(`📬 Gmail: poll — ${newMessages.length} new email(s) with PDF attachments`);

  for (const { id } of newMessages) {
    seenIds.add(id);
    try {
      await processMessage(gmail, id);
    } catch (err) {
      console.error(`❌ Gmail: failed to process message ${id}:`, err.message);
    }
  }
}

export async function fetchTicketEmails() {
  await poll();
}

export async function fetchMonthlyReceipts() {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  // Gmail date filter uses YYYY/MM/DD format
  const after = `${firstOfMonth.getFullYear()}/${String(firstOfMonth.getMonth() + 1).padStart(2, '0')}/01`;

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${after} has:attachment filename:pdf`,
    maxResults: 100,
  });

  const messages = res.data.messages || [];
  console.log(`📬 Gmail: scanning ${messages.length} email(s) with PDF attachments from this month`);

  let sent = 0;
  for (const { id } of messages) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const subject = getHeader(msg.data, 'Subject');
      const from = getHeader(msg.data, 'From');

      if (!RECEIPT_KEYWORDS.test(subject)) {
        console.log(`   ↳ skipped "${subject}" (no receipt keywords)`);
        continue;
      }

      console.log(`📧 Receipt found: "${subject}" from ${from}`);

      const parts = msg.data.payload?.parts || [];
      for (const part of parts) {
        const isPdf = part.mimeType === 'application/pdf' || part.filename?.toLowerCase().endsWith('.pdf');
        if (!isPdf || !part.body?.attachmentId) continue;

        const filename = part.filename || 'receipt.pdf';
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: id,
          id: part.body.attachmentId,
        });

        const base64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
        const caption = `🧾 *${subject}*\nFrom: ${from}`;
        await sendDocument(process.env.MY_CHAT_ID, base64, filename, caption);
        console.log(`   ↳ sent "${filename}" ✅`);
        sent++;
      }
    } catch (err) {
      console.error(`❌ Gmail: failed to process receipt message ${id}:`, err.message);
    }
  }

  return sent;
}

export function setGmailPollInterval(minutes) {
  setSetting('gmailPollMinutes', minutes);
  startGmailWatcher();
}

export function getGmailPollMinutes() {
  return parseInt(getSetting('gmailPollMinutes', 'GMAIL_POLL_MINUTES', DEFAULT_POLL_MINUTES), 10);
}

export function startGmailWatcher() {
  if (pollTimer) clearInterval(pollTimer);
  const minutes = getGmailPollMinutes();
  console.log(`📧 Gmail ticket watcher started (polling every ${minutes} min)`);
  poll().catch(err => console.error('❌ Gmail: initial poll failed:', err.message));
  pollTimer = setInterval(() => {
    poll().catch(err => console.error('❌ Gmail poll error:', err.message));
  }, getPollMs());
}
