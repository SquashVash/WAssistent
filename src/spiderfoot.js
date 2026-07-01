import axios from 'axios';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://127.0.0.1:5001';

// SpiderFoot scan IDs are alphanumeric strings (length varies by version)
const SCAN_ID_RE = /^[a-z0-9]{8,36}$/i;

const STATUS_EMOJI = {
  RUNNING: '🔄',
  FINISHED: '✅',
  ABORTED: '⛔',
  FAILED: '❌',
  STARTING: '🚀',
  CREATED: '🕐',
};

function sfEmoji(status) {
  return STATUS_EMOJI[status?.toUpperCase()] ?? '❓';
}

// scanlist returns: [id, name, target, created, started, finished, ended_raw, status, riskmatrix]
// scanstatus returns: [name, target, created, started, ended, status, riskmatrix]
// startscan returns: ["SUCCESS", scanId]  (GET request, Accept: application/json)

export async function sfStartScan(target, usecase = 'all') {
  const scanname = `wabotScan_${Date.now()}`;
  const { data } = await axios.get(`${SF_BASE}/startscan`, {
    params: { scanname, scantarget: target, usecase, modulelist: '', typelist: '' },
    headers: { Accept: 'application/json' },
  });
  if (!Array.isArray(data) || data[0] !== 'SUCCESS') {
    throw new Error(Array.isArray(data) ? data[1] : String(data));
  }
  return data[1]; // scan ID
}

export async function sfListScans(limit = 8) {
  const { data } = await axios.get(`${SF_BASE}/scanlist`);
  if (!Array.isArray(data)) return [];
  return data.slice(0, limit);
}

export async function sfScanStatus(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scanstatus`, { params: { id: scanId } });
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data; // [name, target, created, started, ended, status, riskmatrix]
}

export async function sfScanSummary(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scansummary`, { params: { id: scanId, by: 'type' } });
  return Array.isArray(data) ? data : [];
}

export async function sfStopScan(scanId) {
  await axios.get(`${SF_BASE}/stopscan`, { params: { id: scanId } });
}

export async function sfDeleteScan(scanId) {
  await axios.get(`${SF_BASE}/scandelete`, { params: { id: scanId } });
}

// scanlist row: [id, name, target, created, started, finished, ended_raw, status, riskmatrix]
function formatScanLine(s) {
  const id = s[0];
  const target = s[2];
  const status = s[7];
  return `• \`${id}\` ${sfEmoji(status)} *${target}* — ${status}`;
}

function formatSummaryTop(rows, max = 15) {
  if (!rows.length) return 'No findings yet.';
  // rows: [type_code, type_label, count, lastseen, fp_status, ...]
  const sorted = [...rows].sort((a, b) => b[2] - a[2]);
  const top = sorted.slice(0, max);
  const lines = top.map(([, label, count]) => `• ${count}× ${label}`);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more event types`);
  return lines.join('\n');
}

export async function handleSpiderfootCommand(text) {
  // spiderfoot scans
  if (/^spiderfoot scans?$/i.test(text.trim())) {
    try {
      const scans = await sfListScans(8);
      if (!scans.length) return '🕷️ No scans found.';
      return `🕷️ *Recent SpiderFoot Scans*\n\n${scans.map(formatScanLine).join('\n')}`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot status <id>
  const statusMatch = text.trim().match(/^spiderfoot status\s+(\S+)$/i);
  if (statusMatch) {
    const id = statusMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      const s = await sfScanStatus(id);
      // [name, target, created, started, ended, status, riskmatrix]
      const [name, target, created, started, ended, status, risk] = s;
      const riskLine = risk
        ? `• Risk: 🔴 ${risk.HIGH ?? 0} high / 🟠 ${risk.MEDIUM ?? 0} med / 🟡 ${risk.LOW ?? 0} low`
        : '';
      return [
        `🕷️ *Scan Status*`,
        `• ID: \`${id}\``,
        `• Target: *${target}*`,
        `• Status: ${sfEmoji(status)} ${status}`,
        `• Started: ${started || '—'}`,
        `• Ended: ${ended || '—'}`,
        riskLine,
      ].filter(Boolean).join('\n');
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot results <id>
  const resultsMatch = text.trim().match(/^spiderfoot results?\s+(\S+)$/i);
  if (resultsMatch) {
    const id = resultsMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      const [statusData, summary] = await Promise.all([
        sfScanStatus(id),
        sfScanSummary(id),
      ]);
      const [, target, , , , scanStatus] = statusData;
      const total = summary.reduce((acc, r) => acc + (r[2] || 0), 0);
      return `🕷️ *Scan Results — ${target}*\nStatus: ${sfEmoji(scanStatus)} ${scanStatus} | Total events: ${total}\n\n${formatSummaryTop(summary)}`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot stop <id>
  const stopMatch = text.trim().match(/^spiderfoot stop\s+(\S+)$/i);
  if (stopMatch) {
    const id = stopMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      await sfStopScan(id);
      return `⛔ Scan \`${id}\` stop requested.`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot delete <id>
  const deleteMatch = text.trim().match(/^spiderfoot delete\s+(\S+)$/i);
  if (deleteMatch) {
    const id = deleteMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      await sfDeleteScan(id);
      return `🗑️ Scan \`${id}\` deleted.`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot <target>  — start a scan
  const scanMatch = text.trim().match(/^spiderfoot\s+(\S+)$/i);
  if (scanMatch) {
    const target = scanMatch[1];
    try {
      const scanId = await sfStartScan(target);
      return `🕷️ Scan started!\n• Target: *${target}*\n• ID: \`${scanId}\`\n\nCheck progress: \`spiderfoot status ${scanId}\`\nView results: \`spiderfoot results ${scanId}\``;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  return spiderfootHelp();
}

export function spiderfootHelp() {
  return `*🕷️ SpiderFoot OSINT*
• \`spiderfoot <target>\` — start a scan (domain, IP, email, username, etc.)
• \`spiderfoot scans\` — list recent scans
• \`spiderfoot status <id>\` — check scan progress
• \`spiderfoot results <id>\` — view top findings
• \`spiderfoot stop <id>\` — abort a running scan
• \`spiderfoot delete <id>\` — delete a scan`;
}
