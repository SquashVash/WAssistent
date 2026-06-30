import { openai } from './ai.js';
import { sendMessage } from './messaging.js';
import { getSetting } from './settings.js';
import { getTodaysEvents, formatEventsForPrompt } from './calendar.js';
import { getTasks, formatTasksForPrompt } from './tasks.js';

let briefTimeout = null;

function getTodayLabel(tz) {
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  const date = now.toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric' });
  return `${dayName}, ${date}`;
}

export async function sendDailyBrief() {
  const chatId = process.env.MY_CHAT_ID;
  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');

  if (!chatId) {
    console.error('❌ Daily brief: MY_CHAT_ID not set in .env');
    return;
  }

  const todayLabel = getTodayLabel(tz);

  let calendarContext = 'No calendar events found for today.';
  try {
    const events = await getTodaysEvents(tz);
    calendarContext = formatEventsForPrompt(events, tz);
    console.log(`📆 Fetched ${events.length} calendar event(s)`);
  } catch (err) {
    console.warn('⚠️ Could not fetch calendar events:', err.message);
  }

  let tasksContext = '';
  try {
    const tasks = await getTasks(tz);
    tasksContext = formatTasksForPrompt(tasks, tz);
    console.log(`✅ Fetched ${tasks.length} task(s)`);
  } catch (err) {
    console.warn('⚠️ Could not fetch tasks:', err.message);
  }

  const systemPrompt = `You are my personal assistant creating a concise WhatsApp daily brief.

First line must be exactly:
*Daily Brief - ${todayLabel}*

Start with one short, warm sentence summarizing the day ahead.

Make it easy to scan with clear categories and short bullets. Only include useful sections.

Possible sections:
*🎂 Birthdays* — today's birthdays, and tomorrow's only if useful
*📅 Schedule* — summarize the day in useful points, not every raw event
*✅ Tasks* — overdue tasks first, then due today, priority tasks, and quick wins
*🧳 Travel / Transitions* — travel, check-in/out, or stay changes

Rules:
* Keep it short, human, and phone-friendly
* Skip empty or repetitive sections
* Summarize calendar events instead of copying them
* Collapse related events into one useful point
* If I am staying in more than once place its a travel day, say the actual transition instead of listing separate stay/check-in/check-out events
* Do not dump every event/task
* Do not invent context
* Prioritize birthdays, overdue tasks, today's tasks, important events, then quick wins`;

  const userPrompt = `Today is ${todayLabel}.

Calendar events:
${calendarContext}${tasksContext ? `\n\nTasks:\n${tasksContext}` : ''}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const brief = response.choices[0].message.content;
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
