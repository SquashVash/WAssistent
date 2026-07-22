import axios from 'axios';
import { sendMessage } from './messaging.js';
import { getSetting, setSetting } from './settings.js';

const CD_BASE = process.env.CHANGEDETECTION_URL || 'http://127.0.0.1:5000';
const CD_KEY = process.env.CHANGEDETECTION_API_KEY;
const CALLBACK_HOST = process.env.CHANGEDETECTION_CALLBACK_HOST || 'host.docker.internal';
const CALLBACK_PORT = process.env.WEBHOOK_PORT || process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.CHANGEDETECTION_WEBHOOK_TOKEN;

const DIFF_LIMIT = 1500;

const api = axios.create({
  baseURL: `${CD_BASE}/api/v1`,
  headers: { 'x-api-key': CD_KEY },
  timeout: 20000,
});

// Apprise `json://` posts {version, title, message, type}; `+param` becomes an HTTP header.
function notificationUrl() {
  return `json://${CALLBACK_HOST}:${CALLBACK_PORT}/webhook/changedetection?+X-CD-Token=${WEBHOOK_TOKEN}`;
}

const NOTIFY_BODY = '{{watch_title}}\n{{watch_url}}\n{{diff_url}}\n---\n{{diff}}';

// ─── API wrappers ─────────────────────────────────────────────────

export async function cdList() {
  const { data } = await api.get('/watch');
  return data && typeof data === 'object' ? data : {};
}

export async function cdCreate(url, { title, minutes }) {
  const { data } = await api.post('/watch', {
    url,
    title: title || url,
    time_between_check: { hours: 0, minutes, seconds: 0 },
    // Without this, changedetection ignores time_between_check and uses the global interval
    time_between_check_use_default: false,
    notification_format: 'text',
    notification_title: '{{watch_title}}',
    notification_body: NOTIFY_BODY,
    notification_urls: [notificationUrl()],
  });
  return data;
}

export async function cdDelete(uuid) {
  await api.delete(`/watch/${uuid}`);
}

export async function cdRecheck(uuid) {
  await api.get(`/watch/${uuid}`, { params: { recheck: 1 } });
}

export async function cdSetPaused(uuid, paused) {
  await api.get(`/watch/${uuid}`, { params: { paused: paused ? 'paused' : 'unpaused' } });
}

export async function cdHistory(uuid) {
  const { data } = await api.get(`/watch/${uuid}/history`);
  return data && typeof data === 'object' ? data : {};
}

export async function cdDiff(uuid, from, to) {
  const { data } = await api.get(`/watch/${uuid}/difference/${from}/${to}`, {
    params: { format: 'text' },
  });
  return typeof data === 'string' ? data : JSON.stringify(data);
}

