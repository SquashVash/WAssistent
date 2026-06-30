import axios from 'axios';

const ADSB_BASE = 'https://api.adsb.lol/v2';
const AVIATIONSTACK_BASE = 'http://api.aviationstack.com/v1';

// ─── ADS-B ────────────────────────────────────────────────────────────────────

async function fetchAdsb(callsign) {
  try {
    const res = await axios.get(`${ADSB_BASE}/callsign/${callsign}`, { timeout: 10000 });
    return res.data?.ac?.[0] || null;
  } catch {
    return null;
  }
}

function formatAltitude(altBaro) {
  if (altBaro === 'ground' || altBaro == null) return null;
  return `${Number(altBaro).toLocaleString()} ft`;
}

function formatHeading(track) {
  if (track == null) return null;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${Math.round(track)}° ${dirs[Math.round(track / 45) % 8]}`;
}

// ─── AviationStack ────────────────────────────────────────────────────────────

async function fetchAviationStack(callsign) {
  const key = process.env.AVIATIONSTACK_API_KEY;
  if (!key) return null;

  const params = { access_key: key, limit: 5 };

  const tryFetch = async (filterParam) => {
    const res = await axios.get(`${AVIATIONSTACK_BASE}/flights`, {
      params: { ...params, ...filterParam },
      timeout: 10000,
    });
    // AviationStack signals errors with { success: false, error: {...} }
    if (res.data?.success === false) {
      const err = res.data.error;
      console.error(`❌ AviationStack error [${err?.code}]: ${err?.info}`);
      return null;
    }
    return res.data?.data || null;
  };

  const [iataRes, icaoRes] = await Promise.allSettled([
    tryFetch({ flight_iata: callsign }),
    tryFetch({ flight_icao: callsign }),
  ]);

  if (iataRes.status === 'rejected') {
    console.error('❌ AviationStack IATA fetch failed:', iataRes.reason?.message);
    console.error('   response body:', JSON.stringify(iataRes.reason?.response?.data));
  }
  if (icaoRes.status === 'rejected') {
    console.error('❌ AviationStack ICAO fetch failed:', icaoRes.reason?.message);
    console.error('   response body:', JSON.stringify(icaoRes.reason?.response?.data));
  }

  const iata = iataRes.status === 'fulfilled' ? iataRes.value : null;
  const icao = icaoRes.status === 'fulfilled' ? icaoRes.value : null;
  const flights = (iata?.length ? iata : null) ?? (icao?.length ? icao : null);
  if (!flights?.length) return null;

  // Prefer active/scheduled over landed/cancelled
  const priority = { active: 0, scheduled: 1, landed: 2, cancelled: 3 };
  return flights.sort((a, b) => (priority[a.flight_status] ?? 9) - (priority[b.flight_status] ?? 9))[0];
}

// Extract HH:MM in the airport's own local time (offset is embedded in ISO string)
function timeStr(iso) {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function dateStr(iso) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(m[3])} ${months[parseInt(m[2]) - 1]} ${m[1]}`;
}

function statusLabel(status) {
  switch (status?.toLowerCase()) {
    case 'scheduled': return '🕐 Scheduled';
    case 'active':    return '🟢 In flight';
    case 'landed':    return '🏁 Landed';
    case 'cancelled': return '🚫 Cancelled';
    case 'diverted':  return '↩️ Diverted';
    case 'incident':  return '⚠️ Incident';
    default:          return status || '—';
  }
}

// ─── Message builder ──────────────────────────────────────────────────────────

