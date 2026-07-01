import axios from 'axios';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://127.0.0.1:5001';

const SCAN_ID_RE = /^[a-z0-9]{8,36}$/i;

// Noisy types whose raw values don't add readable signal
const SKIP_TYPES = new Set(['RAW_RIR_DATA', 'RAW_FILE_META_DATA', 'BASE64_DATA', 'SIMILARDOMAIN']);

// scaneventresults row layout (after webui remapping):
// [0]  lastseen (formatted)
// [1]  event_data (html-escaped)
// [2]  source_data (html-escaped)
// [3]  module
// [4]  confidence   ← NOT the type; was row[5] in SQL
// [5]  visibility
// [6]  risk
// [7]  hash
// [8]  row[13]
// [9]  row[14]
// [10] type code    ← row[4] in SQL, moved to end by webui

function htmlUnescape(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanValue(raw) {
  const s = htmlUnescape(String(raw || '').trim());
  // Extract URL from SpiderFoot's <SFURL>url</SFURL> wrapper
  const sfurl = s.match(/<SFURL>([\s\S]*?)<\/SFURL>/);
  if (sfurl) return sfurl[1].trim();
  return s;
}

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
// scansummary rows: [type_code, type_descr, lastseen, total_count, unique_count, scan_status]
// scaneventresults rows: [lastseen, event_data, source_data, module, event_type, fp_status, ...]
// startscan returns: ["SUCCESS", scanId]  (GET, Accept: application/json)

// SpiderFoot requires usernames and human names to be wrapped in double quotes.
// targetTypeFromString() patterns (in priority order):
//   IP          ^[0-9]{1,3}(\.[0-9]{1,3}){3}$
//   CIDR        ^[0-9]{1,3}(\.[0-9]{1,3}){3}/\d+$
//   email       ^.*@.*$
//   phone       ^\+[0-9]+$
//   human name  ^".+\s+.+"$   (quoted, contains space)
//   username    ^".+"$         (quoted, no space)
//   ASN         ^[0-9]+$
//   domain      ([a-z0-9][-a-z0-9]*[a-z0-9])\.
function prepareTarget(raw) {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t; // already quoted
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}(\/\d+)?$/.test(t)) return t; // IP / CIDR
  if (/^.*@.*$/.test(t)) return t;                                   // email
  if (/^\+[0-9]+$/.test(t)) return t;                               // phone
  if (/^[0-9]+$/.test(t)) return t;                                  // ASN
  if (/([a-z0-9][-a-z0-9]*[a-z0-9])\.[a-z]/i.test(t)) return t;   // domain
  return `"${t}"`;  // username or human name
}

export async function sfStartScan(target, usecase = 'all') {
  const scantarget = prepareTarget(target);
  const scanname = `wabotScan_${Date.now()}`;
  const { data } = await axios.get(`${SF_BASE}/startscan`, {
    params: { scanname, scantarget, usecase, modulelist: '', typelist: '' },
    headers: { Accept: 'application/json' },
  });
  if (!Array.isArray(data) || data[0] !== 'SUCCESS') {
    throw new Error(Array.isArray(data) ? data[1] : String(data));
  }
  return data[1];
}

export async function sfListScans(limit = 8) {
  const { data } = await axios.get(`${SF_BASE}/scanlist`);
  if (!Array.isArray(data)) return [];
  return data.slice(0, limit);
}

export async function sfScanStatus(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scanstatus`, { params: { id: scanId } });
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data;
}

export async function sfScanSummary(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scansummary`, { params: { id: scanId, by: 'type' } });
  return Array.isArray(data) ? data : [];
}

export async function sfScanResults(scanId) {
  // Don't send filterfp — CherryPy converts any non-empty string to True,
  // so passing filterfp='false' would silently drop all results.
  const { data } = await axios.get(`${SF_BASE}/scaneventresults`, {
    params: { id: scanId },
  });
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
  return `• \`${s[0]}\` ${sfEmoji(s[7])} *${s[2]}* — ${s[7]}`;
}

function formatSummaryTop(rows, max = 15) {
  if (!rows.length) return 'No findings yet.';
  const sorted = [...rows].sort((a, b) => b[3] - a[3]);
  const top = sorted.slice(0, max);
  const lines = top.map((r) => `• ${r[3]}× ${r[1]}`);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more event types`);
  return lines.join('\n');
}

function buildDataGroups(rows, typeLabels) {
  const groups = new Map();
  for (const row of rows) {
    const typeCode = row[10]; // type is at index 10 after webui field remapping
    if (!typeCode || typeCode === 'ROOT' || SKIP_TYPES.has(typeCode)) continue;
    const value = cleanValue(row[1]);
    if (!value) continue;
    const label = typeLabels[typeCode] || typeCode;
    if (!groups.has(label)) groups.set(label, new Set());
    groups.get(label).add(value.length > 200 ? value.slice(0, 200) + '…' : value);
  }
  return groups;
}

function renderDataGroups(groups, maxPerType = 15) {
  if (!groups.size) return 'No data found.';
  const sections = [];
  for (const [label, values] of groups) {
    const vals = [...values];
    const lines = [`*${label}*`, ...vals.slice(0, maxPerType).map(v => `• ${v}`)];
    if (vals.length > maxPerType) lines.push(`  …and ${vals.length - maxPerType} more`);
    sections.push(lines.join('\n'));
  }
  const text = sections.join('\n\n');
  // WhatsApp hard limit ~4096 chars
  return text.length > 3800 ? text.slice(0, 3800) + '\n\n…_(truncated — use SpiderFoot UI for full report)_' : text;
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

  // spiderfoot results <id>  — summary counts by event type
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
      const total = summary.reduce((acc, r) => acc + (r[3] || 0), 0);
      return `🕷️ *Scan Results — ${target}*\nStatus: ${sfEmoji(scanStatus)} ${scanStatus} | Total events: ${total}\n\n${formatSummaryTop(summary)}\n\nSend \`spiderfoot data ${id}\` to see the actual values.`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot data <id>  — actual values grouped by type
  const dataMatch = text.trim().match(/^spiderfoot data\s+(\S+)$/i);
  if (dataMatch) {
    const id = dataMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      const [summary, rows] = await Promise.all([
        sfScanSummary(id),
        sfScanResults(id),
      ]);
      if (!rows.length) return '🕷️ No data yet — scan may still be running.';
      const typeLabels = Object.fromEntries(summary.map(r => [r[0], r[1]]));
      const groups = buildDataGroups(rows, typeLabels);
      return `🕷️ *Scan Data*\n\n${renderDataGroups(groups)}`;
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

  // spiderfoot <target>  — start a scan (catch-all, must stay last)
  // Accepts single words (username/domain/IP/email) and multi-word (human names)
  const scanMatch = text.trim().match(/^spiderfoot\s+(.+)$/i);
  if (scanMatch) {
    const target = scanMatch[1].trim();
    try {
      const scanId = await sfStartScan(target);
      return `🕷️ Scan started!\n• Target: *${target}*\n• ID: \`${scanId}\`\n\nCheck progress: \`spiderfoot status ${scanId}\`\nView results: \`spiderfoot results ${scanId}\`\nSee actual data: \`spiderfoot data ${scanId}\``;
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
• \`spiderfoot results <id>\` — counts by event type
• \`spiderfoot data <id>\` — actual found values (accounts, emails, links…)
• \`spiderfoot stop <id>\` — abort a running scan
• \`spiderfoot delete <id>\` — delete a scan`;
}
