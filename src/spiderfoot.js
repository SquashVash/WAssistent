import axios from 'axios';
import PDFDocument from 'pdfkit';
import { sendDocument, sendMessage } from './messaging.js';
import { getSetting, setSetting } from './settings.js';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://127.0.0.1:5001';
const SCAN_ID_RE = /^[a-z0-9]{8,36}$/i;

// Only skip pure binary blobs — everything else goes in the dossier
const SKIP_TYPES = new Set(['BASE64_DATA']);

const STATUS_EMOJI = { RUNNING:'🔄', FINISHED:'✅', ABORTED:'⛔', FAILED:'❌', STARTING:'🚀', CREATED:'🕐' };

const C = {
  navy:  '#1a1a2e', accent: '#e94560', silver: '#8888aa',
  bg:    '#f7f9fb', rule:   '#e0e4ea', text:   '#222222',
  muted: '#666666', white:  '#ffffff', ltblue: '#eef2f7',
};

function sfEmoji(s) { return STATUS_EMOJI[s?.toUpperCase()] ?? '❓'; }

// scaneventresults row layout (after webui field remapping):
// [0] lastseen  [1] event_data(escaped)  [2] source_data(escaped)
// [3] module    [4] confidence           [5] visibility
// [6] risk      [7] hash                 [8..9] extra  [10] type_code ← last

// scansummary: [type_code, type_descr, lastseen, total_count, unique_count, scan_status]
// scanstatus:  [name, target, created, started, ended, status, riskmatrix]
// scanlist:    [id, name, target, created, started, finished, status, result_count, riskmatrix]

function htmlUnescape(s) {
  return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function cleanValue(raw) {
  const s = htmlUnescape(raw).trim();
  const m = s.match(/<SFURL>([\s\S]*?)<\/SFURL>/);
  return m ? m[1].trim() : s;
}

// Mirror SpiderFoot's targetTypeFromString() to auto-quote usernames/human names
function prepareTarget(raw) {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t;
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}(\/\d+)?$/.test(t)) return t;
  if (/^.*@.*$/.test(t)) return t;
  if (/^\+[0-9]+$/.test(t)) return t;
  if (/^[0-9]+$/.test(t)) return t;
  if (/([a-z0-9][-a-z0-9]*[a-z0-9])\.[a-z]/i.test(t)) return t;
  return `"${t}"`;
}

// ─── API wrappers ─────────────────────────────────────────────────

export async function sfStartScan(target, usecase = 'all') {
  const scantarget = prepareTarget(target);
  const { data } = await axios.get(`${SF_BASE}/startscan`, {
    params: { scanname: `wabotScan_${Date.now()}`, scantarget, usecase, modulelist: '', typelist: '' },
    headers: { Accept: 'application/json' },
  });
  if (!Array.isArray(data) || data[0] !== 'SUCCESS')
    throw new Error(Array.isArray(data) ? data[1] : String(data));
  return data[1];
}

