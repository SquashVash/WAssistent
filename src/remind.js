import { sendAdminMessage } from './messaging.js';
import { getSetting } from './settings.js';

const DEFAULT_TOMORROW_HOUR = 9;

function getTzParts(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const p = {};
  for (const { type, value } of parts) p[type] = parseInt(value, 10);
  return p;
}

// Parse "in Xm", "in Xh", "in XhYm", "in X minutes/hours", "at HH:MM", "tomorrow", "tomorrow at HH:MM"
function parseRemindTime(text) {
  // "in 30m" / "in 2h" / "in 1h30m" / "in 45 minutes" / "in 2 hours"
  const inMatch = text.match(
    /^in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i
  );
  if (inMatch && (inMatch[1] || inMatch[2])) {
    const hours = parseInt(inMatch[1] || '0', 10);
    const minutes = parseInt(inMatch[2] || '0', 10);
    const ms = (hours * 60 + minutes) * 60 * 1000;
    if (ms > 0) return { ms, label: formatDuration(hours, minutes) };
  }

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');

  // "at HH:MM" — next occurrence in user's timezone
  const atMatch = text.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (atMatch) {
    const targetHour = parseInt(atMatch[1], 10);
    const targetMinute = parseInt(atMatch[2], 10);
    if (targetHour > 23 || targetMinute > 59) return null;

    const p = getTzParts(tz);
    let ms = ((targetHour - p.hour) * 3600 + (targetMinute - p.minute) * 60 - p.second) * 1000;
    if (ms <= 0) ms += 24 * 60 * 60 * 1000;

    const label = `${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')} (${tz})`;
    return { ms, label };
  }

  // "tomorrow" or "tomorrow at HH:MM"
  const tomorrowMatch = text.match(/^tomorrow(?:\s+at\s+(\d{1,2}):(\d{2}))?$/i);
  if (tomorrowMatch) {
    const targetHour = tomorrowMatch[1] !== undefined ? parseInt(tomorrowMatch[1], 10) : DEFAULT_TOMORROW_HOUR;
    const targetMinute = tomorrowMatch[2] !== undefined ? parseInt(tomorrowMatch[2], 10) : 0;
    if (targetHour > 23 || targetMinute > 59) return null;

    const p = getTzParts(tz);
    // ms until that time tomorrow = ms until same time today + 24h
    let ms = ((targetHour - p.hour) * 3600 + (targetMinute - p.minute) * 60 - p.second) * 1000;
    ms += 24 * 60 * 60 * 1000;

    const timeStr = `${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}`;
    return { ms, label: `tomorrow at ${timeStr} (${tz})` };
  }

  return null;
}

function formatDuration(hours, minutes) {
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function handleRemind(text) {
  // Matches: "remind [me] <time> to/that <what>"
  // time can be: "in ...", "at HH:MM", "tomorrow", "tomorrow at HH:MM"
  const match = text.match(
    /^remind\s+(?:me\s+)(in\s+.+?|at\s+\d{1,2}:\d{2}|tomorrow(?:\s+at\s+\d{1,2}:\d{2})?)\s+(?:to|that)\s+(.+)$/i
  );
  if (!match) return null;

  const timePart = match[1].trim();
  const what = match[2].trim();

  const parsed = parseRemindTime(timePart);
  if (!parsed) return '❌ Couldn\'t parse the time. Examples:\n• remind me in 30m to call mom\n• remind me at 14:30 to call mom\n• remind me tomorrow to call mom\n• remind me tomorrow at 9:00 to call mom';

  setTimeout(async () => {
    try {
      await sendAdminMessage(`⏰ Reminder: ${what}`);
    } catch (err) {
      console.error('❌ Failed to send reminder:', err.message);
    }
  }, parsed.ms);

  return `✅ I'll remind you to "${what}" ${parsed.label.startsWith('tomorrow') ? parsed.label : `in ${parsed.label}`}`;
}
