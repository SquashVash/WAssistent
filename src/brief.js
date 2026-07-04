import { generateBriefIntro } from './ai.js';
import { sendMessage } from './messaging.js';
import { getSetting } from './settings.js';
import { getUpcomingEvents } from './calendar.js';
import { getTasks, categorizeTasks } from './tasks.js';
import { getRemindersForToday } from './reminders.js';

let briefTimeout = null;

function getTodayLabel(tz) {
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  const date = now.toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric' });
  return `${dayName}, ${date}`;
}

function dateStrInTz(date, tz) {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

// Returns [startDateStr, endDateStrExclusive] for an event in tz-local calendar dates,
// so multi-day all-day events (e.g. a hotel stay) are matched on every day they cover.
function eventDateRange(event, tz) {
  if (event.start?.date) {
    return [event.start.date, event.end?.date || event.start.date];
  }
  if (event.start?.dateTime) {
    const d = dateStrInTz(new Date(event.start.dateTime), tz);
    return [d, addOneDay(d)];
  }
  return [null, null];
}

function addOneDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function eventCoversDate(event, dateStr, tz) {
  const [start, end] = eventDateRange(event, tz);
  if (!start) return false;
  return start <= dateStr && dateStr < end;
}

function isBirthdayEvent(event) {
  // Google's auto-synced Contacts birthdays set eventType:'birthday' with summary
  // being just the person's name (no "birthday" text) — text match is a fallback
  // for manually-created birthday events.
  return event.eventType === 'birthday' || /birthday/i.test(event.summary || '');
}

function extractBirthdayName(title) {
  let name = title.replace(/^birthday:?\s*/i, '');
  name = name.replace(/(?:'s)?\s*birthday\s*$/i, '').trim();
  return name || title;
}

function isIncomeEvent(event) {
  return /income/i.test(event.summary || '');
}

function isExpenseEvent(event) {
  return /payment/i.test(event.summary || '');
}

function isPaymentEvent(event) {
  return isIncomeEvent(event) || isExpenseEvent(event);
}

function formatEventBullet(event, tz, todayStr, tomorrowStr) {
  const summary = event.summary || '(No title)';

  if (event.start?.date) {
    if ((stayLengthDays(event) || 0) > 1) {
      const venue = extractVenueName(summary);
      if (event.start.date === todayStr) return `Checking in to ${venue}.`;
      if (!eventCoversDate(event, tomorrowStr, tz)) return `Checking out of ${venue}.`;
    }
    return `${summary}.`;
  }

  const time = new Date(event.start.dateTime).toLocaleTimeString('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${summary} at ${time}.`;
}

// Google Calendar's "(Day N/M)" label is computed by its UI from the event's start/end
// dates — it isn't part of the actual event data, so we compute the same thing ourselves.
function stayLengthDays(event) {
  if (!event.start?.date || !event.end?.date) return null;
  const [y1, m1, d1] = event.start.date.split('-').map(Number);
  const [y2, m2, d2] = event.end.date.split('-').map(Number);
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.round((end - start) / 86_400_000);
}

function extractVenueName(title) {
  return (title || '').replace(/^stay(?:ing)?\s+at\s+/i, '').trim();
}

function buildBirthdaysSection(events, todayStr, tomorrowStr, tz) {
  const lines = [];
  for (const event of events) {
    if (!isBirthdayEvent(event)) continue;
    const name = extractBirthdayName(event.summary || '');
    if (eventCoversDate(event, todayStr, tz)) lines.push(`It is ${name} birthday today`);
    else if (eventCoversDate(event, tomorrowStr, tz)) lines.push(`don't forget it's ${name}'s birthday tomorrow`);
  }
  return lines;
}

function sortAllDayThenTimed(events) {
  const allDay = events.filter(e => e.start?.date);
  const timed = events.filter(e => e.start?.dateTime)
    .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
  return [...allDay, ...timed];
}

function buildScheduleSection(events, todayStr, tomorrowStr, tz) {
  const todays = events.filter(e => !isBirthdayEvent(e) && !isPaymentEvent(e) && eventCoversDate(e, todayStr, tz));
  return sortAllDayThenTimed(todays).map(e => formatEventBullet(e, tz, todayStr, tomorrowStr));
}

function buildPaymentsSection(events, todayStr, tomorrowStr, tz) {
  const todays = events.filter(e => isPaymentEvent(e) && eventCoversDate(e, todayStr, tz));
  return sortAllDayThenTimed(todays).map(e => {
    const emoji = isIncomeEvent(e) ? '💰' : '💸';
    return `${emoji} ${formatEventBullet(e, tz, todayStr, tomorrowStr)}`;
  });
}

function buildTasksSection(tasks, tz) {
  const { overdue, dueToday } = categorizeTasks(tasks, tz);
  const lines = [];
  for (const t of overdue) lines.push(`Overdue: ${t.title}`);
  for (const t of dueToday) lines.push(`Due today: ${t.title}`);
  return lines;
}

function renderSection(title, emoji, lines) {
  if (!lines.length) return '';
  return `*${emoji} ${title}*\n${lines.map(l => `- ${l}`).join('\n')}`;
}

export async function sendDailyBrief() {
  const chatId = process.env.MY_CHAT_ID;
  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');

  if (!chatId) {
    console.error('❌ Daily brief: MY_CHAT_ID not set in .env');
    return;
  }

  const todayLabel = getTodayLabel(tz);
  const now = new Date();
  const todayStr = dateStrInTz(now, tz);
  const tomorrowStr = dateStrInTz(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);

  let events = [];
  try {
    events = await getUpcomingEvents(tz, 2);
    console.log(`📆 Fetched ${events.length} calendar event(s)`);
  } catch (err) {
    console.warn('⚠️ Could not fetch calendar events:', err.message);
  }

  let tasks = [];
  try {
    tasks = await getTasks(tz);
    console.log(`✅ Fetched ${tasks.length} task(s)`);
  } catch (err) {
    console.warn('⚠️ Could not fetch tasks:', err.message);
  }

  let reminders = [];
  try {
    reminders = getRemindersForToday();
  } catch (err) {
    console.warn('⚠️ Could not fetch reminders:', err.message);
  }

  const sections = [
    renderSection('Birthdays', '🎂', buildBirthdaysSection(events, todayStr, tomorrowStr, tz)),
    renderSection('Schedule', '📅', buildScheduleSection(events, todayStr, tomorrowStr, tz)),
    renderSection('Payments', '💰', buildPaymentsSection(events, todayStr, tomorrowStr, tz)),
    renderSection('Tasks', '✅', buildTasksSection(tasks, tz)),
    renderSection('Reminders', '⏰', reminders),
  ].filter(Boolean);

  const briefBody = sections.join('\n\n');

  let intro = '';
  try {
    intro = await generateBriefIntro(briefBody, todayLabel);
  } catch (err) {
    console.warn('⚠️ Could not generate brief intro:', err.message);
  }

  const parts = [`*Daily Brief - ${todayLabel}*`];
  if (intro) parts.push(intro);
  if (briefBody) parts.push(briefBody);
  parts.push('Enjoy your day!');

  const brief = parts.join('\n\n');

  try {
    await sendMessage(chatId, brief);
    console.log(`📅 Daily brief sent to ${chatId}`);
  } catch (err) {
    console.error('❌ Failed to send daily brief:', err.message);
  }
}

export function scheduleDailyBrief() {
  if (briefTimeout) clearTimeout(briefTimeout);

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
  const targetHour = parseInt(getSetting('briefHour', 'DAILY_BRIEF_HOUR', '10'), 10);
  const targetMinute = parseInt(getSetting('briefMinute', 'DAILY_BRIEF_MINUTE', '0'), 10);

  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const p = {};
  for (const { type, value } of parts) p[type] = parseInt(value, 10);

  let msUntilNext =
    ((targetHour - p.hour) * 3600 + (targetMinute - p.minute) * 60 - p.second) * 1000;
  if (msUntilNext <= 0) msUntilNext += 24 * 60 * 60 * 1000;

  const minutesUntil = Math.round(msUntilNext / 60000);
  console.log(`⏰ Daily brief scheduled in ${minutesUntil} min (${targetHour}:${String(targetMinute).padStart(2, '0')} ${tz})`);

  briefTimeout = setTimeout(async () => {
    await sendDailyBrief();
    scheduleDailyBrief();
  }, msUntilNext);
}
