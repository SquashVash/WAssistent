import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { getSetting, setSetting } from './settings.js';
import { scheduleDailyBrief, sendDailyBrief } from './brief.js';
import { handleRemind } from './remind.js';
import { fetchTicketEmails, setGmailPollInterval, getGmailPollMinutes, testGmailConnection } from './gmail.js';
import {
  fetchReceiptsForMonth, fetchReceiptForSource, matchMonthName,
  getReceiptSources, addReceiptSource, removeReceiptSource, setReceiptSourceEnabled,
} from './receipts.js';
import { testZohoConnections } from './zoho.js';
import { testCalendarConnection } from './calendar.js';
import { testTasksConnection } from './tasks.js';
import { sendMessage, sendFile } from './messaging.js';
import QRCode from 'qrcode';
import { lookupFlight } from './flights.js';
import { trackFlight, untrackFlight, listTracked, getScheduled, unscheduleFlight, rescheduleFlight, clearAllTracked, clearAllScheduled, setFlightPollInterval, getFlightPollMinutes } from './flightTracker.js';
import { handleDMSMessage } from './dms.js';
import { runScan, setScanEnabled, isScanEnabled, setScanTime, getScanTime } from './scan.js';
import { handleOsintCommand, osintHelp, getOsintPollMinutes, testMaigretAvailability, testSpiderfootConnection } from './osint.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function formatReceiptSourcesList() {
  const sources = getReceiptSources();
  const lines = sources.map(s => {
    const box = s.enabled ? '[v]' : '[ ]';
    const day = s.day ? ` - on the ${ordinal(s.day)}` : '';
    return `${box} ${s.name}${day}`;
  });
  return `*🧾 Receipt Sources*\n${lines.join('\n')}\n\nManage: \`receipts sources add <name>\`, \`remove <name>\`, \`enable <name>\`, \`disable <name>\``;
}

function formatReceiptsResult(sent, found, missing, label) {
  const lines = [`🧾 *Receipts — ${label}*`];
  if (found.length) lines.push(`✅ Sent: ${found.join(', ')}`);
  if (missing.length) lines.push(`❌ Not found: ${missing.join(', ')}`);
  if (!found.length && !missing.length) lines.push('No enabled receipt sources configured.');
  return lines.join('\n');
}

const SERVICE_STATUS_CHECKS = {
  gmail: { label: 'Gmail', run: testGmailConnection },
  calendar: { label: 'Calendar', run: testCalendarConnection },
  tasks: { label: 'Tasks', run: testTasksConnection },
  maigret: { label: 'Maigret', run: testMaigretAvailability },
  spiderfoot: { label: 'Spiderfoot', run: testSpiderfootConnection },
};

function formatCheckLine(label, result) {
  return `${result.ok ? '✅' : '❌'} ${label} — ${result.detail}`;
}

