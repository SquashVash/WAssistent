import axios from 'axios';
import { spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import PDFDocument from 'pdfkit';
import { sendDocument, sendMessage } from './messaging.js';
import { getSetting, setSetting } from './settings.js';

const SF_BASE = process.env.SPIDERFOOT_URL || 'http://127.0.0.1:5001';
const SCAN_ID_RE = /^[a-z0-9]{8,36}$/i;
const SKIP_TYPES = new Set(['BASE64_DATA']);
const TERMINAL_SF = new Set(['FINISHED', 'ABORTED', 'FAILED', 'ERROR']);

const STATUS_EMOJI = { RUNNING:'🔄', FINISHED:'✅', ABORTED:'⛔', FAILED:'❌', STARTING:'🚀', CREATED:'🕐' };

const C = {
  navy:  '#1a1a2e', accent: '#e94560', silver: '#8888aa',
  bg:    '#f7f9fb', rule:   '#e0e4ea', text:   '#222222',
  muted: '#666666', white:  '#ffffff', ltblue: '#eef2f7',
  green: '#2ecc71',
};

function sfEmoji(s) { return STATUS_EMOJI[s?.toUpperCase()] ?? '❓'; }

function htmlUnescape(s) {
  return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function cleanValue(raw) {
  const s = htmlUnescape(raw).trim();
  const m = s.match(/<SFURL>([\s\S]*?)<\/SFURL>/);
  return m ? m[1].trim() : s;
}

// ─── Target type detection ─────────────────────────────────────────

function detectTargetType(raw) {
  const t = raw.trim().replace(/^"|"$/g, '');
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}(\/\d+)?$/.test(t)) return 'ip';
  if (/^.*@.*$/.test(t)) return 'email';
  if (/^\+[0-9]+$/.test(t)) return 'phone';
  if (/([a-z0-9][-a-z0-9]*[a-z0-9])\.[a-z]/i.test(t)) return 'domain';
  if (/\s/.test(t)) return 'person';
  return 'username';
}

// Mirror SpiderFoot's targetTypeFromString() to quote usernames/person names
function prepareSFTarget(raw, targetType) {
  const t = raw.trim();
  if ((targetType === 'person' || targetType === 'username') && !t.startsWith('"')) {
    return `"${t}"`;
  }
  return t;
}

// ─── SpiderFoot API wrappers ───────────────────────────────────────

async function sfStartScan(target, targetType) {
  const scantarget = prepareSFTarget(target, targetType);
  const { data } = await axios.get(`${SF_BASE}/startscan`, {
    params: { scanname: `osintScan_${Date.now()}`, scantarget, usecase: 'all', modulelist: '', typelist: '' },
    headers: { Accept: 'application/json' },
  });
  if (!Array.isArray(data) || data[0] !== 'SUCCESS')
    throw new Error(Array.isArray(data) ? data[1] : String(data));
  return data[1];
}

async function sfListScans(limit = 8) {
  const { data } = await axios.get(`${SF_BASE}/scanlist`);
  return Array.isArray(data) ? data.slice(0, limit) : [];
}

async function sfScanStatus(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scanstatus`, { params: { id: scanId } });
  if (!Array.isArray(data)) throw new Error('Unexpected response');
  return data;
}

async function sfScanSummary(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scansummary`, { params: { id: scanId, by: 'type' } });
  return Array.isArray(data) ? data : [];
}

async function sfScanResults(scanId) {
  const { data } = await axios.get(`${SF_BASE}/scaneventresults`, { params: { id: scanId } });
  return Array.isArray(data) ? data : [];
}

async function sfStopScan(scanId)   { await axios.get(`${SF_BASE}/stopscan`,   { params: { id: scanId } }); }
async function sfDeleteScan(scanId) { await axios.get(`${SF_BASE}/scandelete`, { params: { id: scanId } }); }

// ─── Maigret runner ────────────────────────────────────────────────

// In-memory state: sfScanId → { done, results: [{site, url, category}] }
const maigretState = new Map();

