import { getSetting, setSetting } from './settings.js';
import { getUpcomingEvents } from './calendar.js';
import { checkCalendarForFlights } from './flightTracker.js';

const DEFAULT_TIME = '00:00';

let nightlyTimeout = null;

export function getNightlyTime() {
  return getSetting('nightlyTime', 'NIGHTLY_TIME', DEFAULT_TIME);
}

export function setNightlyTime(hhmm) {
  setSetting('nightlyTime', hhmm);
  scheduleNightlyChecks();
}

export async function runNightlyChecks() {
  console.log('🌙 Nightly checks running...');

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');

  try {
    const events = await getUpcomingEvents(tz, 2);
    const found = checkCalendarForFlights(events);
    console.log(`✈️ Nightly: scheduled tracking for ${found} new flight(s) from calendar`);
  } catch (err) {
    console.error('❌ Nightly: calendar flight check failed:', err.message);
  }
}

export function setNightlyEnabled(enabled) {
  setSetting('nightlyEnabled', enabled);
  if (enabled) {
    scheduleNightlyChecks();
  } else {
    if (nightlyTimeout) clearTimeout(nightlyTimeout);
    nightlyTimeout = null;
    console.log('🌙 Nightly checks disabled');
  }
}

export function isNightlyEnabled() {
  const val = getSetting('nightlyEnabled', 'NIGHTLY_ENABLED', 'true');
  return String(val) !== 'false';
}

export function scheduleNightlyChecks() {
  if (nightlyTimeout) clearTimeout(nightlyTimeout);

  if (!isNightlyEnabled()) {
    console.log('🌙 Nightly checks are disabled — skipping schedule');
    return;
  }

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
  const [targetHour, targetMinute] = getNightlyTime().split(':').map(Number);

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
  console.log(`🌙 Nightly checks scheduled in ${minutesUntil} min (${getNightlyTime()} ${tz})`);

  nightlyTimeout = setTimeout(async () => {
    await runNightlyChecks();
    scheduleNightlyChecks();
  }, msUntilNext);
}
