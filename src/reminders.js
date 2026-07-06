import { getSetting, setSetting } from './settings.js';
import { sendMessage } from './messaging.js';
import { humanizeReminder } from './ai.js';

const DEFAULT_TIME = '12:00';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const CHECK_MS = 60_000;
const INVALID_TIME = Symbol('invalid-time');

let pollTimer = null;

function getTz() {
  return getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
}

function getReminders() {
  return getSetting('reminders', null, []);
}

function saveReminders(list) {
  setSetting('reminders', list);
}

function todayDateStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

export function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Same year/month as `referenceDateStr`, but on `day` (clamped to the month's length).
function monthlyDateStr(referenceDateStr, day) {
  const [y, m] = referenceDateStr.split('-').map(Number);
  const clampedDay = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

function nextMonthRef(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const newM = m === 12 ? 1 : m + 1;
  const newY = m === 12 ? y + 1 : y;
  return `${newY}-${String(newM).padStart(2, '0')}-01`;
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getNowParts(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long',
  }).formatToParts(new Date());
  const p = {};
  for (const { type, value } of parts) p[type] = type === 'weekday' ? value : parseInt(value, 10);
  return p;
}

function matchWeekdayIndex(word) {
  const w = word.trim().toLowerCase();
  if (w.length < 3) return -1;
  return WEEKDAYS.findIndex(d => d === w || d.startsWith(w));
}

// Resolves "today" / "tomorrow" / "on <weekday>" to a YYYY-MM-DD date string.
function resolveDueDate(dateWord, tz) {
  const today = todayDateStr(tz);
  const w = dateWord.trim().toLowerCase();

  if (w === 'today') return today;
  if (w === 'tomorrow') return addDaysToDateStr(today, 1);

  const weekdayMatch = w.match(/^on\s+(.+)$/);
  if (weekdayMatch) {
    const idx = matchWeekdayIndex(weekdayMatch[1]);
    if (idx === -1) return null;
    const todayIdx = WEEKDAYS.indexOf(getNowParts(tz).weekday.toLowerCase());
    let diff = idx - todayIdx;
    if (diff < 0) diff += 7;
    return addDaysToDateStr(today, diff);
  }

  return null;
}

function describeDueDate(dueDate, tz) {
  const today = todayDateStr(tz);
  if (dueDate === today) return 'today';
  if (dueDate === addDaysToDateStr(today, 1)) return 'tomorrow';
  return dueDate;
}

function describeRecurrence(recurrence) {
  if (recurrence.type === 'daily') return 'every day';
  if (recurrence.type === 'weekly') return `every ${capitalize(WEEKDAYS[recurrence.weekday])}`;
  if (recurrence.type === 'monthly') return `every month on the ${ordinal(recurrence.day)}`;
  return '';
}

// "in Xh", "in Xm", "in XhYm", "in X hours", "in X minutes"
function parseDurationMs(phrase) {
  const m = phrase.match(/^in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i);
  if (!m || (!m[1] && !m[2])) return null;
  const hours = parseInt(m[1] || '0', 10);
  const minutes = parseInt(m[2] || '0', 10);
  const ms = (hours * 60 + minutes) * 60 * 1000;
  return ms > 0 ? ms : null;
}

function resolveFromDuration(ms, tz) {
  const target = new Date(Date.now() + ms);
  return {
    dueDate: target.toLocaleDateString('en-CA', { timeZone: tz }),
    dueTime: target.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

// "at HH:MM" always means the next occurrence of that time (today if still ahead, else tomorrow).
function resolveNextOccurrence(hh, mm, tz) {
  const today = todayDateStr(tz);
  const p = getNowParts(tz);
  const nowMinutes = p.hour * 60 + p.minute;
  const dueDate = (hh * 60 + mm) > nowMinutes ? today : addDaysToDateStr(today, 1);
  return { dueDate, dueTime: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

// Resolves a time phrase: "in ...", "at HH:MM", "today[ at HH:MM]",
// "tomorrow[ at HH:MM]", or "on <weekday>[ at HH:MM]".
function resolveTimePhrase(phrase, tz) {
  const p = phrase.trim();

  const durationMs = parseDurationMs(p);
  if (durationMs) return resolveFromDuration(durationMs, tz);

  const atMatch = p.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (atMatch) {
    const hh = parseInt(atMatch[1], 10);
    const mm = parseInt(atMatch[2], 10);
    if (hh > 23 || mm > 59) return null;
    return resolveNextOccurrence(hh, mm, tz);
  }

  const dateWordMatch = p.match(/^(today|tomorrow|on\s+\w+)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i);
  if (dateWordMatch) {
    const dueDate = resolveDueDate(dateWordMatch[1], tz);
    if (!dueDate) return null;
    let dueTime = DEFAULT_TIME;
    if (dateWordMatch[2] !== undefined) {
      const hh = parseInt(dateWordMatch[2], 10);
      const mm = parseInt(dateWordMatch[3], 10);
      if (hh > 23 || mm > 59) return null;
      dueTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    return { dueDate, dueTime };
  }

  return null;
}

function buildTimeStr(hhStr, mmStr) {
  if (hhStr === undefined) return DEFAULT_TIME;
  const hh = parseInt(hhStr, 10);
  const mm = parseInt(mmStr, 10);
  if (hh > 23 || mm > 59) return INVALID_TIME;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function addReminder(what, dueDate, dueTime, tz) {
  const reminders = getReminders();
  reminders.push({ id: makeId(), text: what, dueDate, dueTime });
  saveReminders(reminders);
  return `✅ I'll remind you to "${what}" ${describeDueDate(dueDate, tz)} at ${dueTime}.`;
}

// For other modules (e.g. the hotel-booking email scanner) to create a reminder
// directly from structured data, bypassing the chat-command text parsing above.
// `silent: true` means it only appears in the daily brief and never sends a message.
export function scheduleAutoReminder({ text, dueDate, dueTime, silent = false }) {
  const reminders = getReminders();
  reminders.push({ id: makeId(), text, dueDate, dueTime: dueTime || DEFAULT_TIME, silent });
  saveReminders(reminders);
}

// Computes the first occurrence for a new recurring reminder.
function resolveRecurrenceStart(type, tz, opts = {}) {
  const dueTime = opts.dueTime || DEFAULT_TIME;
  const today = todayDateStr(tz);
  const p = getNowParts(tz);
  const nowMinutes = p.hour * 60 + p.minute;
  const [hh, mm] = dueTime.split(':').map(Number);
  const timeMinutes = hh * 60 + mm;

  if (type === 'daily') {
    const dueDate = timeMinutes > nowMinutes ? today : addDaysToDateStr(today, 1);
    return { dueDate, dueTime };
  }

  if (type === 'weekly') {
    const todayIdx = WEEKDAYS.indexOf(p.weekday.toLowerCase());
    const targetIdx = opts.weekday !== undefined ? opts.weekday : todayIdx;
    let diff = targetIdx - todayIdx;
    if (diff < 0 || (diff === 0 && timeMinutes <= nowMinutes)) diff += 7;
    return { dueDate: addDaysToDateStr(today, diff), dueTime };
  }

  if (type === 'monthly') {
    let dueDate = monthlyDateStr(today, opts.day);
    if (dueDate < today || (dueDate === today && timeMinutes <= nowMinutes)) {
      dueDate = monthlyDateStr(nextMonthRef(today), opts.day);
    }
    return { dueDate, dueTime };
  }

  return null;
}

// Advances a fired recurring reminder to its next occurrence (called instead of removing it).
function advanceRecurrence(reminder) {
  const { recurrence, dueDate } = reminder;
  if (recurrence.type === 'daily') return { ...reminder, dueDate: addDaysToDateStr(dueDate, 1) };
  if (recurrence.type === 'weekly') return { ...reminder, dueDate: addDaysToDateStr(dueDate, 7) };
  if (recurrence.type === 'monthly') return { ...reminder, dueDate: monthlyDateStr(nextMonthRef(dueDate), recurrence.day) };
  return reminder;
}

function addRecurringReminder(type, text, opts, tz) {
  let recurrence;
  const recurOpts = { dueTime: opts.dueTime };

  if (type === 'daily') {
    recurrence = { type: 'daily' };
  } else if (type === 'weekly') {
    const todayIdx = WEEKDAYS.indexOf(getNowParts(tz).weekday.toLowerCase());
    recurrence = { type: 'weekly', weekday: todayIdx };
    recurOpts.weekday = todayIdx;
  } else if (type === 'monthly') {
    const day = opts.day !== undefined ? opts.day : parseInt(todayDateStr(tz).split('-')[2], 10);
    recurrence = { type: 'monthly', day };
    recurOpts.day = day;
  } else {
    return null;
  }

  const start = resolveRecurrenceStart(type, tz, recurOpts);

  const reminders = getReminders();
  reminders.push({ id: makeId(), text, dueDate: start.dueDate, dueTime: start.dueTime, recurrence });
  saveReminders(reminders);

  return `✅ I'll remind you to "${text}" ${describeRecurrence(recurrence)} at ${start.dueTime} (starting ${describeDueDate(start.dueDate, tz)}).`;
}

function parseErrorMessage() {
  return '❌ Couldn\'t parse that time. Examples:\n• remind me in 30m to call mom\n• remind me that my laundry is done in 22m\n• remind me at 14:30 to call mom\n• remind me to call mom tomorrow\n• remind me to call mom on tuesday at 9:00\n• remind me daily to take my pills\n• add a reminder every month on the 1st to send expenses';
}

// Time phrase shared by the one-off sentence orders below (one capturing group when embedded).
const TIME_PHRASE = '(?:in\\s+\\S.*|at\\s+\\d{1,2}:\\d{2}|today(?:\\s+at\\s+\\d{1,2}:\\d{2})?|tomorrow(?:\\s+at\\s+\\d{1,2}:\\d{2})?|on\\s+\\w+(?:\\s+at\\s+\\d{1,2}:\\d{2})?)';

// "remind me to|that <what> <time phrase>" — payload first, e.g.
// "remind me that my laundry is done in 22m" or "remind me to call mom tomorrow"
const PAYLOAD_FIRST_RE = new RegExp(`^remind\\s+me\\s+(?:to|that)\\s+(.+?)\\s+(${TIME_PHRASE})$`, 'i');

// "remind me <time phrase> to|that <what>" — time phrase first, e.g.
// "remind me in 30m to call mom"
const TIME_FIRST_RE = new RegExp(`^remind\\s+me\\s+(${TIME_PHRASE})\\s+(?:to|that)\\s+(.+)$`, 'i');

// "remind me daily|weekly|monthly to|that <what> [at HH:MM]"
const RECUR_TIME_FIRST_RE = /^remind\s+me\s+(daily|weekly|monthly)\s+(?:to|that)\s+(.+?)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i;

// "remind me to|that <what> daily|weekly|monthly [at HH:MM]"
const RECUR_PAYLOAD_FIRST_RE = /^remind\s+me\s+(?:to|that)\s+(.+?)\s+(daily|weekly|monthly)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i;

// "add a daily|weekly reminder to <what> [at HH:MM]"
const ADD_SIMPLE_RECUR_RE = /^add\s+a\s+(daily|weekly)\s+reminder\s+to\s+(.+?)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i;

// "add a monthly reminder on the Nth to <what> [at HH:MM]" / "add a reminder every month on the Nth to <what>"
const ADD_MONTHLY_RE = /^add\s+a\s+(?:monthly\s+reminder|reminder\s+every\s+month)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(.+?)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i;

// Fallback for a recurrence word embedded mid-payload, e.g. "remind me to take my weekly pills".
const PLAIN_TO_RE = /^remind\s+me\s+to\s+(.+)$/i;

export function handleReminderCommand(text) {
  const trimmed = text.trim();
  const tz = getTz();

  const recurTimeFirst = trimmed.match(RECUR_TIME_FIRST_RE);
  if (recurTimeFirst) {
    const dueTime = buildTimeStr(recurTimeFirst[3], recurTimeFirst[4]);
    if (dueTime === INVALID_TIME) return '❌ Invalid time. Use HH:MM (24h format).';
    return addRecurringReminder(recurTimeFirst[1].toLowerCase(), recurTimeFirst[2].trim(), { dueTime }, tz);
  }

  const recurPayloadFirst = trimmed.match(RECUR_PAYLOAD_FIRST_RE);
  if (recurPayloadFirst) {
    const dueTime = buildTimeStr(recurPayloadFirst[3], recurPayloadFirst[4]);
    if (dueTime === INVALID_TIME) return '❌ Invalid time. Use HH:MM (24h format).';
    return addRecurringReminder(recurPayloadFirst[2].toLowerCase(), recurPayloadFirst[1].trim(), { dueTime }, tz);
  }

  const addSimpleRecur = trimmed.match(ADD_SIMPLE_RECUR_RE);
  if (addSimpleRecur) {
    const dueTime = buildTimeStr(addSimpleRecur[3], addSimpleRecur[4]);
    if (dueTime === INVALID_TIME) return '❌ Invalid time. Use HH:MM (24h format).';
    return addRecurringReminder(addSimpleRecur[1].toLowerCase(), addSimpleRecur[2].trim(), { dueTime }, tz);
  }

  const addMonthly = trimmed.match(ADD_MONTHLY_RE);
  if (addMonthly) {
    const day = parseInt(addMonthly[1], 10);
    if (day < 1 || day > 31) return '❌ Day of month must be between 1 and 31.';
    const dueTime = buildTimeStr(addMonthly[3], addMonthly[4]);
    if (dueTime === INVALID_TIME) return '❌ Invalid time. Use HH:MM (24h format).';
    return addRecurringReminder('monthly', addMonthly[2].trim(), { dueTime, day }, tz);
  }

  const payloadFirstMatch = trimmed.match(PAYLOAD_FIRST_RE);
  if (payloadFirstMatch) {
    const resolved = resolveTimePhrase(payloadFirstMatch[2], tz);
    if (!resolved) return parseErrorMessage();
    return addReminder(payloadFirstMatch[1].trim(), resolved.dueDate, resolved.dueTime, tz);
  }

  const timeFirstMatch = trimmed.match(TIME_FIRST_RE);
  if (timeFirstMatch) {
    const resolved = resolveTimePhrase(timeFirstMatch[1], tz);
    if (!resolved) return parseErrorMessage();
    return addReminder(timeFirstMatch[2].trim(), resolved.dueDate, resolved.dueTime, tz);
  }

  // "remind me to take my weekly pills" — recurrence word buried in the payload, not trailing.
  const plainMatch = trimmed.match(PLAIN_TO_RE);
  if (plainMatch) {
    const payload = plainMatch[1].trim();
    const freqMatch = payload.match(/\b(daily|weekly|monthly)\b/i);
    if (freqMatch) {
      return addRecurringReminder(freqMatch[1].toLowerCase(), payload, {}, tz);
    }
  }

  if (/^reminders$/i.test(trimmed)) {
    const reminders = [...getReminders()].sort((a, b) => (a.dueDate + a.dueTime).localeCompare(b.dueDate + b.dueTime));
    if (!reminders.length) return '📭 No standing reminders.';
    const lines = reminders.map((r, i) => {
      const recur = r.recurrence ? ` (${describeRecurrence(r.recurrence)})` : '';
      const silentTag = r.silent ? ' (brief only)' : '';
      return `${i + 1}. ${r.text} — ${describeDueDate(r.dueDate, tz)} at ${r.dueTime}${recur}${silentTag}`;
    });
    return `⏰ *Reminders*\n${lines.join('\n')}`;
  }

  const cancelMatch = trimmed.match(/^cancel reminder (\d+)$/i);
  if (cancelMatch) {
    const reminders = [...getReminders()].sort((a, b) => (a.dueDate + a.dueTime).localeCompare(b.dueDate + b.dueTime));
    const idx = parseInt(cancelMatch[1], 10) - 1;
    if (idx < 0 || idx >= reminders.length) return '❌ Invalid reminder number. Send `reminders` to see the list.';
    const target = reminders[idx];
    saveReminders(getReminders().filter(r => r.id !== target.id));
    return `✅ Cancelled reminder: "${target.text}"`;
  }

  return null;
}

// Reminders due today, for the daily brief.
export function getRemindersForToday() {
  const today = todayDateStr(getTz());
  return getReminders().filter(r => r.dueDate === today).map(r => r.text);
}

async function checkDueReminders() {
  const tz = getTz();
  const reminders = getReminders();
  if (!reminders.length) return;

  const nowDateStr = todayDateStr(tz);
  const p = getNowParts(tz);
  const nowMinutes = p.hour * 60 + p.minute;

  const due = reminders.filter(r => {
    if (r.dueDate < nowDateStr) return true; // missed while offline — fire now
    if (r.dueDate > nowDateStr) return false;
    const [hh, mm] = r.dueTime.split(':').map(Number);
    return nowMinutes >= hh * 60 + mm;
  });

  if (!due.length) return;

  const dueIds = new Set(due.map(r => r.id));
  const remaining = reminders.filter(r => !dueIds.has(r.id));
  const rescheduled = due.filter(r => r.recurrence).map(r => advanceRecurrence(r));
  saveReminders([...remaining, ...rescheduled]);

  // brief-only reminders (e.g. hotel check-in) never send a message
  const toSend = due.filter(r => !r.silent);
  if (!toSend.length) return;

  try {
    const message = await humanizeReminder(toSend.map(r => r.text));
    await sendMessage(process.env.MY_CHAT_ID, message);
  } catch (err) {
    console.error('❌ Failed to send reminder:', err.message);
    const fallback = toSend.length > 1
      ? `⏰ Reminders:\n${toSend.map(r => `- ${r.text}`).join('\n')}`
      : `⏰ Reminder: ${toSend[0].text}`;
    await sendMessage(process.env.MY_CHAT_ID, fallback).catch(() => {});
  }
}

export function initReminders() {
  checkDueReminders().catch(err => console.error('❌ Reminder check failed:', err.message));
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    checkDueReminders().catch(err => console.error('❌ Reminder check failed:', err.message));
  }, CHECK_MS);
}
