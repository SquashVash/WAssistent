import axios from 'axios';
import PDFDocument from 'pdfkit';
import { sendDocument } from './messaging.js';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://127.0.0.1:5001';

const SCAN_ID_RE = /^[a-z0-9]{8,36}$/i;

const SKIP_TYPES = new Set(['RAW_FILE_META_DATA', 'BASE64_DATA', 'SIMILARDOMAIN']);

const STATUS_EMOJI = {
  RUNNING: '🔄',
  FINISHED: '✅',
  ABORTED: '⛔',
  FAILED: '❌',
  STARTING: '🚀',
  CREATED: '🕐',
};

// Palette
const C = {
  navy:   '#1a1a2e',
  accent: '#e94560',
  silver: '#8888aa',
  bg:     '#f7f9fb',
  rule:   '#e0e4ea',
  text:   '#222222',
  muted:  '#666666',
  white:  '#ffffff',
};

function sfEmoji(status) {
  return STATUS_EMOJI[status?.toUpperCase()] ?? '❓';
}

// scaneventresults row layout (after webui remapping):
// [0]  lastseen   [1] event_data(escaped)   [2] source_data(escaped)
// [3]  module     [4] confidence            [5] visibility
// [6]  risk       [7] hash                  [8] row[13]
// [9]  row[14]    [10] type code  ← moved to end

// scansummary rows: [type_code, type_descr, lastseen, total_count, unique_count, scan_status]
// scanstatus  rows: [name, target, created, started, ended, status, riskmatrix]
// scanlist    rows: [id, name, target, created, started, finished, ended_raw, status, riskmatrix]
// startscan returns: ["SUCCESS", scanId]  (GET, Accept: application/json)

function htmlUnescape(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanValue(raw) {
  const s = htmlUnescape(raw).trim();
  const sfurl = s.match(/<SFURL>([\s\S]*?)<\/SFURL>/);
  if (sfurl) return sfurl[1].trim();
  return s;
}

// SpiderFoot requires usernames/human names to be double-quoted.
// Mirrors targetTypeFromString() priority order.
function prepareTarget(raw) {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t;
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}(\/\d+)?$/.test(t)) return t; // IP / CIDR
  if (/^.*@.*$/.test(t)) return t;                                   // email
  if (/^\+[0-9]+$/.test(t)) return t;                               // phone
  if (/^[0-9]+$/.test(t)) return t;                                  // ASN
  if (/([a-z0-9][-a-z0-9]*[a-z0-9])\.[a-z]/i.test(t)) return t;   // domain
  return `"${t}"`;  // username or human name
}

// ─── API wrappers ────────────────────────────────────────────────

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
  const { data } = await axios.get(`${SF_BASE}/scaneventresults`, { params: { id: scanId } });
  return Array.isArray(data) ? data : [];
}

export async function sfStopScan(scanId) {
  await axios.get(`${SF_BASE}/stopscan`, { params: { id: scanId } });
}

export async function sfDeleteScan(scanId) {
  await axios.get(`${SF_BASE}/scandelete`, { params: { id: scanId } });
}

// ─── Data processing ─────────────────────────────────────────────

function buildDataGroups(rows, typeLabels) {
  const groups = new Map();
  for (const row of rows) {
    const typeCode = row[10];
    if (!typeCode || typeCode === 'ROOT' || SKIP_TYPES.has(typeCode)) continue;
    const value = cleanValue(row[1]);
    if (!value) continue;
    const label = typeLabels[typeCode] || typeCode;
    if (!groups.has(label)) groups.set(label, new Set());
    groups.get(label).add(value.length > 300 ? value.slice(0, 300) + '…' : value);
  }
  return groups;
}

// ─── PDF generation ──────────────────────────────────────────────

