import { getSetting, setSetting } from './settings.js';
import { scheduleDailyBrief, sendDailyBrief } from './brief.js';
import { handleRemind } from './remind.js';
import { fetchTicketEmails, setGmailPollInterval, getGmailPollMinutes, fetchMonthlyReceipts } from './gmail.js';
import { lookupFlight } from './flights.js';
import { trackFlight, untrackFlight, listTracked, setFlightPollInterval, getFlightPollMinutes } from './flightTracker.js';

export async function handleCommand(body) {
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

  if (/^send briefing?$/i.test(lower)) {
    await sendDailyBrief();
    return null;
  }

  if (/^set email interval (\d+)(m|h)?$/i.test(lower)) {
    const match = lower.match(/^set email interval (\d+)(m|h)?$/i);
    const value = parseInt(match[1], 10);
    const unit = (match[2] || 'm').toLowerCase();
    const minutes = unit === 'h' ? value * 60 : value;
    if (minutes < 1) return '❌ Interval must be at least 1 minute.';
    setGmailPollInterval(minutes);
    return `✅ Email check interval set to ${minutes} min.`;
  }

  if (/^email interval$/i.test(lower)) {
    return `📬 Email check interval: every ${getGmailPollMinutes()} min`;
  }

  if (/^fetch emails?$/i.test(lower)) {
    await fetchTicketEmails();
    return '📧 Email check done — any ticket PDFs have been sent.';
  }

  if (/^receipts?$/i.test(lower)) {
    const sent = await fetchMonthlyReceipts();
    return sent > 0
      ? `🧾 Done — sent ${sent} receipt PDF(s) from this month.`
      : `🧾 No receipt PDFs found for this month.`;
  }

  const flightMatch = lower.match(/^flight\s+([a-z0-9]+)$/i);
  if (flightMatch) {
    return await lookupFlight(flightMatch[1]);
  }

  const trackMatch = lower.match(/^track\s+([a-z0-9]+)$/i);
  if (trackMatch) {
    const added = trackFlight(trackMatch[1]);
    return added
      ? `✈️ Now tracking *${trackMatch[1].toUpperCase()}* — you'll get updates when something changes.`
      : `✈️ Already tracking *${trackMatch[1].toUpperCase()}*.`;
  }

  const untrackMatch = lower.match(/^untrack\s+([a-z0-9]+)$/i);
  if (untrackMatch) {
    const removed = untrackFlight(untrackMatch[1]);
    return removed
      ? `✅ Stopped tracking *${untrackMatch[1].toUpperCase()}*.`
      : `⚠️ *${untrackMatch[1].toUpperCase()}* wasn't being tracked.`;
  }

  if (/^tracked$/i.test(lower)) {
    const flights = listTracked();
    return flights.length
      ? `✈️ Tracked flights:\n${flights.map(f => `• ${f}`).join('\n')}`
      : `✈️ No flights currently being tracked.`;
  }

  if (/^flight interval$/i.test(lower)) {
    return `✈️ Flight poll interval: every ${getFlightPollMinutes()} min`;
  }

  if (/^set flight interval (\d+)(m|h)?$/i.test(lower)) {
    const match = lower.match(/^set flight interval (\d+)(m|h)?$/i);
    const value = parseInt(match[1], 10);
    const unit = (match[2] || 'm').toLowerCase();
    const minutes = unit === 'h' ? value * 60 : value;
    if (minutes < 1) return '❌ Interval must be at least 1 minute.';
    setFlightPollInterval(minutes);
    return `✅ Flight poll interval set to ${minutes} min.`;
  }

  if (/^settings$/i.test(lower)) {
    const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
    const hour = parseInt(getSetting('briefHour', 'DAILY_BRIEF_HOUR', '10'), 10);
    const minute = parseInt(getSetting('briefMinute', 'DAILY_BRIEF_MINUTE', '0'), 10);
    const emailInterval = getGmailPollMinutes();
    const flightInterval = getFlightPollMinutes();
    return `*⚙️ Current Settings*

*Daily Brief*
• Time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${tz})

*Emails*
• Check interval: every ${emailInterval} min

*Flights*
• Poll interval: every ${flightInterval} min`;
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

*Flights*
• \`flight <callsign>\` — look up live flight status (e.g. \`flight ELY006\`)
• \`track <callsign>\` — get automatic updates when status/delay/gate changes
• \`untrack <callsign>\` — stop tracking a flight
• \`tracked\` — list all currently tracked flights
• \`flight interval\` — show current poll interval
• \`set flight interval 5m\` — set poll interval (e.g. 2m, 10m)

*Emails*
• \`fetch emails\` — check Gmail now for ticket PDFs
• \`receipts\` — send all receipt PDFs from this month
• \`email interval\` — show current check interval
• \`set email interval 15m\` — set interval (e.g. 30m, 1h)

*Manual Triggers*
• \`send brief\` — send the daily brief right now

*Other*
• \`settings\` — show all current settings

Anything else is sent to the AI assistant.`;
  }

  return false;
}