export async function sfListScans(limit = 8) {
  const { data } = await axios.get(`${SF_BASE}/scanlist`);
  return Array.isArray(data) ? data.slice(0, limit) : [];
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

export async function sfStopScan(scanId)   { await axios.get(`${SF_BASE}/stopscan`,   { params: { id: scanId } }); }
export async function sfDeleteScan(scanId) { await axios.get(`${SF_BASE}/scandelete`, { params: { id: scanId } }); }

// ─── Data processing ──────────────────────────────────────────────

// Returns Map<typeLabel, Array<{value, source, module, lastseen}>>
// Deduplicates by value, keeps the entry with the most context.
function buildDataGroups(rows, typeLabels) {
  const groups = new Map();
  for (const row of rows) {
    const typeCode = row[10];
    if (!typeCode || typeCode === 'ROOT' || SKIP_TYPES.has(typeCode)) continue;
    const value = cleanValue(row[1]);
    if (!value) continue;
    const label    = typeLabels[typeCode] || typeCode;
    const source   = cleanValue(row[2]);
    const module_  = String(row[3] || '');
    const lastseen = String(row[0] || '');
    if (!groups.has(label)) groups.set(label, new Map());
    const byVal = groups.get(label);
    if (!byVal.has(value)) byVal.set(value, { value, source, module: module_, lastseen });
  }
  return new Map([...groups].map(([lbl, m]) => [lbl, [...m.values()]]));
}

// ─── PDF generation ───────────────────────────────────────────────

async function buildDossierPDF(target, statusArr, summaryRows, dataGroups) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = doc.page.width, PH = doc.page.height, M = 50, W = PW - M * 2;
    const [, , , started, ended, status] = statusArr;
    const total   = summaryRows.reduce((a, r) => a + (r[3] || 0), 0);
    const sorted  = [...summaryRows].filter(r => r[0] !== 'ROOT').sort((a, b) => b[3] - a[3]);

    function addPageBanner(title, subtitle) {
      doc.save().rect(0, 0, PW, 60).fill(C.navy).restore();
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(15)
         .text(title, M, 14, { width: W });
      if (subtitle) {
        doc.fillColor(C.silver).font('Helvetica').fontSize(9)
           .text(subtitle, M, 36, { width: W });
      }
      doc.y = 72;
      doc.fillColor(C.text);
    }

    function ensureSpace(needed) {
      if (doc.y + needed > PH - 55) doc.addPage();
    }

    function hRule() {
      doc.save().strokeColor(C.rule).lineWidth(0.5)
         .moveTo(M, doc.y).lineTo(M + W, doc.y).stroke().restore();
      doc.y += 4;
    }

    // ═══════════════════════════════════════════════
    // PAGE 1 — Cover + Metadata + Summary
    // ═══════════════════════════════════════════════
    doc.save().rect(0, 0, PW, 90).fill(C.navy).restore();
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(24)
       .text('OSINT Intelligence Dossier', M, 20, { width: W });
    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(11)
       .text('Confidential — WAssistent Automated Report', M, 54);
    doc.fillColor(C.silver).font('Helvetica').fontSize(9)
       .text(new Date().toLocaleString('en-GB'), M, 68);
    doc.y = 106;

    // Metadata block
    doc.save().rect(M, doc.y, W, 86).fill(C.ltblue).restore();
    const metaY = doc.y + 8;
    const pairs = [
      ['Target',        target],
      ['Status',        status || '—'],
      ['Scan Started',  started || '—'],
      ['Scan Ended',    ended   || '—'],
      ['Total Events',  `${total} across ${sorted.length} categories`],
    ];
    pairs.forEach(([k, v], i) => {
      const ly = metaY + i * 14;
      doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(9).text(k + ':', M + 8, ly, { width: 90 });
      doc.fillColor(C.text).font('Helvetica').fontSize(9).text(v, M + 102, ly, { width: W - 110 });
    });
    doc.y += 100;

    // Summary table
    doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(13)
       .text('Event Type Summary', M, doc.y);
    doc.moveDown(0.5);

    const cx1 = M, cw1 = W * 0.62;
    const cx2 = M + W * 0.63, cw2 = W * 0.17;
    const cx3 = M + W * 0.82, cw3 = W * 0.18;

    // Header row
    const thY = doc.y;
    doc.save().rect(M, thY, W, 18).fill(C.navy).restore();
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5);
    doc.text('Event Type',   cx1 + 4, thY + 5, { width: cw1 - 4 });
    doc.text('Total',        cx2,     thY + 5, { width: cw2, align: 'right' });
    doc.text('Unique',       cx3,     thY + 5, { width: cw3, align: 'right' });
    doc.y = thY + 20;

    sorted.forEach((r, i) => {
      ensureSpace(16);
      const ry = doc.y;
      if (i % 2 === 1) doc.save().rect(M, ry, W, 15).fill(C.bg).restore();
      doc.fillColor(C.text).font('Helvetica').fontSize(8.5);
      doc.text(r[1] || r[0], cx1 + 4, ry + 3, { width: cw1 - 4 });
      doc.text(String(r[3] || 0), cx2, ry + 3, { width: cw2, align: 'right' });
      doc.text(String(r[4] || 0), cx3, ry + 3, { width: cw3, align: 'right' });
      doc.y = ry + 15;
    });

    // ═══════════════════════════════════════════════
    // DATA PAGES — one section per event type
    // ═══════════════════════════════════════════════
    for (const [label, entries] of dataGroups) {
      doc.addPage();
      addPageBanner(label, `${entries.length} unique value${entries.length !== 1 ? 's' : ''}`);

      entries.forEach((entry, idx) => {
        // Estimate height: value line(s) + source line + gap
        const valueLines = Math.ceil(entry.value.length / 90) || 1;
        const srcLines   = entry.source && entry.source !== entry.value
          ? Math.ceil(entry.source.length / 100) + 1
          : 0;
        const rowH = (valueLines + srcLines) * 12 + 16;
        ensureSpace(rowH);

        const ey = doc.y;

        // Alternate row background
        if (idx % 2 === 0) {
          doc.save().rect(M, ey, W, rowH).fill(C.bg).restore();
        }

        // Index badge
        doc.save().rect(M, ey + 4, 22, 12).fill(C.navy).restore();
        doc.fillColor(C.white).font('Helvetica-Bold').fontSize(7)
           .text(String(idx + 1), M + 1, ey + 6, { width: 20, align: 'center' });

        // Value (main text)
        doc.fillColor(C.text).font('Helvetica-Bold').fontSize(10)
           .text(entry.value, M + 28, ey + 5, { width: W - 28 });

        let innerY = ey + 5 + valueLines * 12 + 2;

        // Source (if different from value and non-empty)
        if (entry.source && entry.source !== entry.value) {
          const srcDisplay = entry.source.length > 180 ? entry.source.slice(0, 180) + '…' : entry.source;
          doc.fillColor(C.muted).font('Helvetica').fontSize(8)
             .text('Source: ' + srcDisplay, M + 28, innerY, { width: W - 28 });
          innerY += srcLines * 10 + 2;
        }

        // Module + timestamp on one line
        const metaStr = [entry.module, entry.lastseen].filter(Boolean).join('  ·  ');
        if (metaStr) {
          doc.fillColor(C.silver).font('Helvetica').fontSize(7.5)
             .text(metaStr, M + 28, innerY, { width: W - 28 });
        }

        doc.y = ey + rowH;
        doc.moveDown(0.1);
      });
    }

    // ═══════════════════════════════════════════════
    // Footer on every page
    // ═══════════════════════════════════════════════
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.save().rect(0, PH - 26, PW, 26).fill(C.navy).restore();
      doc.fillColor(C.silver).font('Helvetica').fontSize(7)
         .text(
           `CONFIDENTIAL — WAssistent OSINT Report  ·  Target: ${target}  ·  Page ${i + 1} / ${range.count}`,
           M, PH - 15, { align: 'center', width: W }
         );
    }

    doc.end();
  });
}

