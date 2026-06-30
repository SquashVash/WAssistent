import { getSetting, setSetting } from './settings.js';
import { scheduleDailyBrief } from './brief.js';
import { handleRemind } from './remind.js';

export function handleCommand(body) {
  const remindReply = handleRemind(body.trim());
  if (remindReply !== null) return remindReply;

  const text = body.trim();
  const lower = text.toLowerCase();

  const timeMatch = lower.match(/^set (?:brief )?time (\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    if (hour > 23 || minute > 59) return '❌ Invalid time. Use HH:MM (24h format).';
    setSetting('briefHour', hour);
    setSetting('briefMinute', minute);
    scheduleDailyBrief();
    const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
    return `✅ Daily brief time set to ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${tz})`;
  }

  const tzMatch = text.match(/^set (?:brief )?timezone (.+)$/i);
  if (tzMatch) {
    const tz = tzMatch[1].trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    } catch {
      return `❌ Unknown timezone "${tz}". Use an IANA name like Europe/London or America/New_York.`;
    }
    setSetting('briefTimezone', tz);
    scheduleDailyBrief();
    const hour = getSetting('briefHour', 'DAILY_BRIEF_HOUR', '10');
    const minute = getSetting('briefMinute', 'DAILY_BRIEF_MINUTE', '0');
    return `✅ Timezone set to ${tz}. Brief will arrive at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${tz}`;
  }

  if (/^brief (status|settings)$/i.test(lower)) {
    const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
    const hour = parseInt(getSetting('briefHour', 'DAILY_BRIEF_HOUR', '10'), 10);
    const minute = parseInt(getSetting('briefMinute', 'DAILY_BRIEF_MINUTE', '0'), 10);
    return `📅 Daily brief: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${tz})`;
  }

  if (/^help$/i.test(lower)) {
    return `*Available commands:*

*Daily Brief*
• \`brief status\` — show current brief time & timezone
• \`set brief time HH:MM\` — set daily brief time (24h)
• \`set brief timezone <tz>\` — set timezone (e.g. Europe/London)

*Reminders*
• \`remind me in 30m to <what>\`
• \`remind me in 2h to <what>\`
• \`remind me in 1h30m to <what>\`
• \`remind me at 14:30 to <what>\`
• \`remind me tomorrow to <what>\`
• \`remind me tomorrow at 9:00 to <what>\`

Anything else is sent to the AI assistant.`;
  }

  return null;
}
