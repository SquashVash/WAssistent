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

// Matches: remind me to <what> today|tomorrow|on <weekday> [at HH:MM]
export function handleReminderCommand(text) {
  const trimmed = text.trim();
  const tz = getTz();

  const addMatch = trimmed.match(/^remind\s+me\s+to\s+(.+?)\s+(today|tomorrow|on\s+\w+)(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i);
  if (addMatch) {
    const what = addMatch[1].trim();
    const dueDate = resolveDueDate(addMatch[2], tz);
    if (!dueDate) return null;

    let dueTime = DEFAULT_TIME;
    if (addMatch[3] !== undefined) {
      const hh = parseInt(addMatch[3], 10);
      const mm = parseInt(addMatch[4], 10);
      if (hh > 23 || mm > 59) return '❌ Invalid time. Use HH:MM (24h format).';
      dueTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }

    const reminders = getReminders();
    reminders.push({ id: Date.now().toString(36), text: what, dueDate, dueTime });
    saveReminders(reminders);

    return `✅ I'll remind you to "${what}" ${describeDueDate(dueDate, tz)} at ${dueTime}.`;
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
