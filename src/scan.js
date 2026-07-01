import { getSetting, setSetting } from './settings.js';
import { getUpcomingEvents } from './calendar.js';
import { checkCalendarForFlights } from './flightTracker.js';
import { sendMessage } from './messaging.js';
import { fetchTicketEmails } from './gmail.js';

const DEFAULT_TIME = '00:00';

let scanTimeout = null;

export function getScanTime() {
  return getSetting('scanTime', 'SCAN_TIME', DEFAULT_TIME);
}

export function setScanTime(hhmm) {
  setSetting('scanTime', hhmm);
  scheduleAutoScan();
}

export async function runScan() {
  console.log('🔍 Scan running...');

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
  const actions = [];

  try {
    const events = await getUpcomingEvents(tz, 2);
    const found = checkCalendarForFlights(events);
    actions.push(...found);
  } catch (err) {
    console.error('❌ Scan: calendar flight check failed:', err.message);
    actions.push(`❌ Calendar check failed: ${err.message}`);
  }

  try {
    const emailResults = await fetchTicketEmails(null, true);
    actions.push(...emailResults);
  } catch (err) {
    console.error('❌ Scan: email scan failed:', err.message);
    actions.push(`❌ Email scan failed: ${err.message}`);
  }

  const summary = actions.length
    ? `🔍 *Scan complete:*\n${actions.map(a => `• ${a}`).join('\n')}`
    : '🔍 Scan complete — nothing new found.';

  console.log(summary.replace(/\*/g, ''));
  await sendMessage(process.env.MY_CHAT_ID, summary);
}

export function setScanEnabled(enabled) {
  setSetting('scanEnabled', enabled);
  if (enabled) {
    scheduleAutoScan();
  } else {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = null;
    console.log('🔍 Automatic scan disabled');
  }
}

export function isScanEnabled() {
  const val = getSetting('scanEnabled', 'SCAN_ENABLED', 'true');
  return String(val) !== 'false';
}

export function scheduleAutoScan() {
  if (scanTimeout) clearTimeout(scanTimeout);

  if (!isScanEnabled()) {
    console.log('🔍 Automatic scan is disabled — skipping schedule');
    return;
  }

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
  const [targetHour, targetMinute] = getScanTime().split(':').map(Number);

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
  console.log(`🔍 Auto scan scheduled in ${minutesUntil} min (${getScanTime()} ${tz})`);

  scanTimeout = setTimeout(async () => {
    await runScan();
    scheduleAutoScan();
  }, msUntilNext);
}