// ─── Scan poller ──────────────────────────────────────────────────

const TERMINAL = new Set(['FINISHED', 'ABORTED', 'FAILED', 'ERROR']);

export function getSpiderfootPollMinutes() {
  return parseInt(getSetting('spiderfootPollMinutes', 'SPIDERFOOT_POLL_MINUTES', '2'), 10) || 2;
}

export function setSpiderfootPollMinutes(minutes) {
  setSetting('spiderfootPollMinutes', minutes);
}

// In-memory map of active timers: scanId → timeoutHandle
const activePollers = new Map();

function getPending() {
  return getSetting('spiderfootPendingScans', null, {});
}

function addPending(scanId, target) {
  const p = getPending();
  p[scanId] = { target, startedAt: Date.now() };
  setSetting('spiderfootPendingScans', p);
}

function removePending(scanId) {
  const p = getPending();
  delete p[scanId];
  setSetting('spiderfootPendingScans', p);
  if (activePollers.has(scanId)) {
    clearTimeout(activePollers.get(scanId));
    activePollers.delete(scanId);
  }
}

async function pollOnce(scanId, target) {
  let statusData;
  try {
    statusData = await sfScanStatus(scanId);
  } catch (err) {
    console.error(`🕷️ Poll ${scanId}: status check failed — ${err.message}`);
    schedulePoll(scanId, target); // retry next interval
    return;
  }

  const status = statusData[5]; // scanstatus: [name, target, created, started, ended, status, ...]
  console.log(`🕷️ Poll scan ${scanId} (${target}): ${status}`);

  if (!TERMINAL.has(status?.toUpperCase())) {
    schedulePoll(scanId, target);
    return;
  }

  // Scan ended — remove from pending regardless of what happens next
  removePending(scanId);
  const chatId = process.env.MY_CHAT_ID;

  if (status?.toUpperCase() !== 'FINISHED') {
    await sendMessage(chatId, `🕷️ Scan on *${target}* ended with status: ${status}`);
    return;
  }

  // FINISHED — generate and send the dossier
  try {
    const [summary, rows] = await Promise.all([sfScanSummary(scanId), sfScanResults(scanId)]);
    const total      = summary.reduce((a, r) => a + (r[3] || 0), 0);
    const typeLabels = Object.fromEntries(summary.map(r => [r[0], r[1]]));
    const dataGroups = buildDataGroups(rows, typeLabels);

    if (!rows.length) {
      await sendMessage(chatId, `🕷️ Scan on *${target}* finished — no events found.`);
      return;
    }

    const pdfBuf    = await buildDossierPDF(target, statusData, summary, dataGroups);
    const safeTarget = target.replace(/[^a-z0-9._-]/gi, '_');
    await sendDocument(
      chatId,
      pdfBuf.toString('base64'),
      `OSINT_${safeTarget}_${scanId}.pdf`,
      `🕷️ Scan complete! OSINT Dossier — ${target} (${total} events)`
    );
  } catch (err) {
    await sendMessage(chatId, `🕷️ Scan on *${target}* finished but dossier failed: ${err.message}`);
  }
}

