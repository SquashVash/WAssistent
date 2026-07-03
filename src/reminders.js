import { getSetting, setSetting } from './settings.js';
import { sendMessage } from './messaging.js';
import { humanizeReminder } from './ai.js';

const DEFAULT_TIME = '12:00';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const CHECK_MS = 60_000;

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

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
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

// Resolves the old-style leading time phrase: "in ...", "at HH:MM", "tomorrow[ at HH:MM]".
function resolveOldStyleTimePhrase(phrase, tz) {
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

  const tomorrowMatch = p.match(/^tomorrow(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i);
  if (tomorrowMatch) {
    const dueDate = addDaysToDateStr(todayDateStr(tz), 1);
    let dueTime = DEFAULT_TIME;
    if (tomorrowMatch[1] !== undefined) {
      const hh = parseInt(tomorrowMatch[1], 10);
      const mm = parseInt(tomorrowMatch[2], 10);
      if (hh > 23 || mm > 59) return null;
      dueTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    return { dueDate, dueTime };
  }

  return null;
}

function addReminder(what, dueDate, dueTime, tz) {
  const reminders = getReminders();
  reminders.push({ id: Date.now().toString(36), text: what, dueDate, dueTime });
  saveReminders(reminders);
  return `✅ I'll remind you to "${what}" ${describeDueDate(dueDate, tz)} at ${dueTime}.`;
}

// Matches two phrasings:
//   "remind me to <what> today|tomorrow|on <weekday> [at HH:MM]"
//   "remind me in .../at HH:MM/tomorrow[ at HH:MM] to|that <what>"
export function handleReminderCommand(text) {
  const trimmed = text.trim();
  const tz = getTz();

  const newStyleMatch = trimmed.match(/^remind\s+me\s+to\s+(.+?)\s+(today|tomorrow|on\s+\w+)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i);
  if (newStyleMatch) {
    const what = newStyleMatch[1].trim();
    const dueDate = resolveDueDate(newStyleMatch[2], tz);
    if (!dueDate) return null;

    let dueTime = DEFAULT_TIME;
    if (newStyleMatch[3] !== undefined) {
      const hh = parseInt(newStyleMatch[3], 10);
      const mm = parseInt(newStyleMatch[4], 10);
      if (hh > 23 || mm > 59) return '❌ Invalid time. Use HH:MM (24h format).';
      dueTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }

    return addReminder(what, dueDate, dueTime, tz);
  }

  const oldStyleMatch = trimmed.match(/^remind\s+me\s+(in\s+.+?|at\s+\d{1,2}:\d{2}|tomorrow(?:\s+at\s+\d{1,2}:\d{2})?)\s+(?:to|that)\s+(.+)$/i);
  if (oldStyleMatch) {
    const resolved = resolveOldStyleTimePhrase(oldStyleMatch[1], tz);
    if (!resolved) {
      return '❌ Couldn\'t parse that time. Examples:\n• remind me in 30m to call mom\n• remind me at 14:30 to call mom\n• remind me tomorrow to call mom\n• remind me tomorrow at 9:00 to call mom';
    }
    return addReminder(oldStyleMatch[2].trim(), resolved.dueDate, resolved.dueTime, tz);
  }

  if (/^reminders$/i.test(trimmed)) {
    const reminders = [...getReminders()].sort((a, b) => (a.dueDate + a.dueTime).localeCompare(b.dueDate + b.dueTime));
    if (!reminders.length) return '📭 No standing reminders.';
    const lines = reminders.map((r, i) => `${i + 1}. ${r.text} — ${describeDueDate(r.dueDate, tz)} at ${r.dueTime}`);
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
  saveReminders(reminders.filter(r => !dueIds.has(r.id)));

  for (const r of due) {
    try {
      const message = await humanizeReminder(r.text);
      await sendMessage(process.env.MY_CHAT_ID, message);
    } catch (err) {
      console.error('❌ Failed to send reminder:', err.message);
      await sendMessage(process.env.MY_CHAT_ID, `⏰ Reminder: ${r.text}`).catch(() => {});
    }
  }
}

export function initReminders() {
  checkDueReminders().catch(err => console.error('❌ Reminder check failed:', err.message));
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    checkDueReminders().catch(err => console.error('❌ Reminder check failed:', err.message));
  }, CHECK_MS);
}
