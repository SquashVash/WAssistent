import { google } from 'googleapis';
import { sendDocument, sendMessage } from './messaging.js';
import { getSetting, setSetting } from './settings.js';
import { extractFlightInfo } from './ai.js';
import { scheduleFlightTracking } from './flightTracker.js';

// Keywords used to identify ticket/booking emails by subject
const TICKET_KEYWORDS = /ticket|booking|reservation|boarding|e-ticket|confirmation|voucher/i;

// Keywords used to identify flight-related emails
const FLIGHT_EMAIL_KEYWORDS = /flight|itinerary|boarding pass|e-ticket|airline|booking|bravofly|lastminute\.com|travel|fly|trip\.com/i;

const DEFAULT_POLL_MINUTES = 15;

// Adjustable list of subscription/service sources tracked for the `receipts` command.
// `day` is informational (billing day of month) and shown in `receipts sources`.
const DEFAULT_RECEIPT_SOURCES = [
  { name: 'Taapi', enabled: true, keywords: ['taapi'] },
  { name: 'Google Cloud', enabled: true, day: 5, keywords: ['google cloud', 'google workspace'] },
  { name: 'chatGPT', enabled: true, day: 4, keywords: ['chatgpt'] },
  { name: 'Bubble', enabled: true, keywords: ['bubble'] },
  { name: 'Cursor', enabled: true, keywords: ['cursor'] },
  { name: 'Canva', enabled: true, keywords: ['canva'] },
  { name: 'Figma', enabled: false, keywords: ['figma'] },
  { name: 'Appfigures', enabled: true, day: 7, keywords: ['appfigures'] },
  { name: 'RevenueCat', enabled: true, keywords: ['revenuecat'] },
  { name: 'Claude', enabled: true, keywords: ['claude', 'anthropic'] },
  { name: 'Charity', enabled: false, keywords: ['charity', 'donation'] },
  { name: 'Godaddy', enabled: true, keywords: ['godaddy'] },
  { name: 'OpenAi API', enabled: true, keywords: ['openai'], exclude: ['chatgpt'] },
  { name: 'Buffer', enabled: true, keywords: ['buffer'] },
  { name: 'Wordpress', enabled: false, keywords: ['wordpress'] },
  { name: 'Elementor', enabled: false, keywords: ['elementor'] },
  { name: 'Gtranslate', enabled: false, keywords: ['gtranslate'] },
  { name: 'Audio Player by Sonaar', enabled: false, keywords: ['sonaar', 'audio player'] },
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

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
    return [];
  }

  const parts = msg.data.payload?.parts || [];
  const results = [];

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
    results.push(`📎 Sent *${filename}* — _${subject}_`);
  }

  if (results.length === 0) {
    console.log(`   ↳ matched keywords but no PDF attachments found`);
  }

  // Mark processed email as read so it won't appear in future polls
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });

  return results;
}

async function poll(notify = null, collectOnly = false) {
  const results = [];

  const flightResults = await scanForFlightEmails(notify).catch(err => {
    console.error('❌ Gmail: flight scan failed:', err.message);
    return [];
  });
  results.push(...flightResults);

  if (!collectOnly) {
    for (const r of flightResults) await sendMessage(process.env.MY_CHAT_ID, r);
  }

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
      const ticketResults = await processMessage(gmail, id);
      results.push(...ticketResults);
      if (!collectOnly) {
        for (const r of ticketResults) await notify?.(r);
      }
    } catch (err) {
      console.error(`❌ Gmail: failed to process message ${id}:`, err.message);
      if (!collectOnly) await notify?.(`❌ Failed to process email: ${err.message}`);
    }
  }

  return results;
}

function extractEmailBody(payload) {
  if (!payload) return '';

  // Prefer text/plain, fall back to text/html
  const tryDecode = (part) => {
    const data = part?.body?.data;
    if (!data) return null;
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  };

  if (payload.mimeType === 'text/plain') return tryDecode(payload) || '';
  if (payload.mimeType === 'text/html') return tryDecode(payload) || '';

  const parts = payload.parts || [];
  const plain = parts.find(p => p.mimeType === 'text/plain');
  if (plain) return tryDecode(plain) || '';
  const html = parts.find(p => p.mimeType === 'text/html');
  if (html) return tryDecode(html) || '';

  // Recurse into multipart
  for (const part of parts) {
    const text = extractEmailBody(part);
    if (text) return text;
  }
  return '';
}

