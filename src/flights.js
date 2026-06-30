import axios from 'axios';

const ADSB_BASE = 'https://api.adsb.lol/v2';

function formatAltitude(altBaro) {
  if (altBaro === 'ground' || altBaro === undefined || altBaro === null) return 'On ground';
  return `${Number(altBaro).toLocaleString()} ft`;
}

function formatSpeed(gs) {
  if (gs === undefined || gs === null) return 'N/A';
  return `${Math.round(gs)} kts`;
}

function formatHeading(track) {
  if (track === undefined || track === null) return 'N/A';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(track / 45) % 8;
  return `${Math.round(track)}° ${dirs[idx]}`;
}

function buildFlightMessage(ac, callsign) {
  const onGround = ac.alt_baro === 'ground';
  const flightId = (ac.flight || callsign).trim();
  const aircraftParts = [ac.t, ac.desc].filter(Boolean);
  const aircraft = aircraftParts.length ? aircraftParts.join(' — ') : 'Unknown type';
  const registration = ac.r || 'N/A';
  const operator = ac.ownOp || '';

  const lines = [];
  lines.push(`✈️ *Flight ${flightId}*${operator ? ` (${operator})` : ''}`);
  lines.push(`🛩️ ${aircraft} | Reg: ${registration}`);
  lines.push('');

  if (ac.dep || ac.dst) {
    lines.push(`📍 Route: ${ac.dep || '?'} → ${ac.dst || '?'}`);
  }

  if (onGround) {
    lines.push(`🛑 Status: On the ground`);
  } else {
    lines.push(`🟢 Status: Airborne`);
    lines.push(`📊 Altitude: ${formatAltitude(ac.alt_baro)}`);
    lines.push(`💨 Speed: ${formatSpeed(ac.gs)}`);
    lines.push(`🧭 Heading: ${formatHeading(ac.track)}`);
  }

  if (ac.squawk && ac.squawk !== '0000' && ac.squawk !== '2000') {
    lines.push(`📻 Squawk: ${ac.squawk}`);
  }

  const seenSec = Math.round(ac.seen ?? ac.seen_pos ?? 0);
  lines.push('');
  lines.push(`⏱️ Last updated: ${seenSec}s ago`);

  return lines.join('\n');
}

export async function lookupFlight(callsign) {
  const clean = callsign.trim().toUpperCase().replace(/\s+/g, '');

  let data;
  try {
    const res = await axios.get(`${ADSB_BASE}/callsign/${clean}`, { timeout: 10000 });
    data = res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      return `✈️ No active aircraft found for *${clean}*.\n\nThe flight may have already landed or not yet departed. ADS-B only tracks aircraft currently broadcasting.`;
    }
    console.error(`❌ Flight lookup failed for ${clean}:`, err.message);
    return `❌ Could not reach flight data service. Please try again.`;
  }

  if (!data.ac || data.ac.length === 0) {
    return `✈️ No active aircraft found for *${clean}*.\n\nThe flight may have already landed or not yet departed. ADS-B only tracks aircraft currently broadcasting.`;
  }

  return buildFlightMessage(data.ac[0], clean);
}