async function buildDossierPDF(target, statusArr, summaryRows, dataGroups) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const M  = 50;
    const W  = PW - M * 2;

    const [, , , started, ended, status] = statusArr;
    const total = summaryRows.reduce((a, r) => a + (r[3] || 0), 0);
    const sorted = [...summaryRows].filter(r => r[0] !== 'ROOT').sort((a, b) => b[3] - a[3]);

    function ensureSpace(needed) {
      if (doc.y + needed > PH - 60) doc.addPage();
    }

    // ── Cover banner ──────────────────────────────────
    doc.save().rect(0, 0, PW, 80).fill(C.navy).restore();
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22)
       .text('OSINT Intelligence Dossier', M, 18, { width: W });
    doc.fillColor(C.silver).font('Helvetica').fontSize(9)
       .text('WAssistent  ·  ' + new Date().toLocaleString('en-GB'), M, 52);

    doc.y = 100;

    // ── Scan metadata ─────────────────────────────────
    doc.save().rect(M, doc.y, W, 2).fill(C.accent).restore();
    doc.y += 10;
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(13).text('Scan Overview');
    doc.moveDown(0.4);

    const metaRows = [
      ['Target',        target],
      ['Status',        status || '—'],
      ['Started',       started || '—'],
      ['Completed',     ended   || '—'],
      ['Total Events',  String(total)],
    ];

    for (const [k, v] of metaRows) {
      const ly = doc.y;
      doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(10).text(k, M, ly, { width: 110 });
      doc.fillColor(C.text).font('Helvetica').fontSize(10).text(v, M + 115, ly, { width: W - 115 });
      doc.y = ly + 16;
    }

    doc.moveDown(1.2);

    // ── Summary table ─────────────────────────────────
    doc.save().rect(M, doc.y, W, 2).fill(C.accent).restore();
    doc.y += 10;
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(13).text('Event Type Summary');
    doc.moveDown(0.5);

    // Table header row
    const col1x = M,          col1w = W * 0.62;
    const col2x = M + W*0.64, col2w = W * 0.16;
    const col3x = M + W*0.82, col3w = W * 0.18;

    const thY = doc.y;
    doc.save().rect(M, thY, W, 18).fill(C.navy).restore();
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9);
    doc.text('Event Type', col1x + 4, thY + 5, { width: col1w - 4 });
    doc.text('Total',      col2x,      thY + 5, { width: col2w, align: 'right' });
    doc.text('Unique',     col3x,      thY + 5, { width: col3w, align: 'right' });
    doc.y = thY + 20;

    sorted.forEach((r, i) => {
      ensureSpace(18);
      const ry = doc.y;
      if (i % 2 === 1) doc.save().rect(M, ry, W, 16).fill(C.bg).restore();
      doc.fillColor(C.text).font('Helvetica').fontSize(9);
      doc.text(r[1] || r[0], col1x + 4, ry + 3, { width: col1w - 4 });
      doc.text(String(r[3] || 0), col2x, ry + 3, { width: col2w, align: 'right' });
      doc.text(String(r[4] || 0), col3x, ry + 3, { width: col3w, align: 'right' });
      doc.y = ry + 16;
    });

    // ── Data sections ─────────────────────────────────
    for (const [label, valSet] of dataGroups) {
      doc.addPage();

      // Full-width top banner per section
      doc.save().rect(0, 0, PW, 55).fill(C.navy).restore();
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(16)
         .text(label, M, 16, { width: W });
      const vals = [...valSet];
      doc.fillColor(C.silver).font('Helvetica').fontSize(9)
         .text(`${vals.length} unique value${vals.length !== 1 ? 's' : ''}`, M, 40);

      doc.y = 72;

      for (const val of vals) {
        ensureSpace(22);
        const vy = doc.y;
        // Subtle alternating row bg every other item
        doc.fillColor(C.text).font('Helvetica').fontSize(10)
           .text('•  ' + val, M + 8, vy, { width: W - 8 });
        doc.y += 4;
      }
    }

    // ── Page footers (requires bufferPages) ───────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.save().rect(0, PH - 28, PW, 28).fill(C.navy).restore();
      doc.fillColor(C.silver).font('Helvetica').fontSize(7)
         .text(
           `WAssistent OSINT Report  ·  ${target}  ·  Page ${i + 1} / ${range.count}`,
           M, PH - 16, { align: 'center', width: W }
         );
    }

    doc.end();
  });
}

// ─── Formatting helpers (text fallback) ──────────────────────────

// scanlist: [id, name, target, created, started, finished, status, result_count, riskmatrix]
function formatScanLine(s) {
  return `• \`${s[0]}\` ${sfEmoji(s[6])} *${s[2]}* — ${s[6]} (${s[7]} events)`;
}

function formatSummaryTop(rows, max = 15) {
  if (!rows.length) return 'No findings yet.';
  const sorted = [...rows].sort((a, b) => b[3] - a[3]);
  const top = sorted.slice(0, max);
  const lines = top.map((r) => `• ${r[3]}× ${r[1]}`);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more event types`);
  return lines.join('\n');
}

// ─── Command handler ──────────────────────────────────────────────

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
      const [, target, , started, ended, status, risk] = s;
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
      const [statusData, summary] = await Promise.all([sfScanStatus(id), sfScanSummary(id)]);
      const [, target, , , , scanStatus] = statusData;
      const total = summary.reduce((acc, r) => acc + (r[3] || 0), 0);
      return `🕷️ *Scan Results — ${target}*\nStatus: ${sfEmoji(scanStatus)} ${scanStatus} | Total events: ${total}\n\n${formatSummaryTop(summary)}\n\nSend \`spiderfoot dossier ${id}\` to receive a full PDF report.`;
    } catch (err) {
      return `❌ SpiderFoot error: ${err.message}`;
    }
  }

  // spiderfoot dossier <id>  — generate and send PDF
  const dossierMatch = text.trim().match(/^spiderfoot dossier\s+(\S+)$/i);
  if (dossierMatch) {
    const id = dossierMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    const chatId = process.env.MY_CHAT_ID;
    try {
      const [statusData, summary, rows] = await Promise.all([
        sfScanStatus(id),
        sfScanSummary(id),
        sfScanResults(id),
      ]);

      if (!rows.length) return '🕷️ No data yet — scan may still be running.';

      const [, target] = statusData;
      const typeLabels  = Object.fromEntries(summary.map(r => [r[0], r[1]]));
      const dataGroups  = buildDataGroups(rows, typeLabels);

      const pdfBuf = await buildDossierPDF(target, statusData, summary, dataGroups);
      const b64    = pdfBuf.toString('base64');
      const safeTarget = target.replace(/[^a-z0-9._-]/gi, '_');
      const filename   = `OSINT_${safeTarget}_${id}.pdf`;

      await sendDocument(chatId, b64, filename, `🕷️ OSINT Dossier — ${target}`);
      return null; // already sent as document
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
  const scanMatch = text.trim().match(/^spiderfoot\s+(.+)$/i);
  if (scanMatch) {
    const target = scanMatch[1].trim();
    try {
      const scanId = await sfStartScan(target);
      return `🕷️ Scan started!\n• Target: *${target}*\n• ID: \`${scanId}\`\n\nCheck progress: \`spiderfoot status ${scanId}\`\nView summary: \`spiderfoot results ${scanId}\`\nGet PDF report: \`spiderfoot dossier ${scanId}\``;
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
• \`spiderfoot results <id>\` — event type summary
• \`spiderfoot dossier <id>\` — generate & send full PDF report
• \`spiderfoot stop <id>\` — abort a running scan
• \`spiderfoot delete <id>\` — delete a scan`;
}