// Tracks message IDs already scanned for flights this session
const scannedFlightIds = new Set();

export async function scanForFlightEmails(notify = null) {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread subject:(flight OR itinerary OR boarding OR e-ticket OR airline OR booking OR Bravofly OR lastminute OR Travel OR fly OR Trip)',
    maxResults: 20,
  });

  const messages = res.data.messages || [];
  const newMessages = messages.filter(({ id }) => !scannedFlightIds.has(id));

  console.log(`✈️ Gmail: scanning ${newMessages.length} new flight email(s)`);
  await notify?.(`✈️ Gmail: scanning ${newMessages.length} new flight email(s)`);

  const results = [];

  for (const { id } of newMessages) {
    scannedFlightIds.add(id);
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const subject = getHeader(msg.data, 'Subject');

      if (!FLIGHT_EMAIL_KEYWORDS.test(subject)) {
        console.log(`   ↳ skipped "${subject}" (no flight keywords)`);
        continue;
      }

      const body = extractEmailBody(msg.data.payload);
      if (!body) {
        console.log(`   ↳ skipped "${subject}" (no body text)`);
        continue;
      }

      console.log(`✈️ Extracting flight info from: "${subject}"`);
      const flight = await extractFlightInfo(body);

      if (!flight) {
        console.log(`   ↳ no flight info found`);
        continue;
      }

      console.log(`   ↳ found: ${flight.callsign} departing ${flight.departureIso}`);
      const scheduled = scheduleFlightTracking(flight.callsign, flight.departureIso);

      if (scheduled) {
        const dep = new Date(flight.departureIso);
        const trackingStart = new Date(dep.getTime() - 4 * 60 * 60 * 1000);
        const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');

        const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
        const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });

        results.push(`✈️ Found flight *${flight.callsign}* in email — departure ${fmtDate(dep)} at ${fmtTime(dep)}, tracking starts ${fmtTime(trackingStart)} on ${fmtDate(trackingStart)}`);
      }
    } catch (err) {
      console.error(`❌ Gmail: failed to process flight email ${id}:`, err.message);
    }
  }

  return results;
}

export async function fetchTicketEmails(notify = null, collectOnly = false) {
  return poll(notify, collectOnly);
}

// ---- Receipt sources (adjustable list) ----

export function getReceiptSources() {
  const stored = getSetting('receiptSources', null, null);
  if (Array.isArray(stored)) return stored;
  const defaults = DEFAULT_RECEIPT_SOURCES.map(s => ({ ...s }));
  setSetting('receiptSources', defaults);
  return defaults;
}

function saveReceiptSources(list) {
  setSetting('receiptSources', list);
}

function findSourceIndex(sources, name) {
  const q = name.trim().toLowerCase();
  return sources.findIndex(s => s.name.toLowerCase() === q);
}

export function addReceiptSource(name) {
  const sources = getReceiptSources();
  if (findSourceIndex(sources, name) !== -1) return false;
  sources.push({ name: name.trim(), enabled: true, keywords: [name.trim().toLowerCase()] });
  saveReceiptSources(sources);
  return true;
}

export function removeReceiptSource(name) {
  const sources = getReceiptSources();
  const idx = findSourceIndex(sources, name);
  if (idx === -1) return false;
  sources.splice(idx, 1);
  saveReceiptSources(sources);
  return true;
}

export function setReceiptSourceEnabled(name, enabled) {
  const sources = getReceiptSources();
  const idx = findSourceIndex(sources, name);
  if (idx === -1) return false;
  sources[idx].enabled = enabled;
  saveReceiptSources(sources);
  return true;
}