function buildMessage(flightData, ac, callsign) {
  const lines = [];

  // ── Header ──
  if (flightData) {
    const airline = flightData.airline?.name || '';
    const num = flightData.flight?.iata || callsign;
    lines.push(`✈️ *${num}${airline ? ` — ${airline}` : ''}*`);
    lines.push('');

    const dep = flightData.departure;
    const arr = flightData.arrival;

    // Route & date
    const depLabel = dep?.airport ? `${dep.iata} (${dep.airport})` : (dep?.iata || '?');
    const arrLabel = arr?.airport ? `${arr.iata} (${arr.airport})` : (arr?.iata || '?');
    lines.push(`📍 ${depLabel} → ${arrLabel}`);
    const date = dateStr(dep?.scheduled);
    if (date) lines.push(`📅 ${date}`);
    lines.push('');

    // Status
    lines.push(`*Status:* ${statusLabel(flightData.flight_status)}`);
    lines.push('');

    // Departure
    lines.push(`*Departure — ${dep?.iata || '?'}*`);
    if (dep?.scheduled) lines.push(`  Scheduled:  ${timeStr(dep.scheduled)}`);
    if (dep?.estimated && dep.estimated !== dep.scheduled) lines.push(`  Estimated:  ${timeStr(dep.estimated)}`);
    if (dep?.actual)    lines.push(`  Actual:     ${timeStr(dep.actual)}`);
    if (dep?.delay)     lines.push(`  ⚠️ Delay:   ${dep.delay} min`);
    const depLocation = [dep?.terminal ? `Terminal ${dep.terminal}` : null, dep?.gate ? `Gate ${dep.gate}` : null].filter(Boolean).join(' · ');
    if (depLocation)    lines.push(`  ${depLocation}`);
    lines.push('');

    // Arrival
    lines.push(`*Arrival — ${arr?.iata || '?'}*`);
    if (arr?.scheduled) lines.push(`  Scheduled:  ${timeStr(arr.scheduled)}`);
    if (arr?.estimated && arr.estimated !== arr.scheduled) lines.push(`  Estimated:  ${timeStr(arr.estimated)}`);
    if (arr?.actual)    lines.push(`  Actual:     ${timeStr(arr.actual)}`);
    if (arr?.delay)     lines.push(`  ⚠️ Delay:   ${arr.delay} min`);
    const arrLocation = [arr?.terminal ? `Terminal ${arr.terminal}` : null, arr?.gate ? `Gate ${arr.gate}` : null].filter(Boolean).join(' · ');
    if (arrLocation)    lines.push(`  ${arrLocation}`);
  } else {
    lines.push(`✈️ *${callsign}*`);
    lines.push('');
    if (!process.env.AVIATIONSTACK_API_KEY) {
      lines.push('_(Schedule data unavailable — set AVIATIONSTACK_API_KEY for gate, delay & time info)_');
    } else {
      lines.push('_(No schedule data found for this flight)_');
    }
  }

  // ── Live ADS-B ──
  if (ac) {
    const onGround = ac.alt_baro === 'ground';
    lines.push('');
    lines.push('*Live Position*');

    if (onGround) {
      lines.push('  📍 On the ground');
    } else {
      const parts = [
        formatAltitude(ac.alt_baro),
        ac.gs != null ? `${Math.round(ac.gs)} kts` : null,
        formatHeading(ac.track),
      ].filter(Boolean);
      lines.push(`  📊 ${parts.join(' · ')}`);
    }

    const acInfo = [ac.t, ac.r].filter(Boolean).join(' · ');
    if (acInfo) lines.push(`  🛩️ ${acInfo}`);

    const seenSec = Math.round(ac.seen ?? ac.seen_pos ?? 0);
    lines.push(`  ⏱️ Updated ${seenSec}s ago`);
  }

  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function lookupFlight(callsign) {
  const clean = callsign.trim().toUpperCase().replace(/\s+/g, '');

  const [flightRes, adsbRes] = await Promise.allSettled([
    fetchAviationStack(clean),
    fetchAdsb(clean),
  ]);

  const flightData = flightRes.status === 'fulfilled' ? flightRes.value : null;
  const ac = adsbRes.status === 'fulfilled' ? adsbRes.value : null;

  if (flightRes.status === 'rejected') {
    console.error('❌ AviationStack top-level failure:', flightRes.reason?.message);
  }

  if (!flightData && !ac) {
    return `✈️ No data found for *${clean}*.\n\nCheck the bot logs for AviationStack error details.`;
  }

  return buildMessage(flightData, ac, clean);
}
