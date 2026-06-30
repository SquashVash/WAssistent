import { google } from 'googleapis';
import { sendDocument } from './messaging.js';

// Keywords used to identify ticket/booking emails by subject
const TICKET_KEYWORDS = /ticket|booking|reservation|boarding|e-ticket|confirmation|voucher/i;

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// Tracks message IDs already evaluated this session to avoid redundant API calls
const seenIds = new Set();

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

  if (!TICKET_KEYWORDS.test(subject)) return;

  const from = getHeader(msg.data, 'From');
  const parts = msg.data.payload?.parts || [];

  for (const part of parts) {
    const isPdf = part.mimeType === 'application/pdf' || part.filename?.toLowerCase().endsWith('.pdf');
    if (!isPdf || !part.body?.attachmentId) continue;

    const att = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.body.attachmentId,
    });

    // Gmail returns base64url — convert to standard base64
    const base64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
    const filename = part.filename || 'ticket.pdf';
    const caption = `📧 *${subject}*\nFrom: ${from}`;

    await sendDocument(process.env.MY_CHAT_ID, base64, filename, caption);
    console.log(`📎 Gmail: sent PDF "${filename}" to WhatsApp`);
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

  for (const { id } of res.data.messages || []) {
    if (seenIds.has(id)) continue;
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

export function startGmailWatcher() {
  console.log('📧 Gmail ticket watcher started (polling every 2 min)');
  poll().catch(err => console.error('❌ Gmail: initial poll failed:', err.message));
  setInterval(() => {
    poll().catch(err => console.error('❌ Gmail poll error:', err.message));
  }, POLL_INTERVAL_MS);
}