function sourceMatches(source, subject, from) {
  const haystack = `${subject} ${from}`.toLowerCase();
  const hasKeyword = (source.keywords || []).some(k => haystack.includes(k.toLowerCase()));
  if (!hasKeyword) return false;
  const excluded = (source.exclude || []).some(k => haystack.includes(k.toLowerCase()));
  return !excluded;
}

function findConfiguredSource(sources, query) {
  const q = query.trim().toLowerCase();
  return (
    sources.find(s => s.name.toLowerCase() === q) ||
    sources.find(s => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) ||
    sources.find(s => (s.keywords || []).some(k => k.toLowerCase() === q || q.includes(k.toLowerCase()))) ||
    null
  );
}

// word must be a full or prefix match (min 3 chars) of a month name
export function matchMonthName(word) {
  if (!word) return -1;
  const w = word.trim().toLowerCase();
  if (w.length < 3) return -1;
  return MONTH_NAMES.findIndex(m => m === w || m.startsWith(w));
}

function resolveMonthRange(monthName) {
  const now = new Date();
  const idx = matchMonthName(monthName);
  const year = idx > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
  const start = new Date(year, idx, 1);
  const end = new Date(year, idx + 1, 1);
  const fmt = d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { after: fmt(start), before: fmt(end), label };
}

async function listReceiptCandidates(gmail, dateQuery, maxResults = 100) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `has:attachment filename:pdf${dateQuery}`,
    maxResults,
  });
  const messages = res.data.messages || [];
  const detailed = [];
  for (const { id } of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    detailed.push({
      id,
      subject: getHeader(msg.data, 'Subject'),
      from: getHeader(msg.data, 'From'),
      data: msg.data,
    });
  }
  return detailed;
}

async function sendReceiptFromMessage(gmail, sourceName, match) {
  const parts = match.data.payload?.parts || [];
  let sentAny = false;
  for (const part of parts) {
    const isPdf = part.mimeType === 'application/pdf' || part.filename?.toLowerCase().endsWith('.pdf');
    if (!isPdf || !part.body?.attachmentId) continue;

    const filename = part.filename || 'receipt.pdf';
    const att = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: match.id,
      id: part.body.attachmentId,
    });
    const base64 = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
    const caption = `🧾 *${sourceName}*\n${match.subject}\nFrom: ${match.from}`;
    await sendDocument(process.env.MY_CHAT_ID, base64, filename, caption);
    console.log(`   ↳ sent "${filename}" (${sourceName}) ✅`);
    sentAny = true;
  }
  return sentAny;
}

// Sends the single most recent matching receipt PDF per source (not every match).
export async function fetchReceiptsForSources(sources, { after, before } = {}) {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  let dateQuery = '';
  if (after) dateQuery += ` after:${after}`;
  if (before) dateQuery += ` before:${before}`;

  const candidates = await listReceiptCandidates(gmail, dateQuery);
  console.log(`📬 Gmail: found ${candidates.length} receipt candidate(s) in range`);

  const found = [];
  const missing = [];
  let sent = 0;

  for (const source of sources) {
    const match = candidates.find(c => sourceMatches(source, c.subject, c.from));
    if (!match) { missing.push(source.name); continue; }

    const sentAny = await sendReceiptFromMessage(gmail, source.name, match);
    if (sentAny) { found.push(source.name); sent++; }
    else missing.push(source.name);
  }

  return { sent, found, missing };
}

export async function fetchReceiptsForMonth(monthName) {
  const targetMonth = monthName || MONTH_NAMES[new Date().getMonth()];
  const { after, before, label } = resolveMonthRange(targetMonth);

  const sources = getReceiptSources().filter(s => s.enabled);
  const result = await fetchReceiptsForSources(sources, { after, before });
  return { ...result, label };
}

// Finds one specific source (configured or ad-hoc) and sends its most recent receipt, any time.
export async function fetchReceiptForSource(query) {
  const sources = getReceiptSources();
  const configured = findConfiguredSource(sources, query);
  const source = configured || { name: query.trim(), keywords: [query.trim().toLowerCase()] };

  const result = await fetchReceiptsForSources([source], {});
  return { sourceName: source.name, found: result.found.length > 0 };
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