function maigretOutputDir(sfScanId) {
  const dir = join(tmpdir(), `maigret_${sfScanId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parseMaigretJson(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }

  // Simple format: { "SiteName": { "site": {...}, "status": { "status": "Claimed", "url": "...", "tags": [...], "ids": {...} } } }
  const sites = data.sites || data;
  if (typeof sites !== 'object' || Array.isArray(sites)) return [];

  const accounts = [];
  for (const [siteName, info] of Object.entries(sites)) {
    if (!info || typeof info !== 'object') continue;
    const s = info.status;
    if (!s || typeof s !== 'object') continue;
    if (!/claimed/i.test(String(s.status || ''))) continue;
    const tags = Array.isArray(s.tags) ? s.tags : [];
    const category = tags[0] || 'social';
    accounts.push({ site: siteName, url: s.url || '', category });
  }
  return accounts.sort((a, b) => a.category.localeCompare(b.category) || a.site.localeCompare(b.site));
}

function startMaigret(sfScanId, username) {
  const dir = maigretOutputDir(sfScanId);
  maigretState.set(sfScanId, { done: false, results: null });

  // -J simple: write a simple JSON report; --folderoutput: where to put it
  const MAIGRET_ARGS = [username, '-J', 'simple', '--folderoutput', dir];

  function spawnMaigret(bin, args) {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', (code) => {
      console.log(`🔍 Maigret exit ${code} | dir: ${dir}`);
      finalizeMaigret(sfScanId, dir, output);
    });
    return proc;
  }

  // Try `maigret` binary; fallback to `python3 -m maigret`
  const proc = spawnMaigret('maigret', MAIGRET_ARGS);

  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      const proc2 = spawnMaigret('python3', ['-m', 'maigret', ...MAIGRET_ARGS]);
      proc2.on('error', () => finalizeMaigret(sfScanId, dir, 'python3 not found'));
    } else {
      finalizeMaigret(sfScanId, dir, err.message);
    }
  });
}

function finalizeMaigret(sfScanId, dir, debugOutput = '') {
  const state = maigretState.get(sfScanId);
  if (!state || state.done) return;
  state.done = true;

  // Maigret writes report_<username>_<timestamp>.json into the folder
  let jsonFiles = [];
  try { jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json')); } catch {}

  if (jsonFiles.length) {
    const allResults = [];
    for (const f of jsonFiles) {
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const parsed = JSON.parse(raw);
        const sample = Object.entries(parsed).slice(0, 3).map(([k, v]) =>
          `${k}: status=${JSON.stringify(v?.status)} url=${JSON.stringify(v?.url)}`
        );
        console.log(`🔍 Maigret ${f} sample:\n${sample.join('\n')}`);
        allResults.push(...parseMaigretJson(raw));
      } catch (e) {
        console.error(`🔍 Maigret parse error (${f}): ${e.message}`);
      }
    }
    // Deduplicate by site+url
    const seen = new Set();
    state.results = allResults.filter(a => {
      const key = `${a.site}|${a.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  } else {
    console.log(`🔍 Maigret: no JSON in ${dir}. Output:\n${debugOutput.slice(-800)}`);
    state.results = [];
  }
  console.log(`🔍 Maigret done for ${sfScanId}: ${state.results.length} accounts found`);
}

// ─── Pending scan tracking ─────────────────────────────────────────
// Settings key: osintPendingScans
// Record: { target, targetType, startedAt, maigret: boolean }

const activePollers = new Map();

function getPending() {
  return getSetting('osintPendingScans', null, {});
}

function addPending(sfScanId, target, targetType, usesMaigret) {
  const p = getPending();
  p[sfScanId] = { target, targetType, startedAt: Date.now(), maigret: usesMaigret };
  setSetting('osintPendingScans', p);
}

function removePending(sfScanId) {
  const p = getPending();
  delete p[sfScanId];
  setSetting('osintPendingScans', p);
  if (activePollers.has(sfScanId)) {
    clearTimeout(activePollers.get(sfScanId));
    activePollers.delete(sfScanId);
  }
  maigretState.delete(sfScanId);
}

export function getOsintPollMinutes() {
  return parseInt(getSetting('osintPollMinutes', 'SPIDERFOOT_POLL_MINUTES', '2'), 10) || 2;
}

export function setOsintPollMinutes(minutes) {
  setSetting('osintPollMinutes', minutes);
}

// ─── Poll loop ─────────────────────────────────────────────────────

async function pollOnce(sfScanId, record) {
  // Bail if already completed and removed (e.g. a queued timeout fired after dossier was sent)
  if (!getPending()[sfScanId]) return;

  const { target, targetType, maigret: usesMaigret } = record;

  // 1. Check SpiderFoot
  let sfStatusData;
  let sfStatus;
  try {
    sfStatusData = await sfScanStatus(sfScanId);
    sfStatus = sfStatusData[5]?.toUpperCase();
  } catch (err) {
    console.error(`🔍 Poll ${sfScanId}: SF check failed — ${err.message}`);
    schedulePoll(sfScanId, record);
    return;
  }

  const sfDone = TERMINAL_SF.has(sfStatus);

  // 2. Check Maigret
  const mgState = usesMaigret ? maigretState.get(sfScanId) : null;
  const mgDone  = !usesMaigret || (mgState?.done === true);

  console.log(`🔍 Poll ${sfScanId} (${target}): SF=${sfStatus} Maigret=${usesMaigret ? (mgDone ? 'done' : 'running') : 'n/a'}`);

  if (!sfDone || !mgDone) {
    schedulePoll(sfScanId, record);
    return;
  }

  // Both done — remove from pending
  removePending(sfScanId);
  const chatId = process.env.MY_CHAT_ID;

  if (sfStatus !== 'FINISHED') {
    await sendMessage(chatId, `🔍 OSINT scan on *${target}* ended with status: ${sfStatus}`);
    return;
  }

  // Generate combined dossier
  try {
    const [summary, rows] = await Promise.all([sfScanSummary(sfScanId), sfScanResults(sfScanId)]);
    const sfTotal     = summary.reduce((a, r) => a + (r[3] || 0), 0);
    const typeLabels  = Object.fromEntries(summary.map(r => [r[0], r[1]]));
    const dataGroups  = buildDataGroups(rows, typeLabels);
    const mgResults   = mgState?.results || [];

    if (!rows.length && !mgResults.length) {
      await sendMessage(chatId, `🔍 OSINT scan on *${target}* finished — no data found.`);
      return;
    }

    const pdfBuf    = await buildDossierPDF(target, targetType, sfStatusData, summary, dataGroups, mgResults);
    const safeTarget = target.replace(/[^a-z0-9._-]/gi, '_');
    const caption   = `🔍 OSINT Dossier — ${target} · SF: ${sfTotal} events${mgResults.length ? ` · Maigret: ${mgResults.length} accounts` : ''}`;
    await sendDocument(chatId, pdfBuf.toString('base64'), `OSINT_${safeTarget}_${sfScanId}.pdf`, caption);
  } catch (err) {
    await sendMessage(chatId, `🔍 OSINT scan on *${target}* finished but dossier failed: ${err.message}`);
  }
}

function schedulePoll(sfScanId, record) {
  if (activePollers.has(sfScanId)) clearTimeout(activePollers.get(sfScanId));
  const ms = getOsintPollMinutes() * 60 * 1000;
  const handle = setTimeout(() => pollOnce(sfScanId, record), ms);
  activePollers.set(sfScanId, handle);
}

function startScanPoller(sfScanId, target, targetType, usesMaigret) {
  addPending(sfScanId, target, targetType, usesMaigret);
  schedulePoll(sfScanId, { target, targetType, maigret: usesMaigret });
  console.log(`🔍 Polling started for ${sfScanId} (${target}) every ${getOsintPollMinutes()} min`);
}

export async function initOsintPollers() {
  const pending = getPending();
  const entries = Object.entries(pending);
  if (!entries.length) return;
  console.log(`🔍 Resuming ${entries.length} pending OSINT scan poller(s)…`);
  for (const [sfScanId, record] of entries) {
    const { target, targetType, maigret: usesMaigret } = record;
    // Re-start Maigret if it was running (process was lost on restart)
    if (usesMaigret) {
      const dir = maigretOutputDir(sfScanId);
      const hasOutput = readdirSync(dir).some(f => f.endsWith('.json'));
      if (hasOutput) {
        finalizeMaigret(sfScanId, dir);
      } else {
        startMaigret(sfScanId, target);
      }
    }
    try {
      const sfStatusData = await sfScanStatus(sfScanId);
      const sfStatus = sfStatusData[5]?.toUpperCase();
      if (TERMINAL_SF.has(sfStatus)) {
        await pollOnce(sfScanId, record);
      } else {
        schedulePoll(sfScanId, record);
      }
    } catch {
      schedulePoll(sfScanId, record);
    }
  }
}

// ─── SpiderFoot data processing ────────────────────────────────────

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

// ─── PDF generation ────────────────────────────────────────────────

async function buildDossierPDF(target, targetType, statusArr, summaryRows, dataGroups, maigretAccounts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW = doc.page.width, PH = doc.page.height, M = 50, W = PW - M * 2;
    const [, , , started, ended, status] = statusArr;
    const sfTotal  = summaryRows.reduce((a, r) => a + (r[3] || 0), 0);
    const sorted   = [...summaryRows].filter(r => r[0] !== 'ROOT').sort((a, b) => b[3] - a[3]);
    const toolsUsed = ['SpiderFoot', ...(maigretAccounts.length ? ['Maigret'] : [])].join(' + ');

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

    // ── Cover page ──────────────────────────────────────────────────
    doc.save().rect(0, 0, PW, 90).fill(C.navy).restore();
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(24)
       .text('OSINT Intelligence Dossier', M, 20, { width: W });
    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(11)
       .text('Confidential — WAssistent Automated Report', M, 54);
    doc.fillColor(C.silver).font('Helvetica').fontSize(9)
       .text(new Date().toLocaleString('en-GB'), M, 68);
    doc.y = 106;

    // Metadata block
    doc.save().rect(M, doc.y, W, 100).fill(C.ltblue).restore();
    const metaY = doc.y + 8;
    const pairs = [
      ['Target',       target],
      ['Target Type',  targetType],
      ['Tools Used',   toolsUsed],
      ['Status',       status || '—'],
      ['Scan Started', started || '—'],
      ['Scan Ended',   ended   || '—'],
      ['SF Events',    `${sfTotal} across ${sorted.length} categories`],
      ...(maigretAccounts.length ? [['Accounts Found', `${maigretAccounts.length} via Maigret`]] : []),
    ];
    pairs.forEach(([k, v], i) => {
      const ly = metaY + i * 13;
      doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8.5).text(k + ':', M + 8, ly, { width: 100 });
      doc.fillColor(C.text).font('Helvetica').fontSize(8.5).text(v, M + 112, ly, { width: W - 120 });
    });
    doc.y = metaY + pairs.length * 13 + 10;

    // ── Maigret section — social accounts ───────────────────────────
    if (maigretAccounts.length) {
      doc.addPage();
      addPageBanner('Online Presence — Maigret', `${maigretAccounts.length} accounts found across platforms`);

      // Group by category
      const byCategory = new Map();
      for (const acc of maigretAccounts) {
        if (!byCategory.has(acc.category)) byCategory.set(acc.category, []);
        byCategory.get(acc.category).push(acc);
      }

      for (const [cat, accounts] of byCategory) {
        ensureSpace(30);
        doc.fillColor(C.navy).font('Helvetica-Bold').fontSize(11)
           .text(cat.charAt(0).toUpperCase() + cat.slice(1), M, doc.y);
        doc.y += 4;
        hRule();

        accounts.forEach((acc, idx) => {
          ensureSpace(22);
          const ey = doc.y;
          if (idx % 2 === 0) doc.save().rect(M, ey, W, 20).fill(C.bg).restore();

          doc.save().rect(M, ey + 4, 22, 12).fill(C.green).restore();
          doc.fillColor(C.white).font('Helvetica-Bold').fontSize(7)
             .text(String(idx + 1), M + 1, ey + 6, { width: 20, align: 'center' });

          doc.fillColor(C.text).font('Helvetica-Bold').fontSize(9.5)
             .text(acc.site, M + 28, ey + 4, { width: 130 });
          doc.fillColor(C.accent).font('Helvetica').fontSize(8.5)
             .text(acc.url, M + 165, ey + 4, { width: W - 170, link: acc.url });
          doc.y = ey + 20;
        });
        doc.moveDown(0.5);
      }
    }

    // ── SpiderFoot: Event Type Summary ──────────────────────────────
    if (sorted.length) {
      doc.addPage();
      addPageBanner('SpiderFoot Intelligence', `${sfTotal} events across ${sorted.length} categories`);

      const cx1 = M, cw1 = W * 0.62;
      const cx2 = M + W * 0.63, cw2 = W * 0.17;
      const cx3 = M + W * 0.82, cw3 = W * 0.18;

      const thY = doc.y;
      doc.save().rect(M, thY, W, 18).fill(C.navy).restore();
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5);
      doc.text('Event Type', cx1 + 4, thY + 5, { width: cw1 - 4 });
      doc.text('Total',      cx2,     thY + 5, { width: cw2, align: 'right' });
      doc.text('Unique',     cx3,     thY + 5, { width: cw3, align: 'right' });
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
    }

    // ── SpiderFoot: Data pages — one per event type ─────────────────
    for (const [label, entries] of dataGroups) {
      doc.addPage();
      addPageBanner(label, `${entries.length} unique value${entries.length !== 1 ? 's' : ''}`);

      entries.forEach((entry, idx) => {
        const valueLines = Math.ceil(entry.value.length / 90) || 1;
        const srcLines   = entry.source && entry.source !== entry.value
          ? Math.ceil(entry.source.length / 100) + 1 : 0;
        const rowH = (valueLines + srcLines) * 12 + 16;
        ensureSpace(rowH);

        const ey = doc.y;
        if (idx % 2 === 0) doc.save().rect(M, ey, W, rowH).fill(C.bg).restore();

        doc.save().rect(M, ey + 4, 22, 12).fill(C.navy).restore();
        doc.fillColor(C.white).font('Helvetica-Bold').fontSize(7)
           .text(String(idx + 1), M + 1, ey + 6, { width: 20, align: 'center' });

        doc.fillColor(C.text).font('Helvetica-Bold').fontSize(10)
           .text(entry.value, M + 28, ey + 5, { width: W - 28 });

        let innerY = ey + 5 + valueLines * 12 + 2;

        if (entry.source && entry.source !== entry.value) {
          const srcDisplay = entry.source.length > 180 ? entry.source.slice(0, 180) + '…' : entry.source;
          doc.fillColor(C.muted).font('Helvetica').fontSize(8)
             .text('Source: ' + srcDisplay, M + 28, innerY, { width: W - 28 });
          innerY += srcLines * 10 + 2;
        }

        const metaStr = [entry.module, entry.lastseen].filter(Boolean).join('  ·  ');
        if (metaStr) {
          doc.fillColor(C.silver).font('Helvetica').fontSize(7.5)
             .text(metaStr, M + 28, innerY, { width: W - 28 });
        }

        doc.y = ey + rowH;
        doc.moveDown(0.1);
      });
    }

    // ── Footer on every page ────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.save().rect(0, PH - 26, PW, 26).fill(C.navy).restore();
      doc.fillColor(C.silver).font('Helvetica').fontSize(7)
         .text(
           `CONFIDENTIAL — WAssistent OSINT  ·  Target: ${target}  ·  Tools: ${toolsUsed}  ·  Page ${i + 1} / ${range.count}`,
           M, PH - 15, { align: 'center', width: W }
         );
    }

    doc.end();
  });
}

