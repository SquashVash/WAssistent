import axios from 'axios';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://127.0.0.1:5001';

// SpiderFoot scan ID format: 8 alphanumeric chars
const SCAN_ID_RE = /^[A-Z0-9]{8}$/i;

const STATUS_EMOJI = {
  RUNNING: '🔄',
  FINISHED: '✅',
  ABORTED: '⛔',
  FAILED: '❌',
  STARTING: '🚀',
};

function sfEmoji(status) {
  return STATUS_EMOJI[status?.toUpperCase()] ?? '❓';
}

function fmtDate(ts) {
  if (!ts || ts === '0') return '—';
  // SpiderFoot returns timestamps as seconds or ISO strings
  const d = isNaN(ts) ? new Date(ts) : new Date(Number(ts) * 1000);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export async function sfStartScan(target, usecase = 'all') {
  const scanname = `wabotScan_${Date.now()}`;
  const params = new URLSearchParams({
    scanname,
    scantarget: target,
    usecase,
    typedefs: JSON.stringify([{ c: 'ALL' }]),
  });
  const { data } = await axios.post(`${SF_BASE}/api/v1/scanstart`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  // data is ["SUCCESS", "<scanId>"] or ["ERROR", "message"]
  if (!Array.isArray(data)) throw new Error('Unexpected response from SpiderFoot');
  if (data[0] !== 'SUCCESS') throw new Error(data[1] || 'SpiderFoot scan failed to start');
  return data[1]; // scan ID
}

export async function sfListScans(limit = 5) {
  const { data } = await axios.get(`${SF_BASE}/api/v1/scanlist`);
  // Returns array of [id, name, target, created, started, ended, status]
  if (!Array.isArray(data)) return [];
  return data.slice(0, limit);
}

export async function sfScanStatus(scanId) {
  const { data } = await axios.get(`${SF_BASE}/api/v1/scanstatus`, { params: { id: scanId } });
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data; // [id, name, target, created, started, ended, status]
}

export async function sfScanSummary(scanId) {
  const { data } = await axios.get(`${SF_BASE}/api/v1/scansummary`, { params: { id: scanId, by: 'type' } });
  // Returns array of [event_type, count, discovered_by]
  return Array.isArray(data) ? data : [];
}

export async function sfStopScan(scanId) {
  const { data } = await axios.get(`${SF_BASE}/api/v1/stopscan`, { params: { id: scanId } });
  return data;
}

export async function sfDeleteScan(scanId) {
  const { data } = await axios.get(`${SF_BASE}/api/v1/scandelete`, { params: { id: scanId } });
  return data;
}

// Format scan list entry: [id, name, target, created, started, ended, status]
function formatScanLine(s) {
  const [id, , target, , , , status] = s;
  return `• \`${id}\` ${sfEmoji(status)} *${target}* — ${status}`;
}

function formatSummaryTop(rows, max = 15) {
  if (!rows.length) return 'No findings yet.';
  const sorted = [...rows].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, max);
  const lines = top.map(([type, count]) => `• ${count}× ${type}`);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more event types`);
  return lines.join('\n');
}

export async function handleSpiderfootCommand(text) {
  const lower = text.trim().toLowerCase();

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
  const statusMatch = text.trim().match(/^spiderfoot status\s+([A-Z0-9]+)$/i);
  if (statusMatch) {
    if (!SCAN_ID_RE.test(statusMatch[1])) return '❌ Invalid scan ID (8 alphanumeric chars).';
    try {
      const s = await sfScanStatus(statusMatch[1].toUpperCase());
      const [id, name, target, created, started, ended, status] = s;
      return `🕷️ *Scan Status*\n• ID: \`${id}\`\n• Target: *${target}*\n• Status: ${sfEmoji(status)} ${status}\n• Started: ${fmtDate(started)}\n• Ended: ${fmtDate(ended)}`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot results <id>
  const resultsMatch = text.trim().match(/^spiderfoot results?\s+([A-Z0-9]+)$/i);
  if (resultsMatch) {
    if (!SCAN_ID_RE.test(resultsMatch[1])) return '❌ Invalid scan ID (8 alphanumeric chars).';
    try {
      const [status, summary] = await Promise.all([
        sfScanStatus(resultsMatch[1].toUpperCase()),
        sfScanSummary(resultsMatch[1].toUpperCase()),
      ]);
      const [id, , target, , , , scanStatus] = status;
      const total = summary.reduce((acc, r) => acc + r[1], 0);
      return `🕷️ *Scan Results — ${target}*\nStatus: ${sfEmoji(scanStatus)} ${scanStatus} | Total events: ${total}\n\n${formatSummaryTop(summary)}`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot stop <id>
  const stopMatch = text.trim().match(/^spiderfoot stop\s+([A-Z0-9]+)$/i);
  if (stopMatch) {
    if (!SCAN_ID_RE.test(stopMatch[1])) return '❌ Invalid scan ID (8 alphanumeric chars).';
    try {
      await sfStopScan(stopMatch[1].toUpperCase());
      return `⛔ Scan \`${stopMatch[1].toUpperCase()}\` stop requested.`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot delete <id>
  const deleteMatch = text.trim().match(/^spiderfoot delete\s+([A-Z0-9]+)$/i);
  if (deleteMatch) {
    if (!SCAN_ID_RE.test(deleteMatch[1])) return '❌ Invalid scan ID (8 alphanumeric chars).';
    try {
      await sfDeleteScan(deleteMatch[1].toUpperCase());
      return `🗑️ Scan \`${deleteMatch[1].toUpperCase()}\` deleted.`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot <target>  — start a scan
  const scanMatch = text.trim().match(/^spiderfoot\s+(.+)$/i);
  if (scanMatch) {
    const target = scanMatch[1].trim();
    // Basic sanity: reject obviously empty or multi-word targets that don't look like targets
    if (!target || target.includes(' ')) {
      return spiderfootHelp();
    }
    try {
      const scanId = await sfStartScan(target);
      return `🕷️ Scan started!\n• Target: *${target}*\n• ID: \`${scanId}\`\n\nCheck progress: \`spiderfoot status ${scanId}\`\nView results: \`spiderfoot results ${scanId}\``;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  return false;
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