function schedulePoll(scanId, target) {
  if (activePollers.has(scanId)) clearTimeout(activePollers.get(scanId));
  const ms = getSpiderfootPollMinutes() * 60 * 1000;
  const handle = setTimeout(() => pollOnce(scanId, target), ms);
  activePollers.set(scanId, handle);
}

export function startScanPoller(scanId, target) {
  addPending(scanId, target);
  schedulePoll(scanId, target);
  console.log(`🕷️ Polling started for scan ${scanId} (${target}) every ${getSpiderfootPollMinutes()} min`);
}

// Called on bot startup — resume polling for any scans that were in-flight before a restart
export async function initSpiderfootPollers() {
  const pending = getPending();
  const entries = Object.entries(pending);
  if (!entries.length) return;
  console.log(`🕷️ Resuming ${entries.length} pending scan poller(s)…`);
  for (const [scanId, { target }] of entries) {
    // Check status immediately — the scan may have finished while the bot was down
    try {
      const statusData = await sfScanStatus(scanId);
      const status = statusData[5];
      if (TERMINAL.has(status?.toUpperCase())) {
        // Already done — trigger completion flow immediately
        await pollOnce(scanId, target);
      } else {
        schedulePoll(scanId, target);
      }
    } catch {
      schedulePoll(scanId, target); // unreachable now, retry later
    }
  }
}

// ─── Text helpers (for non-dossier commands) ──────────────────────

// scanlist: [id, name, target, created, started, finished, status, result_count, riskmatrix]
function formatScanLine(s) {
  return `• \`${s[0]}\` ${sfEmoji(s[6])} *${s[2]}* — ${s[6]} (${s[7]} events)`;
}

