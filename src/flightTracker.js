import { getSetting, setSetting } from './settings.js';
import { sendMessage } from './messaging.js';
import { fetchAviationStackFlight, fetchAdsbFlight, buildMessage } from './flights.js';

const DEFAULT_POLL_MINUTES = 2;

let pollTimer = null;

export function getFlightPollMinutes() {
  return parseInt(getSetting('flightPollMinutes', 'FLIGHT_POLL_MINUTES', DEFAULT_POLL_MINUTES), 10);
}

export function setFlightPollInterval(minutes) {
  setSetting('flightPollMinutes', minutes);
  startFlightTracker();
}

function getTracked() {
  return getSetting('trackedFlights', null, {});
}

function saveTracked(tracked) {
  setSetting('trackedFlights', tracked);
}

export function trackFlight(callsign) {
  const tracked = getTracked();
  const key = callsign.toUpperCase();
  if (tracked[key]) return false;
  tracked[key] = { snapshot: null };
  saveTracked(tracked);
  return true;
}

export function untrackFlight(callsign) {
  const tracked = getTracked();
  const key = callsign.toUpperCase();
  if (!tracked[key]) return false;
  delete tracked[key];
  saveTracked(tracked);
  return true;
}

export function listTracked() {
  return Object.keys(getTracked());
}

function snapshot(flightData, ac) {
  if (!flightData && !ac) return null;
  return {
    status: flightData?.flight_status ?? null,
    depDelay: flightData?.departure?.delay ?? null,
    arrDelay: flightData?.arrival?.delay ?? null,
    depGate: flightData?.departure?.gate ?? null,
    arrGate: flightData?.arrival?.gate ?? null,
    depTerminal: flightData?.departure?.terminal ?? null,
    arrTerminal: flightData?.arrival?.terminal ?? null,
    depEstimated: flightData?.departure?.estimated ?? null,
    arrEstimated: flightData?.arrival?.estimated ?? null,
    altitude: ac?.alt_baro ?? null,
  };
}

function diff(prev, curr) {
  if (!prev || !curr) return null;
  const changes = [];

  const statusLabels = {
    scheduled: '🕐 Scheduled', active: '🟢 In flight',
    landed: '🏁 Landed', cancelled: '🚫 Cancelled',
    diverted: '↩️ Diverted', incident: '⚠️ Incident',
  };

  if (prev.status !== curr.status) {
    const from = statusLabels[prev.status] ?? prev.status;
    const to = statusLabels[curr.status] ?? curr.status;
    changes.push(`*Status:* ${from} → ${to}`);
  }

  if (prev.depDelay !== curr.depDelay && curr.depDelay != null) {
    changes.push(`*Departure delay:* ${curr.depDelay} min`);
  }
  if (prev.arrDelay !== curr.arrDelay && curr.arrDelay != null) {
    changes.push(`*Arrival delay:* ${curr.arrDelay} min`);
  }

  if (prev.depGate !== curr.depGate && curr.depGate != null) {
    changes.push(`*Departure gate:* ${prev.depGate ?? '?'} → ${curr.depGate}`);
  }
  if (prev.arrGate !== curr.arrGate && curr.arrGate != null) {
    changes.push(`*Arrival gate:* ${prev.arrGate ?? '?'} → ${curr.arrGate}`);
  }

  if (prev.depTerminal !== curr.depTerminal && curr.depTerminal != null) {
    changes.push(`*Departure terminal:* ${prev.depTerminal ?? '?'} → ${curr.depTerminal}`);
  }
  if (prev.arrTerminal !== curr.arrTerminal && curr.arrTerminal != null) {
    changes.push(`*Arrival terminal:* ${prev.arrTerminal ?? '?'} → ${curr.arrTerminal}`);
  }

  const timeStr = iso => iso?.match(/T(\d{2}:\d{2})/)?.[1] ?? null;
  if (prev.depEstimated !== curr.depEstimated && curr.depEstimated != null) {
    changes.push(`*Estimated departure:* ${timeStr(curr.depEstimated)}`);
  }
  if (prev.arrEstimated !== curr.arrEstimated && curr.arrEstimated != null) {
    changes.push(`*Estimated arrival:* ${timeStr(curr.arrEstimated)}`);
  }

  return changes.length ? changes : null;
}

async function sendStartedTrackingMessage(callsign) {
  const [flightData, ac] = await Promise.all([
    fetchAviationStackFlight(callsign),
    fetchAdsbFlight(callsign),
  ]);
  const details = buildMessage(flightData, ac, callsign);
  await sendMessage(process.env.MY_CHAT_ID, `🛫 *Started Tracking*\n\n${details}`);
}

