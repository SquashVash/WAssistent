import { google } from 'googleapis';
import { sendDocument, sendMessage } from './messaging.js';
import { getSetting, setSetting } from './settings.js';
import { extractFlightInfo, extractHotelBooking } from './ai.js';
import { scheduleFlightTracking } from './flightTracker.js';
import { scheduleAutoReminder, addDaysToDateStr } from './reminders.js';

// Keywords used to identify ticket/booking emails by subject
const TICKET_KEYWORDS = /ticket|booking|reservation|boarding|e-ticket|confirmation|voucher/i;

// Keywords used to identify flight-related emails
const FLIGHT_EMAIL_KEYWORDS = /flight|itinerary|boarding pass|e-ticket|airline|booking|bravofly|lastminute\.com|travel|fly|trip\.com/i;

// Keywords used to identify hotel booking confirmation emails by subject
const HOTEL_BOOKING_KEYWORDS = /your booking is confirmed/i;

// Check-out reminders fire the evening before, at this time.
const CHECKOUT_REMINDER_TIME = '20:00';

const DEFAULT_POLL_MINUTES = 15;

// Tracks message IDs already evaluated this session to avoid redundant API calls
const seenIds = new Set();

let pollTimer = null;

// Booking/ticket results found by the automatic background poll (which has no one to
// notify) are held here until the next `scan` or `fetch emails` call, so they show up
// as part of that result message instead of as a standalone alert.
let pendingAutoResults = [];

function drainPendingAutoResults() {
  const drained = pendingAutoResults;
  pendingAutoResults = [];
  return drained;
}

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

  // Only surface previously-buffered auto-poll results to callers that will actually
  // report them (a real notify fn, or scan's collectOnly aggregation) — otherwise
  // leave them queued for later.
  if (notify || collectOnly) {
    const pending = drainPendingAutoResults();
    results.push(...pending);
    if (notify) for (const r of pending) await notify(r);
  }

  const flightResults = await scanForFlightEmails(notify).catch(err => {
    console.error('❌ Gmail: flight scan failed:', err.message);
    return [];
  });
  results.push(...flightResults);

  if (!collectOnly) {
    for (const r of flightResults) await sendMessage(process.env.MY_CHAT_ID, r);
  }

  const bookingResults = await scanForHotelBookingEmails().catch(err => {
    console.error('❌ Gmail: hotel booking scan failed:', err.message);
    return [];
  });
  results.push(...bookingResults);

  if (!collectOnly) {
    for (const r of bookingResults) {
      if (notify) await notify(r);
      else pendingAutoResults.push(r);
    }
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
        for (const r of ticketResults) {
          if (notify) await notify(r);
          else pendingAutoResults.push(r);
        }
      }
    } catch (err) {
      console.error(`❌ Gmail: failed to process message ${id}:`, err.message);
      if (!collectOnly) {
        const msg = `❌ Failed to process email: ${err.message}`;
        if (notify) await notify(msg);
        else pendingAutoResults.push(msg);
      }
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

// Tracks message IDs already scanned for hotel bookings this session
const scannedBookingIds = new Set();

// Scans for "Your booking is confirmed"-style emails, extracts check-in/check-out via AI,
// and auto-creates: a silent (brief-only) reminder for check-in, and a normal reminder
// the evening before check-out.
export async function scanForHotelBookingEmails() {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread subject:("your booking is confirmed")',
    maxResults: 20,
  });

  const messages = res.data.messages || [];
  const newMessages = messages.filter(({ id }) => !scannedBookingIds.has(id));

  const results = [];

  for (const { id } of newMessages) {
    scannedBookingIds.add(id);
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const subject = getHeader(msg.data, 'Subject');

      if (!HOTEL_BOOKING_KEYWORDS.test(subject)) {
        console.log(`   ↳ skipped "${subject}" (no hotel booking keywords)`);
        continue;
      }

      const body = extractEmailBody(msg.data.payload);
      if (!body) {
        console.log(`   ↳ skipped "${subject}" (no body text)`);
        continue;
      }

      console.log(`🏨 Extracting hotel booking info from: "${subject}"`);
      const booking = await extractHotelBooking(body);

      if (!booking) {
        console.log(`   ↳ no booking info found`);
        continue;
      }

      const hotelName = booking.hotelName || 'your hotel';
      const checkInTime = booking.checkIn.time || '15:00';
      const checkOutTime = booking.checkOut.time || '11:00';

      scheduleAutoReminder({
        text: `Check-In today is at ${checkInTime}`,
        dueDate: booking.checkIn.date,
        dueTime: checkInTime,
        silent: true,
      });

      scheduleAutoReminder({
        text: `Check-out tomorrow is at ${checkOutTime}`,
        dueDate: addDaysToDateStr(booking.checkOut.date, -1),
        dueTime: CHECKOUT_REMINDER_TIME,
        silent: false,
      });

      console.log(`   ↳ scheduled check-in (${booking.checkIn.date}) and check-out (${booking.checkOut.date}) reminders for ${hotelName}`);
      results.push(`🏨 Added check-in/check-out reminders for *${hotelName}*`);
    } catch (err) {
      console.error(`❌ Gmail: failed to process hotel booking email ${id}:`, err.message);
    }
  }

  return results;
}

export async function fetchTicketEmails(notify = null, collectOnly = false) {
  return poll(notify, collectOnly);
}

export async function testGmailConnection() {
  try {
    const auth = getAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const { data } = await gmail.users.getProfile({ userId: 'me' });
    return { ok: true, detail: `${data.emailAddress} — ${data.messagesTotal} messages` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// ---- Receipt candidates (consumed by receipts.js, which also merges in Zoho) ----

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
    console.log(`   ↳ sent "${filename}" (${sourceName}) via Gmail ✅`);
    sentAny = true;
  }
  return sentAny;
}

// Lists PDF-attachment emails in the given date range as generic receipt candidates.
// `start`/`end` are Date objects (end exclusive); either may be omitted for an all-time search.
export async function listGmailReceiptCandidates({ start, end } = {}) {
  const auth = getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const fmt = d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  let dateQuery = '';
  if (start) dateQuery += ` after:${fmt(start)}`;
  if (end) dateQuery += ` before:${fmt(end)}`;

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `has:attachment filename:pdf${dateQuery}`,
    maxResults: 100,
  });

  const messages = res.data.messages || [];
  const candidates = [];
  for (const { id } of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const match = {
      id,
      subject: getHeader(msg.data, 'Subject'),
      from: getHeader(msg.data, 'From'),
      data: msg.data,
    };
    candidates.push({
      subject: match.subject,
      from: match.from,
      date: msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null,
      sendAttachments: (sourceName) => sendReceiptFromMessage(gmail, sourceName, match),
    });
  }
  return candidates;
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
