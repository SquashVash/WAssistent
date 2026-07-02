import { getSetting, setSetting } from './settings.js';
import { listGmailReceiptCandidates } from './gmail.js';
import { listZohoReceiptCandidates } from './zoho.js';

// Adjustable list of subscription/service sources tracked for the `receipts` command.
// `day` is informational (billing day of month) and shown in `receipts sources`.
const DEFAULT_RECEIPT_SOURCES = [
  { name: 'Taapi', enabled: true, keywords: ['taapi'] },
  { name: 'Google Cloud', enabled: true, day: 5, keywords: ['google cloud', 'google workspace'] },
  { name: 'chatGPT', enabled: true, day: 4, keywords: ['chatgpt'] },
  { name: 'Bubble', enabled: true, keywords: ['bubble'] },
  { name: 'Cursor', enabled: true, keywords: ['cursor'] },
  { name: 'Canva', enabled: true, keywords: ['canva'] },
  { name: 'Figma', enabled: false, keywords: ['figma'] },
  { name: 'Appfigures', enabled: true, day: 7, keywords: ['appfigures'] },
  { name: 'RevenueCat', enabled: true, keywords: ['revenuecat'] },
  { name: 'Claude', enabled: true, keywords: ['claude', 'anthropic'] },
  { name: 'Charity', enabled: false, keywords: ['charity', 'donation'] },
  { name: 'Godaddy', enabled: true, keywords: ['godaddy'] },
  { name: 'OpenAi API', enabled: true, keywords: ['openai'], exclude: ['chatgpt'] },
  { name: 'Buffer', enabled: true, keywords: ['buffer'] },
  { name: 'Wordpress', enabled: false, keywords: ['wordpress'] },
  { name: 'Elementor', enabled: false, keywords: ['elementor'] },
  { name: 'Gtranslate', enabled: false, keywords: ['gtranslate'] },
  { name: 'Audio Player by Sonaar', enabled: false, keywords: ['sonaar', 'audio player'] },
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// ---- Receipt sources (adjustable list) ----

export function getReceiptSources() {
  const stored = getSetting('receiptSources', null, null);
  if (Array.isArray(stored)) return stored;
  const defaults = DEFAULT_RECEIPT_SOURCES.map(s => ({ ...s }));
  setSetting('receiptSources', defaults);
  return defaults;
}

function saveReceiptSources(list) {
  setSetting('receiptSources', list);
}

function findSourceIndex(sources, name) {
  const q = name.trim().toLowerCase();
  return sources.findIndex(s => s.name.toLowerCase() === q);
}

export function addReceiptSource(name) {
  const sources = getReceiptSources();
  if (findSourceIndex(sources, name) !== -1) return false;
  sources.push({ name: name.trim(), enabled: true, keywords: [name.trim().toLowerCase()] });
  saveReceiptSources(sources);
  return true;
}

export function removeReceiptSource(name) {
  const sources = getReceiptSources();
  const idx = findSourceIndex(sources, name);
  if (idx === -1) return false;
  sources.splice(idx, 1);
  saveReceiptSources(sources);
  return true;
}

export function setReceiptSourceEnabled(name, enabled) {
  const sources = getReceiptSources();
  const idx = findSourceIndex(sources, name);
  if (idx === -1) return false;
  sources[idx].enabled = enabled;
  saveReceiptSources(sources);
  return true;
}

function sourceMatches(source, subject, from) {
  const haystack = `${subject} ${from}`.toLowerCase();
  const hasKeyword = (source.keywords || []).some(k => haystack.includes(k.toLowerCase()));
  if (!hasKeyword) return false;
  const excluded = (source.exclude || []).some(k => haystack.includes(k.toLowerCase()));
  return !excluded;
}

function findConfiguredSource(sources, query) {
  const q = query.trim().toLowerCase();
  return (
    sources.find(s => s.name.toLowerCase() === q) ||
    sources.find(s => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) ||
    sources.find(s => (s.keywords || []).some(k => k.toLowerCase() === q || q.includes(k.toLowerCase()))) ||
    null
  );
}

// word must be a full or prefix match (min 3 chars) of a month name
export function matchMonthName(word) {
  if (!word) return -1;
  const w = word.trim().toLowerCase();
  if (w.length < 3) return -1;
  return MONTH_NAMES.findIndex(m => m === w || m.startsWith(w));
}

function resolveMonthRange(monthName) {
  const now = new Date();
  const idx = matchMonthName(monthName);
  const year = idx > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
  const start = new Date(year, idx, 1);
  const end = new Date(year, idx + 1, 1);
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

// Sends the single most recent matching receipt PDF per source, searching Gmail and Zoho together.
export async function fetchReceiptsForSources(sources, { start, end } = {}) {
  const [gmailCandidates, zohoCandidates] = await Promise.all([
    listGmailReceiptCandidates({ start, end }).catch(err => {
      console.error('❌ Receipts: Gmail lookup failed:', err.message);
      return [];
    }),
    listZohoReceiptCandidates({ start, end }).catch(err => {
      console.error('❌ Receipts: Zoho lookup failed:', err.message);
      return [];
    }),
  ]);

  const candidates = [...gmailCandidates, ...zohoCandidates].sort((a, b) => (b.date || 0) - (a.date || 0));
  console.log(`📬 Receipts: found ${candidates.length} candidate(s) in range (Gmail ${gmailCandidates.length}, Zoho ${zohoCandidates.length})`);

  const found = [];
  const missing = [];
  let sent = 0;

  for (const source of sources) {
    const match = candidates.find(c => sourceMatches(source, c.subject, c.from));
    if (!match) { missing.push(source.name); continue; }

    const sentAny = await match.sendAttachments(source.name);
    if (sentAny) { found.push(source.name); sent++; }
    else missing.push(source.name);
  }

  return { sent, found, missing };
}

export async function fetchReceiptsForMonth(monthName) {
  const targetMonth = monthName || MONTH_NAMES[new Date().getMonth()];
  const { start, end, label } = resolveMonthRange(targetMonth);

  const sources = getReceiptSources().filter(s => s.enabled);
  const result = await fetchReceiptsForSources(sources, { start, end });
  return { ...result, label };
}

// Finds one specific source (configured or ad-hoc) and sends its most recent receipt, any time.
export async function fetchReceiptForSource(query) {
  const sources = getReceiptSources();
  const configured = findConfiguredSource(sources, query);
  const source = configured || { name: query.trim(), keywords: [query.trim().toLowerCase()] };

  const result = await fetchReceiptsForSources([source], {});
  return { sourceName: source.name, found: result.found.length > 0 };
}