async function pollAll() {
  const tracked = getTracked();
  const callsigns = Object.keys(tracked);
  if (!callsigns.length) return;

  console.log(`✈️ Flight tracker: polling ${callsigns.length} flight(s)`);

  for (const callsign of callsigns) {
    try {
      const [flightData, ac] = await Promise.all([
        fetchAviationStackFlight(callsign),
        fetchAdsbFlight(callsign),
      ]);

      const curr = snapshot(flightData, ac);
      const prev = tracked[callsign].snapshot;

      if (!curr) {
        console.log(`   ↳ ${callsign}: no data`);
        continue;
      }

      if (prev) {
        const changes = diff(prev, curr);
        if (changes) {
          const details = buildMessage(flightData, ac, callsign);
          const msg = `✈️ *Flight Update — ${callsign}*\n\n*What changed:*\n${changes.join('\n')}\n\n*Current status:*\n${details}`;
          await sendMessage(process.env.MY_CHAT_ID, msg);
          console.log(`   ↳ ${callsign}: sent update (${changes.length} change(s))`);
        } else {
          console.log(`   ↳ ${callsign}: no changes`);
        }
      } else {
        console.log(`   ↳ ${callsign}: first snapshot taken`);
        await sendStartedTrackingMessage(callsign);
      }

      tracked[callsign].snapshot = curr;

      // Auto-untrack once airborne or landed
      if (curr.status === 'active') {
        console.log(`   ↳ ${callsign}: airborne — removing from tracker`);
        delete tracked[callsign];
        await sendMessage(process.env.MY_CHAT_ID, `✈️ *${callsign}* is now airborne. Tracking stopped.`);
      } else if (curr.status === 'landed') {
        console.log(`   ↳ ${callsign}: landed — removing from tracker`);
        delete tracked[callsign];
        await sendMessage(process.env.MY_CHAT_ID, `✈️ *${callsign}* has landed. Tracking stopped.`);
      }
    } catch (err) {
      console.error(`❌ Flight tracker error for ${callsign}:`, err.message);
    }
  }

  saveTracked(tracked);
}

function getScheduled() {
  return getSetting('scheduledFlightTrackings', null, {});
}

function saveScheduled(scheduled) {
  setSetting('scheduledFlightTrackings', scheduled);
}

export function scheduleFlightTracking(callsign, departureIso) {
  const key = callsign.toUpperCase();
  const departureMs = new Date(departureIso).getTime();
  if (isNaN(departureMs)) {
    console.error(`✈️ scheduleFlightTracking: invalid date "${departureIso}" for ${key}`);
    return false;
  }

  const scheduled = getScheduled();
  if (scheduled[key]) {
    console.log(`✈️ ${key} already has a scheduled tracking`);
    return false;
  }

  scheduled[key] = departureIso;
  saveScheduled(scheduled);

  armTrackingTimer(key, departureMs);
  return true;
}

function armTrackingTimer(callsign, departureMs) {
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const startMs = departureMs - FOUR_HOURS_MS;
  const delay = startMs - Date.now();

  if (delay <= 0) {
    // Already within 4 hours of departure — start tracking immediately
    console.log(`✈️ ${callsign}: departure is within 4 hours — tracking now`);
    trackFlight(callsign);
    const scheduled = getScheduled();
    delete scheduled[callsign];
    saveScheduled(scheduled);
    sendStartedTrackingMessage(callsign).catch(err => console.error(`❌ Failed to send started tracking message for ${callsign}:`, err.message));
    return;
  }

  const hours = (delay / 3600000).toFixed(1);
  console.log(`✈️ ${callsign}: will start tracking in ${hours}h (4h before departure)`);

  setTimeout(async () => {
    trackFlight(callsign);
    const scheduled = getScheduled();
    delete scheduled[callsign];
    saveScheduled(scheduled);
    await sendStartedTrackingMessage(callsign);
  }, delay);
}

export function restoreScheduledTrackings() {
  const scheduled = getScheduled();
  const entries = Object.entries(scheduled);
  if (!entries.length) return;

  console.log(`✈️ Restoring ${entries.length} scheduled flight tracking(s)`);
  for (const [callsign, departureIso] of entries) {
    const departureMs = new Date(departureIso).getTime();
    if (isNaN(departureMs) || departureMs < Date.now()) {
      console.log(`   ↳ ${callsign}: departure passed — removing`);
      delete scheduled[callsign];
      continue;
    }
    armTrackingTimer(callsign, departureMs);
  }
  saveScheduled(scheduled);
}

export function startFlightTracker() {
  if (pollTimer) clearInterval(pollTimer);
  const minutes = getFlightPollMinutes();
  console.log(`✈️ Flight tracker started (polling every ${minutes} min)`);
  pollTimer = setInterval(() => {
    pollAll().catch(err => console.error('❌ Flight tracker poll error:', err.message));
  }, minutes * 60 * 1000);
}