function formatZohoLines(results) {
  return results.map(r => {
    if (!r.configured) return `⚠️ Zoho (${r.email}) — not configured (${r.error})`;
    if (!r.ok) return `❌ Zoho (${r.email}) — ${r.error}`;
    return `✅ Zoho (${r.email}) — connected (${r.messageCount} message(s) in INBOX)`;
  });
}

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

  const receiptSourcesMatch = text.match(/^receipts?\s+sources(?:\s+(.+))?$/i);
  if (receiptSourcesMatch) {
    const rest = receiptSourcesMatch[1]?.trim();
    if (!rest) return formatReceiptSourcesList();

    const addMatch = rest.match(/^add\s+(.+)$/i);
    if (addMatch) {
      const name = addMatch[1].trim();
      const added = addReceiptSource(name);
      return added
        ? `✅ Added *${name}* to receipt sources (enabled).`
        : `⚠️ *${name}* is already in the receipt sources list.`;
    }

    const removeMatch = rest.match(/^(?:remove|delete)\s+(.+)$/i);
    if (removeMatch) {
      const name = removeMatch[1].trim();
      const removed = removeReceiptSource(name);
      return removed
        ? `✅ Removed *${name}* from receipt sources.`
        : `⚠️ Couldn't find *${name}* in the receipt sources list.`;
    }

    const enableMatch = rest.match(/^(?:enable|on)\s+(.+)$/i);
    if (enableMatch) {
      const name = enableMatch[1].trim();
      const ok = setReceiptSourceEnabled(name, true);
      return ok
        ? `✅ *${name}* enabled for receipts.`
        : `⚠️ Couldn't find *${name}* in the receipt sources list.`;
    }

    const disableMatch = rest.match(/^(?:disable|off)\s+(.+)$/i);
    if (disableMatch) {
      const name = disableMatch[1].trim();
      const ok = setReceiptSourceEnabled(name, false);
      return ok
        ? `✅ *${name}* disabled for receipts.`
        : `⚠️ Couldn't find *${name}* in the receipt sources list.`;
    }

    return `❌ Unknown sources command. Try: \`receipts sources\`, \`receipts sources add <name>\`, \`receipts sources remove <name>\`, \`receipts sources enable <name>\`, \`receipts sources disable <name>\`.`;
  }

  const receiptsMatch = text.match(/^receipts?(?:\s+(.+))?$/i);
  if (receiptsMatch) {
    const arg = receiptsMatch[1]?.trim();

    if (!arg) {
      const { sent, found, missing, label } = await fetchReceiptsForMonth();
      return formatReceiptsResult(sent, found, missing, label);
    }

    if (!arg.includes(' ') && matchMonthName(arg) !== -1) {
      const { sent, found, missing, label } = await fetchReceiptsForMonth(arg);
      return formatReceiptsResult(sent, found, missing, label);
    }

    const result = await fetchReceiptForSource(arg);
    return result.found
      ? `🧾 Sent the latest receipt from *${result.sourceName}*.`
      : `🧾 No receipt found for *${result.sourceName}*.`;
  }

  const statusMatch = text.match(/^status(?:\s+(.+))?$/i);
  if (statusMatch) {
    const service = statusMatch[1]?.trim().toLowerCase();

    if (!service) {
      const [gmailR, calendarR, tasksR, maigretR, spiderfootR, zohoResults] = await Promise.all([
        testGmailConnection(),
        testCalendarConnection(),
        testTasksConnection(),
        testMaigretAvailability(),
        testSpiderfootConnection(),
        testZohoConnections(),
      ]);

      const lines = [
        formatCheckLine('Gmail', gmailR),
        formatCheckLine('Calendar', calendarR),
        formatCheckLine('Tasks', tasksR),
        formatCheckLine('Maigret', maigretR),
        formatCheckLine('Spiderfoot', spiderfootR),
        ...formatZohoLines(zohoResults),
      ];

      return `*⚙️ Service Status*\n${lines.join('\n')}`;
    }

    if (service === 'zoho') {
      const results = await testZohoConnections();
      return `*📬 Zoho Connection Status*\n${formatZohoLines(results).join('\n')}`;
    }

    const check = SERVICE_STATUS_CHECKS[service];
    if (!check) {
      const names = ['zoho', ...Object.keys(SERVICE_STATUS_CHECKS)].join(', ');
      return `❌ Unknown service. Try: ${names}`;
    }

    const result = await check.run();
    return formatCheckLine(check.label, result);
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

  if (/^untrack\s+(\*|all)$/i.test(lower)) {
    const flights = listTracked();
    if (!flights.length) return '⚠️ No flights currently being tracked.';
    clearAllTracked();
    return `✅ Stopped tracking all flights (${flights.join(', ')}).`;
  }

  const untrackMatch = lower.match(/^untrack\s+([a-z0-9]+)$/i);
  if (untrackMatch) {
    const removed = untrackFlight(untrackMatch[1]);
    return removed
      ? `✅ Stopped tracking *${untrackMatch[1].toUpperCase()}*.`
      : `⚠️ *${untrackMatch[1].toUpperCase()}* wasn't being tracked.`;
  }

  const rescheduleMatch = body.match(/^(?:re)?schedule\s+([a-z0-9]+)(?:\s+(\d{2}-\d{2}-\d{2}))?\s+(\d{2}:\d{2})$/i);
  if (rescheduleMatch) {
    const callsign = rescheduleMatch[1].toUpperCase();
    const timeStr = rescheduleMatch[3];

    let dateStr;
    if (rescheduleMatch[2]) {
      const [dd, mm, yy] = rescheduleMatch[2].split('-');
      dateStr = `20${yy}-${mm}-${dd}`;
    } else {
      const existing = getScheduled()[callsign];
      if (existing) {
        dateStr = existing.split('T')[0];
      } else {
        const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
        dateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      }
    }

    const departureIso = `${dateStr}T${timeStr}:00`;
    if (isNaN(new Date(departureIso).getTime())) return '❌ Invalid date. Use: reschedule <callsign> DD-MM-YY HH:MM';
    const [year, month, day] = dateStr.split('-');
    const displayDate = `${day}-${month}-${year.slice(-2)}`;
    const result = rescheduleFlight(callsign, departureIso);
    return result
      ? `✅ *${callsign}* rescheduled for departure ${displayDate} at ${timeStr}`
      : `❌ Failed to reschedule *${callsign}*.`;
  }

  if (/^unschedule\s+(\*|all)$/i.test(lower)) {
    const scheduled = Object.keys(getScheduled());
    if (!scheduled.length) return '⚠️ No flights currently scheduled.';
    clearAllScheduled();
    return `✅ Removed all scheduled flights (${scheduled.join(', ')}).`;
  }

  const unscheduleMatch = lower.match(/^unschedule\s+([a-z0-9]+)$/i);
  if (unscheduleMatch) {
    const removed = unscheduleFlight(unscheduleMatch[1]);
    return removed
      ? `✅ Removed *${unscheduleMatch[1].toUpperCase()}* from schedule.`
      : `⚠️ *${unscheduleMatch[1].toUpperCase()}* wasn't scheduled.`;
  }

  if (/^tracked$/i.test(lower)) {
    const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
    const active = listTracked();
    const scheduled = getScheduled();
    const lines = [];

    if (active.length) {
      lines.push('*🟢 Actively tracking:*');
      lines.push(...active.map(f => `• ${f}`));
    }

    const scheduledEntries = Object.entries(scheduled);
    if (scheduledEntries.length) {
      lines.push('');
      lines.push('*⏳ Scheduled to track:*');
      for (const [callsign, departureIso] of scheduledEntries) {
        const dep = new Date(departureIso);
        const trackingStart = new Date(dep.getTime() - 4 * 60 * 60 * 1000);
        const fmt = d => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
        lines.push(`• *${callsign}* — tracking starts ${fmt(trackingStart)} (departure ${fmt(dep)})`);
      }
    }

    return lines.length
      ? lines.join('\n')
      : '✈️ No flights tracked or scheduled.';
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
    const scanEnabled = isScanEnabled();
    const scanTime = getScanTime();
    return `*⚙️ Current Settings*

*Daily Brief*
• Time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${tz})

*Emails*
• Check interval: every ${emailInterval} min

*Flights*
• Poll interval: every ${flightInterval} min

*Auto Scan*
• Status: ${scanEnabled ? 'Enabled' : 'Disabled'}
• Time: ${scanTime} (${tz})

*OSINT*
• Poll interval: every ${getOsintPollMinutes()} min`;
  }

  const HELP_CATEGORIES = {
    brief: {
      emoji: '📅',
      label: 'Daily Brief',
      text: `*📅 Daily Brief*
• \`brief status\` — show current brief time & timezone
• \`set brief time HH:MM\` — set daily brief time (24h)
• \`set brief timezone <tz>\` — set timezone (e.g. Europe/London)
• \`send briefing\` — send the daily brief right now`,
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
• \`unschedule <callsign>\` — remove a flight from the tracking schedule
• \`reschedule <callsign> HH:MM\` — update departure time (keep existing date)
• \`reschedule <callsign> DD-MM-YY HH:MM\` — update departure date and time
• \`tracked\` — list all currently tracked flights
• \`flight interval\` — show current poll interval
• \`set flight interval 5m\` — set poll interval (e.g. 2m, 10m)`,
    },
    emails: {
      emoji: '📧',
      label: 'Emails',
      text: `*📧 Emails*
• \`fetch emails\` — check Gmail now for ticket PDFs and flight bookings
• \`receipts\` — send the latest receipt from each enabled source this month
• \`receipts <month>\` — send receipts for a specific month (e.g. \`receipts july\`)
• \`receipts <source>\` — send the latest receipt from one source (e.g. \`receipts google cloud\`)
• \`receipts sources\` — list adjustable receipt sources
• \`receipts sources add/remove <name>\` — manage the source list
• \`receipts sources enable/disable <name>\` — toggle a source on/off
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
• \`restart\` — restart the bot via pm2
• \`git <subcommand> [args]\` — run any git command and get the output`,
    },
    osint: {
      emoji: '🔍',
      label: 'OSINT',
      text: osintHelp(),
    },
    other: {
      emoji: '⚙️',
      label: 'Other',
      text: `*⚙️ Other*
• \`settings\` — show all current settings
• \`status\` — check connectivity for every service in one message
• \`status <service>\` — check one service (gmail, calendar, tasks, zoho, maigret, spiderfoot)
• \`cointoss\` — flip a coin (heads or tails)
• \`random <max>\` — random number from 1 to max (e.g. \`random 6\`)
• \`random <min> <max>\` — random number in range (e.g. \`random 10 100\`)
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
      const { stdout: pullOut } = await execAsync('git pull');
      const summary = pullOut.trim().split('\n').pop();
      // Install any new/updated packages before restarting
      await execAsync('npm install --production');
      setTimeout(() => execAsync(`pm2 restart ${appName}`).catch(console.error), 500);
      return `✅ ${summary}\n📦 Dependencies updated\n🔄 Restarting bot...`;
    } catch (err) {
      return `❌ refresh failed: ${err.message}`;
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

  if (/^osint/i.test(lower)) {
    return await handleOsintCommand(text);
  }

  const qrMatch = text.match(/^qr\s+(.+)$/is);
  if (qrMatch) {
    const qrText = qrMatch[1].trim();
    const chatId = process.env.MY_CHAT_ID;
    try {
      const buf = await QRCode.toBuffer(qrText, { type: 'png', width: 512, margin: 2 });
      await sendFile(chatId, buf.toString('base64'), 'qr.png', 'image/png', qrText);
      return null;
    } catch (err) {
      return `❌ QR generation failed: ${err.message}`;
    }
  }

  if (/^cointoss$/i.test(lower)) {
    return Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
  }

  const randomMatch = lower.match(/^random\s+(-?\d+)(?:\s+(-?\d+))?$/i);
  if (randomMatch) {
    const a = parseInt(randomMatch[1], 10);
    const b = randomMatch[2] !== undefined ? parseInt(randomMatch[2], 10) : null;
    const min = b === null ? 1 : Math.min(a, b);
    const max = b === null ? a : Math.max(a, b);
    const result = Math.floor(Math.random() * (max - min + 1)) + min;
    return `🎲 ${result}`;
  }

  // git <subcommand> [args...]
  if (/^git\s+\S/i.test(lower)) {
    const raw = text.trim().slice(4).trim();
    // Shell-word split (handles quoted strings)
    const args = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    // Strip surrounding quotes from each arg
    const cleanArgs = args.map(a => a.replace(/^(["'])(.*)\1$/, '$2'));
    try {
      const { stdout, stderr } = await execFileAsync('git', cleanArgs, {
        cwd: process.cwd(),
        timeout: 20000,
      });
      const out = (stdout + stderr).trim();
      const display = out.length > 3800 ? out.slice(0, 3800) + '\n…(truncated)' : out;
      return display ? `\`\`\`\n${display}\n\`\`\`` : '✅ (no output)';
    } catch (err) {
      const out = ((err.stdout || '') + (err.stderr || '')).trim();
      return `❌ git error:\n\`\`\`\n${out || err.message}\n\`\`\``;
    }
  }

  return false;
}
