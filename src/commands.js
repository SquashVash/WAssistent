import { exec } from 'child_process';
import { promisify } from 'util';
import { getSetting, setSetting } from './settings.js';
import { scheduleDailyBrief, sendDailyBrief } from './brief.js';
import { handleRemind } from './remind.js';
import { fetchTicketEmails, setGmailPollInterval, getGmailPollMinutes, fetchMonthlyReceipts } from './gmail.js';
import { sendMessage } from './messaging.js';
import { lookupFlight } from './flights.js';
import { trackFlight, untrackFlight, listTracked, setFlightPollInterval, getFlightPollMinutes } from './flightTracker.js';
import { handleDMSMessage } from './dms.js';
import { runScan, setScanEnabled, isScanEnabled, setScanTime, getScanTime } from './scan.js';

const execAsync = promisify(exec);

export async function handleCommand(msg) {
  const body = typeof msg === 'string' ? msg : (msg?.body ?? '');

  // DMS must run first — it intercepts all messages during setup and challenge responses
  const dmsResult = await handleDMSMessage(msg);
  if (dmsResult !== false) return dmsResult;

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

  if (/^scan$/i.test(lower)) {
    await runScan();
    return null;
  }

  const scanTimeMatch = lower.match(/^set scan time (\d{1,2}):(\d{2})$/i);
  if (scanTimeMatch) {
    const hour = parseInt(scanTimeMatch[1], 10);
    const minute = parseInt(scanTimeMatch[2], 10);
    if (hour > 23 || minute > 59) return '❌ Invalid time. Use HH:MM (24h format).';
    const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    setScanTime(hhmm);
    return `✅ Auto scan set to ${hhmm}`;
  }

  if (/^scan automatic on$/i.test(lower)) {
    setScanEnabled(true);
    return '🔍 Automatic scan enabled.';
  }

  if (/^scan automatic off$/i.test(lower)) {
    setScanEnabled(false);
    return '🔍 Automatic scan disabled.';
  }

  if (/^fetch emails?$/i.test(lower)) {
    const chatId = process.env.MY_CHAT_ID;
    const notify = (text) => sendMessage(chatId, text);
    await fetchTicketEmails(notify);
    return null;
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

  const HELP_CATEGORIES = {
    brief: {
      emoji: '📅',
      label: 'Daily Brief',
      text: `*📅 Daily Brief*
• \`brief status\` — show current brief time & timezone
• \`set brief time HH:MM\` — set daily brief time (24h)
• \`set brief timezone <tz>\` — set timezone (e.g. Europe/London)
• \`send brief\` — send the daily brief right now`,
    },
    reminders: {
      emoji: '⏰',
      label: 'Reminders',
      text: `*⏰ Reminders*
• \`remind me in 30m to <what>\`
• \`remind me in 2h to <what>\`
• \`remind me in 1h30m to <what>\`
• \`remind me at 14:30 to <what>\`
• \`remind me tomorrow to <what>\`
• \`remind me tomorrow at 9:00 to <what>\``,
    },
    flights: {
      emoji: '✈️',
      label: 'Flights',
      text: `*✈️ Flights*
• \`flight <callsign>\` — look up live flight status (e.g. \`flight ELY006\`)
• \`track <callsign>\` — get automatic updates when status/delay/gate changes
• \`untrack <callsign>\` — stop tracking a flight
• \`tracked\` — list all currently tracked flights
• \`flight interval\` — show current poll interval
• \`set flight interval 5m\` — set poll interval (e.g. 2m, 10m)`,
    },
    emails: {
      emoji: '📧',
      label: 'Emails',
      text: `*📧 Emails*
• \`fetch emails\` — check Gmail now for ticket PDFs and flight bookings
• \`receipts\` — send all receipt PDFs from this month
• \`email interval\` — show current check interval
• \`set email interval 15m\` — set interval (e.g. 30m, 1h)`,
    },
    dms: {
      emoji: '💀',
      label: 'Dead Man\'s Switch',
      text: `*💀 Dead Man\'s Switch*
• \`DMS\` — set up or reconfigure the dead man\'s switch
• \`DMS status\` — show current state
• \`DMS pause\` — pause until manually resumed
• \`DMS sleep 2h\` — pause for a set time, then auto-resume
• \`DMS start\` — resume a paused switch
• \`DMS disable\` — permanently disable (requires password)`,
    },
    server: {
      emoji: '🖥️',
      label: 'Server',
      text: `*🖥️ Server*
• \`scan\` — run scan manually
• \`scan automatic on/off\` — enable or disable automatic scan
• \`set scan time HH:MM\` — set automatic scan time (24h)
• \`logs\` — fetch last 50 log lines
• \`logs 100\` — fetch last N log lines
• \`refresh\` — git pull and restart the bot
• \`restart\` — restart the bot via pm2`,
    },
    other: {
      emoji: '⚙️',
      label: 'Other',
      text: `*⚙️ Other*
• \`settings\` — show all current settings
• \`help <category>\` — show commands for a category`,
    },
  };

  if (/^help$/i.test(lower)) {
    const lines = Object.values(HELP_CATEGORIES).map(c => `${c.emoji} *${c.label}*`);
    return `*Help — choose a category:*\n\n${lines.join('\n')}\n\nSend \`help <category>\` for commands.\nAnything else is sent to the AI assistant.`;
  }

  const logsMatch = lower.match(/^logs(?:\s+(\d+))?$/i);
  if (logsMatch) {
    const lines = parseInt(logsMatch[1] || '50', 10);
    const appName = process.env.PM2_APP_NAME || 'bot';
    try {
      const { stdout, stderr } = await execAsync(`pm2 logs ${appName} --nostream --lines ${lines}`);
      const output = (stdout + stderr).trim();
      if (!output) return '📋 No logs found.';
      // WhatsApp message limit ~4096 chars — trim from the start if needed
      const trimmed = output.length > 3800 ? '...\n' + output.slice(-3800) : output;
      return `📋 *Last ${lines} log lines:*\n\`\`\`\n${trimmed}\n\`\`\``;
    } catch (err) {
      return `❌ Failed to fetch logs: ${err.message}`;
    }
  }

  if (/^restart$/i.test(lower)) {
    const appName = process.env.PM2_APP_NAME || 'bot';
    setTimeout(() => execAsync(`pm2 restart ${appName}`).catch(console.error), 500);
    return '🔄 Restarting bot...';
  }

  if (/^refresh$/i.test(lower)) {
    const appName = process.env.PM2_APP_NAME || 'bot';
    try {
      const { stdout } = await execAsync('git pull');
      const summary = stdout.trim().split('\n').pop();
      setTimeout(() => execAsync(`pm2 restart ${appName}`).catch(console.error), 500);
      return `✅ ${summary}\n🔄 Restarting bot...`;
    } catch (err) {
      return `❌ git pull failed: ${err.message}`;
    }
  }

  const helpCatMatch = lower.match(/^help\s+(.+)$/i);
  if (helpCatMatch) {
    const key = helpCatMatch[1].trim().toLowerCase();
    const cat = HELP_CATEGORIES[key] || Object.values(HELP_CATEGORIES).find(c => c.label.toLowerCase() === key);
    if (!cat) {
      const names = Object.keys(HELP_CATEGORIES).join(', ');
      return `❌ Unknown category. Try: ${names}`;
    }
    return cat.text;
  }

  return false;
}