export async function testChangedetectionConnection() {
  if (!CD_KEY) return { ok: false, detail: 'CHANGEDETECTION_API_KEY not set' };
  try {
    const { data } = await api.get('/systeminfo');
    const count = Object.keys(await cdList()).length;
    const version = data?.version ? ` v${data.version}` : '';
    return { ok: true, detail: `connected${version} — ${count} watch(es)` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// ─── Index → uuid resolution ──────────────────────────────────────
// `watch list` numbering must stay stable across commands, so every
// lookup goes through the same sort.

function sortedWatches(watches) {
  return Object.entries(watches)
    .map(([uuid, w]) => ({ uuid, ...w }))
    .sort((a, b) => (a.title || a.url || '').localeCompare(b.title || b.url || ''));
}

async function resolveWatch(n) {
  const list = sortedWatches(await cdList());
  if (!list.length) return { error: '👁️ No watches configured. Add one with `watch add <url>`.' };
  const w = list[n - 1];
  if (!w) return { error: `❌ No watch #${n}. You have ${list.length} watch(es) — see \`watch list\`.` };
  return { watch: w };
}

// ─── Settings ─────────────────────────────────────────────────────

export function getWatchDefaultMinutes() {
  return parseInt(getSetting('watchDefaultMinutes', 'CHANGEDETECTION_CHECK_MINUTES', '60'), 10) || 60;
}

export function setWatchDefaultMinutes(minutes) {
  setSetting('watchDefaultMinutes', minutes);
}

export async function getWatchCount() {
  try {
    return Object.keys(await cdList()).length;
  } catch {
    return null;
  }
}

// ─── Incoming change notification ─────────────────────────────────

export async function handleChangeNotification(payload) {
  const message = payload?.message ?? payload?.body ?? '';
  const [head = '', diff = ''] = String(message).split('\n---\n');
  const [title, url] = head.split('\n').map(s => s.trim());

  const lines = [`🔔 *Change detected — ${title || 'watch'}*`];
  if (url) lines.push(url);

  const trimmed = diff.trim();
  if (trimmed) {
    const body = trimmed.length > DIFF_LIMIT ? `${trimmed.slice(0, DIFF_LIMIT)}\n…(truncated)` : trimmed;
    lines.push('', '```', body, '```');
  }

  await sendMessage(process.env.MY_CHAT_ID, lines.join('\n'));
  console.log(`👁️ Change notification relayed: ${title || url || '(unknown watch)'}`);
}

// ─── Formatting ───────────────────────────────────────────────────

function formatAge(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - ts * 1000;
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatList(list) {
  const lines = list.map((w, i) => {
    const icon = w.paused ? '⏸️' : '🟢';
    const changed = formatAge(w.last_changed);
    const checked = formatAge(w.last_checked);
    const err = w.last_error ? `\n   ❌ ${String(w.last_error).slice(0, 120)}` : '';
    return `${i + 1}. ${icon} *${w.title || w.url}*\n   ${w.url}\n   changed ${changed} · checked ${checked}${err}`;
  });
  return `*👁️ Web Watches*\n\n${lines.join('\n\n')}`;
}

// ─── Command dispatcher ───────────────────────────────────────────

export async function handleWatchCommand(text) {
  const rest = text.trim().replace(/^watch\b\s*/i, '').trim();

  if (!CD_KEY) return '❌ changedetection.io not configured — set `CHANGEDETECTION_API_KEY` in .env.';

  try {
    if (!rest || /^list$/i.test(rest)) {
      const list = sortedWatches(await cdList());
      if (!list.length) return '👁️ No watches configured. Add one with `watch add <url>`.';
      return formatList(list);
    }

    const addMatch = rest.match(/^add\s+(\S+)(?:\s+every\s+(\d+)\s*(m|h)?)?$/i);
    if (addMatch) {
      const url = addMatch[1];
      if (!/^https?:\/\//i.test(url)) return '❌ URL must start with http:// or https://';
      const minutes = addMatch[2]
        ? (addMatch[3]?.toLowerCase() === 'h' ? parseInt(addMatch[2], 10) * 60 : parseInt(addMatch[2], 10))
        : getWatchDefaultMinutes();
      if (minutes < 1) return '❌ Check interval must be at least 1 minute.';
      await cdCreate(url, { minutes });
      return `👁️ Now watching ${url}\nChecking every ${minutes} min — you'll get a message when it changes.`;
    }

    const removeMatch = rest.match(/^(?:remove|delete|rm)\s+(\d+)$/i);
    if (removeMatch) {
      const { watch, error } = await resolveWatch(parseInt(removeMatch[1], 10));
      if (error) return error;
      await cdDelete(watch.uuid);
      return `✅ Stopped watching *${watch.title || watch.url}*.`;
    }

    const pauseMatch = rest.match(/^(pause|resume|unpause)\s+(\d+)$/i);
    if (pauseMatch) {
      const paused = /^pause$/i.test(pauseMatch[1]);
      const { watch, error } = await resolveWatch(parseInt(pauseMatch[2], 10));
      if (error) return error;
      await cdSetPaused(watch.uuid, paused);
      return `${paused ? '⏸️ Paused' : '🟢 Resumed'} *${watch.title || watch.url}*.`;
    }

    const checkMatch = rest.match(/^(?:check|recheck)\s+(\d+)$/i);
    if (checkMatch) {
      const { watch, error } = await resolveWatch(parseInt(checkMatch[1], 10));
      if (error) return error;
      await cdRecheck(watch.uuid);
      return `🔄 Rechecking *${watch.title || watch.url}* now — you'll be messaged if anything changed.`;
    }

    const diffMatch = rest.match(/^diff\s+(\d+)$/i);
    if (diffMatch) {
      const { watch, error } = await resolveWatch(parseInt(diffMatch[1], 10));
      if (error) return error;
      const stamps = Object.keys(await cdHistory(watch.uuid)).sort();
      if (stamps.length < 2) return `👁️ *${watch.title || watch.url}* has no changes recorded yet.`;
      const diff = (await cdDiff(watch.uuid, stamps[stamps.length - 2], stamps[stamps.length - 1])).trim();
      if (!diff) return `👁️ No textual difference in the last change of *${watch.title || watch.url}*.`;
      const body = diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n…(truncated)` : diff;
      return `👁️ *Latest diff — ${watch.title || watch.url}*\n\`\`\`\n${body}\n\`\`\``;
    }

    if (/^interval$/i.test(rest)) {
      return `👁️ Default watch interval: every ${getWatchDefaultMinutes()} min`;
    }

    const intervalMatch = rest.match(/^(?:set\s+)?interval\s+(\d+)\s*(m|h)?$/i);
    if (intervalMatch) {
      const value = parseInt(intervalMatch[1], 10);
      const minutes = (intervalMatch[2] || 'm').toLowerCase() === 'h' ? value * 60 : value;
      if (minutes < 1) return '❌ Interval must be at least 1 minute.';
      setWatchDefaultMinutes(minutes);
      return `✅ Default watch interval set to ${minutes} min (applies to new watches).`;
    }

    return `❌ Unknown watch command.\n\n${watchHelp()}`;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    return `❌ changedetection.io error: ${detail}`;
  }
}

export function watchHelp() {
  return `*👁️ Web Watches*
Monitor any page and get a message the moment it changes.
• \`watch add <url>\` — start watching a page
• \`watch add <url> every 30m\` — watch with a custom interval (e.g. 15m, 6h)
• \`watch list\` — numbered list with status and last change
• \`watch remove <n>\` — stop watching
• \`watch pause <n>\` / \`watch resume <n>\` — pause or resume checking
• \`watch check <n>\` — force a recheck right now
• \`watch diff <n>\` — show the latest diff
• \`watch interval\` — show the default interval for new watches
• \`watch set interval 30m\` — change the default interval`;
}
