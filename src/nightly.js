import { getSetting, setSetting } from './settings.js';
import { getUpcomingEvents } from './calendar.js';
import { checkCalendarForFlights } from './flightTracker.js';

const DEFAULT_HOUR = 0;
const DEFAULT_MINUTE = 0;

let nightlyTimeout = null;

export function getNightlyTime() {
  return {
    hour: parseInt(getSetting('nightlyHour', 'NIGHTLY_HOUR', DEFAULT_HOUR), 10),
    minute: parseInt(getSetting('nightlyMinute', 'NIGHTLY_MINUTE', DEFAULT_MINUTE), 10),
  };
}

export function setNightlyTime(hour, minute) {
  setSetting('nightlyHour', hour);
  setSetting('nightlyMinute', minute);
  scheduleNightlyChecks();
}

async function runNightlyChecks() {
  console.log('🌙 Nightly checks running...');

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');

  try {
    const events = await getUpcomingEvents(tz, 7);
    const found = checkCalendarForFlights(events);
    console.log(`✈️ Nightly: scheduled tracking for ${found} new flight(s) from calendar`);
  } catch (err) {
    console.error('❌ Nightly: calendar flight check failed:', err.message);
  }
}

export function scheduleNightlyChecks() {
  if (nightlyTimeout) clearTimeout(nightlyTimeout);

  const tz = getSetting('briefTimezone', 'DAILY_BRIEF_TIMEZONE', 'UTC');
  const { hour: targetHour, minute: targetMinute } = getNightlyTime();

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
  console.log(`🌙 Nightly checks scheduled in ${minutesUntil} min (${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')} ${tz})`);

  nightlyTimeout = setTimeout(async () => {
    await runNightlyChecks();
    scheduleNightlyChecks();
  }, msUntilNext);
}