function formatSummaryTop(rows, max = 15) {
  if (!rows.length) return 'No findings yet.';
  const sorted = [...rows].sort((a, b) => b[3] - a[3]);
  const lines  = sorted.slice(0, max).map(r => `• ${r[3]}× ${r[1]}`);
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
    } catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
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
        ? `• Risk: 🔴 ${risk.HIGH??0} high / 🟠 ${risk.MEDIUM??0} med / 🟡 ${risk.LOW??0} low`
        : '';
      return [
        `🕷️ *Scan Status*`,
        `• ID: \`${id}\``,
        `• Target: *${target}*`,
        `• Status: ${sfEmoji(status)} ${status}`,
        `• Started: ${started||'—'}`,
        `• Ended: ${ended||'—'}`,
        riskLine,
      ].filter(Boolean).join('\n');
    } catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
  }

  // spiderfoot results <id>
  const resultsMatch = text.trim().match(/^spiderfoot results?\s+(\S+)$/i);
  if (resultsMatch) {
    const id = resultsMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      const [statusData, summary] = await Promise.all([sfScanStatus(id), sfScanSummary(id)]);
      const [, target, , , , scanStatus] = statusData;
      const total = summary.reduce((a, r) => a + (r[3]||0), 0);
      return `🕷️ *Scan Results — ${target}*\nStatus: ${sfEmoji(scanStatus)} ${scanStatus} | Total events: ${total}\n\n${formatSummaryTop(summary)}\n\nSend \`spiderfoot dossier ${id}\` to receive a full PDF report.`;
    } catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
  }

  // spiderfoot dossier <id>
  const dossierMatch = text.trim().match(/^spiderfoot dossier\s+(\S+)$/i);
  if (dossierMatch) {
    const id = dossierMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    const chatId = process.env.MY_CHAT_ID;
    try {
      const [statusData, summary, rows] = await Promise.all([
        sfScanStatus(id), sfScanSummary(id), sfScanResults(id),
      ]);
      if (!rows.length) return '🕷️ No data yet — scan may still be running.';

      const [, target] = statusData;
      const typeLabels = Object.fromEntries(summary.map(r => [r[0], r[1]]));
      const dataGroups = buildDataGroups(rows, typeLabels);

      const pdfBuf   = await buildDossierPDF(target, statusData, summary, dataGroups);
      const safeTarget = target.replace(/[^a-z0-9._-]/gi, '_');
      await sendDocument(chatId, pdfBuf.toString('base64'), `OSINT_${safeTarget}_${id}.pdf`, `🕷️ OSINT Dossier — ${target}`);
      return null;
    } catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
  }

  // spiderfoot poll <minutes>
  const pollMatch = text.trim().match(/^spiderfoot poll\s+(\d+)$/i);
  if (pollMatch) {
    const minutes = parseInt(pollMatch[1], 10);
    if (minutes < 1 || minutes > 60) return '❌ Poll interval must be between 1 and 60 minutes.';
    setSpiderfootPollMinutes(minutes);
    return `✅ SpiderFoot poll interval set to every ${minutes} min.`;
  }

  // spiderfoot stop <id>
  const stopMatch = text.trim().match(/^spiderfoot stop\s+(\S+)$/i);
  if (stopMatch) {
    const id = stopMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try { await sfStopScan(id); return `⛔ Scan \`${id}\` stop requested.`; }
    catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
  }

  // spiderfoot delete <id>
  const deleteMatch = text.trim().match(/^spiderfoot delete\s+(\S+)$/i);
  if (deleteMatch) {
    const id = deleteMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try { await sfDeleteScan(id); return `🗑️ Scan \`${id}\` deleted.`; }
    catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
  }

  // spiderfoot <target>  — start a scan (catch-all, must stay last)
  const scanMatch = text.trim().match(/^spiderfoot\s+(.+)$/i);
  if (scanMatch) {
    const target = scanMatch[1].trim();
    try {
      const scanId = await sfStartScan(target);
      startScanPoller(scanId, target);
      return `🕷️ Scan started!\n• Target: *${target}*\n• ID: \`${scanId}\`\n\nI'll notify you automatically when the scan finishes and send the full dossier.\nCheck progress: \`spiderfoot status ${scanId}\``;
    } catch (err) { return `❌ SpiderFoot error: ${err.message}`; }
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
• \`spiderfoot delete <id>\` — delete a scan
• \`spiderfoot poll <minutes>\` — set completion check interval (default 2 min)`;
}