// ─── Text helpers ──────────────────────────────────────────────────

function formatScanLine(s) {
  // scanlist: [id, name, target, created, started, finished, status, result_count, riskmatrix]
  const pending = getPending();
  const record  = pending[s[0]];
  const tools   = record?.maigret ? ' [SF+Maigret]' : ' [SF]';
  return `• \`${s[0]}\` ${sfEmoji(s[6])} *${s[2]}* — ${s[6]} (${s[7]} events)${tools}`;
}

function formatSummaryTop(rows, max = 15) {
  if (!rows.length) return 'No findings yet.';
  const sorted = [...rows].sort((a, b) => b[3] - a[3]);
  const lines  = sorted.slice(0, max).map(r => `• ${r[3]}× ${r[1]}`);
  if (sorted.length > max) lines.push(`…and ${sorted.length - max} more event types`);
  return lines.join('\n');
}

// ─── Command handler ───────────────────────────────────────────────

export async function handleOsintCommand(text) {
  const t = text.trim();

  // osint scans
  if (/^osint scans?$/i.test(t)) {
    try {
      const scans = await sfListScans(8);
      if (!scans.length) return '🔍 No scans found.';
      return `🔍 *Recent OSINT Scans*\n\n${scans.map(formatScanLine).join('\n')}`;
    } catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  // osint status <id>
  const statusMatch = t.match(/^osint status\s+(\S+)$/i);
  if (statusMatch) {
    const id = statusMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      const s = await sfScanStatus(id);
      const [, target, , started, ended, status, risk] = s;
      const pending  = getPending();
      const record   = pending[id];
      const mgState  = maigretState.get(id);
      const mgLine   = record?.maigret
        ? `• Maigret: ${mgState?.done ? `✅ done (${mgState.results?.length ?? 0} accounts)` : '🔄 running'}`
        : '';
      const riskLine = risk
        ? `• Risk: 🔴 ${risk.HIGH??0} high / 🟠 ${risk.MEDIUM??0} med / 🟡 ${risk.LOW??0} low`
        : '';
      return [
        `🔍 *OSINT Scan Status*`,
        `• ID: \`${id}\``,
        `• Target: *${target}*`,
        `• SpiderFoot: ${sfEmoji(status)} ${status}`,
        mgLine,
        `• Started: ${started||'—'}`,
        `• Ended: ${ended||'—'}`,
        riskLine,
      ].filter(Boolean).join('\n');
    } catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  // osint results <id>
  const resultsMatch = t.match(/^osint results?\s+(\S+)$/i);
  if (resultsMatch) {
    const id = resultsMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      const [statusData, summary] = await Promise.all([sfScanStatus(id), sfScanSummary(id)]);
      const [, target, , , , scanStatus] = statusData;
      const total = summary.reduce((a, r) => a + (r[3]||0), 0);
      const mgState  = maigretState.get(id);
      const mgLine   = mgState?.done
        ? `Maigret: ${mgState.results?.length ?? 0} accounts found\n\n`
        : '';
      return `🔍 *OSINT Results — ${target}*\nSpiderFoot: ${sfEmoji(scanStatus)} ${scanStatus} | ${total} events\n${mgLine}${formatSummaryTop(summary)}\n\nSend \`osint dossier ${id}\` for the full PDF report.`;
    } catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  // osint dossier <id>
  const dossierMatch = t.match(/^osint dossier\s+(\S+)$/i);
  if (dossierMatch) {
    const id = dossierMatch[1];
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    const chatId = process.env.MY_CHAT_ID;
    try {
      const [statusData, summary, rows] = await Promise.all([
        sfScanStatus(id), sfScanSummary(id), sfScanResults(id),
      ]);
      const [, target] = statusData;
      const pending    = getPending();
      const record     = pending[id];
      const mgResults  = maigretState.get(id)?.results || [];
      const targetType = record?.targetType || detectTargetType(target);

      if (!rows.length && !mgResults.length) return '🔍 No data yet — scan may still be running.';

      const typeLabels = Object.fromEntries(summary.map(r => [r[0], r[1]]));
      const dataGroups = buildDataGroups(rows, typeLabels);

      const pdfBuf    = await buildDossierPDF(target, targetType, statusData, summary, dataGroups, mgResults);
      const safeTarget = target.replace(/[^a-z0-9._-]/gi, '_');
      await sendDocument(chatId, pdfBuf.toString('base64'), `OSINT_${safeTarget}_${id}.pdf`, `🔍 OSINT Dossier — ${target}`);
      return null;
    } catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  // osint poll <minutes>
  const pollMatch = t.match(/^osint poll\s+(\d+)$/i);
  if (pollMatch) {
    const minutes = parseInt(pollMatch[1], 10);
    if (minutes < 1 || minutes > 60) return '❌ Poll interval must be between 1 and 60 minutes.';
    setOsintPollMinutes(minutes);
    return `✅ OSINT poll interval set to every ${minutes} min.`;
  }

  // osint stop * | osint stop <id>
  const stopMatch = t.match(/^osint stop\s+(\S+)$/i);
  if (stopMatch) {
    const id = stopMatch[1];
    if (id === '*' || id.toLowerCase() === 'all') {
      const scans = await sfListScans(50);
      const running = scans.filter(s => !TERMINAL_SF.has(s[6]?.toUpperCase()));
      if (!running.length) return '⚠️ No running scans to stop.';
      const results = await Promise.allSettled(running.map(s => sfStopScan(s[0])));
      const stopped = results.filter(r => r.status === 'fulfilled').length;
      return `⛔ Stop requested for ${stopped}/${running.length} running scan(s).`;
    }
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try { await sfStopScan(id); return `⛔ Scan \`${id}\` stop requested.`; }
    catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  // osint delete * | osint delete <id>
  const deleteMatch = t.match(/^osint delete\s+(\S+)$/i);
  if (deleteMatch) {
    const id = deleteMatch[1];
    if (id === '*' || id.toLowerCase() === 'all') {
      const scans = await sfListScans(50);
      if (!scans.length) return '⚠️ No scans to delete.';
      const results = await Promise.allSettled(scans.map(s => sfDeleteScan(s[0]).then(() => removePending(s[0]))));
      const deleted = results.filter(r => r.status === 'fulfilled').length;
      return `🗑️ Deleted ${deleted}/${scans.length} scan(s).`;
    }
    if (!SCAN_ID_RE.test(id)) return '❌ Invalid scan ID format.';
    try {
      await sfDeleteScan(id);
      removePending(id);
      return `🗑️ Scan \`${id}\` deleted.`;
    } catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  // osint <target>  — start a scan (catch-all, must stay last)
  const scanMatch = t.match(/^osint\s+(.+)$/i);
  if (scanMatch) {
    const target     = scanMatch[1].trim();
    const targetType = detectTargetType(target);
    const usesMaigret = targetType === 'username' || targetType === 'person';
    try {
      const sfScanId = await sfStartScan(target, targetType);
      if (usesMaigret) {
        // Extract clean username/name for Maigret (strip quotes)
        const username = target.replace(/^"|"$/g, '').trim();
        startMaigret(sfScanId, username);
      }
      startScanPoller(sfScanId, target, targetType, usesMaigret);
      const toolsLine = usesMaigret ? '\n• Tools: SpiderFoot + Maigret' : '\n• Tools: SpiderFoot';
      return `🔍 OSINT scan started!\n• Target: *${target}*\n• Type: ${targetType}${toolsLine}\n• ID: \`${sfScanId}\`\n\nI'll deliver the full dossier automatically when all tools finish.\nProgress: \`osint status ${sfScanId}\``;
    } catch (err) { return `❌ OSINT error: ${err.message}`; }
  }

  return osintHelp();
}

export function osintHelp() {
  return `*🔍 OSINT*
• \`osint <target>\` — start a scan (domain, IP, email, username, person name, etc.)
• \`osint scans\` — list recent scans
• \`osint status <id>\` — check scan progress
• \`osint results <id>\` — event type summary
• \`osint dossier <id>\` — generate & send full PDF report
• \`osint stop <id>\` — abort a running scan
• \`osint stop *\` — abort all running scans
• \`osint delete <id>\` — delete a scan
• \`osint delete *\` — delete all scans
• \`osint poll <minutes>\` — set completion check interval (default 2 min)

_Username/person targets also run Maigret for social account discovery._`;
}
