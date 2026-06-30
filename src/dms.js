import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { getSetting, setSetting } from './settings.js';
import { sendAdminMessage, sendMessage, sendFile } from './messaging.js';

const SETTINGS_KEY = 'dms';
const FILES_DIR = './dms-files';

const OPENWA_URL = process.env.OPENWA_API_URL;
const OPENWA_KEY = process.env.OPENWA_API_KEY;
const SESSION_ID = process.env.OPENWA_SESSION_ID;

// In-memory state
let setupState = null;       // { step, data } during setup wizard
let pendingChallenge = null; // { failedAttempts } when awaiting password response
let pendingDisable = false;  // waiting for password to confirm DMS off
let dmsTimer = null;

function getConfig() {
  return getSetting(SETTINGS_KEY, null, null);
}

function saveConfig(config) {
  setSetting(SETTINGS_KEY, config);
}

function parseInterval(text) {
  const match = text.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  if (val < 1) return null;
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? val * 60_000
    : unit === 'h' ? val * 3_600_000
    : val * 86_400_000;
  const label = unit === 'm' ? `${val} minute(s)`
    : unit === 'h' ? `${val} hour(s)`
    : `${val} day(s)`;
  return { ms, label };
}

function isMediaMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const mediaTypes = ['document', 'image', 'video', 'audio', 'ptt', 'sticker'];
  return msg.isMedia === true
    || mediaTypes.includes(msg.type)
    || !!msg.mimetype;
}

async function downloadMedia(msg) {
  mkdirSync(FILES_DIR, { recursive: true });

  // Derive filename from message metadata
  const ext = (msg.mimetype || 'application/octet-stream').split('/').pop().replace(/[^a-z0-9]/gi, '') || 'bin';
  const filename = msg.filename || `dms-payload-${Date.now()}.${ext}`;
  const destPath = join(FILES_DIR, filename);

  // Try: base64 already in the message
  if (msg.base64 || msg.mediaData) {
    const data = Buffer.from(msg.base64 || msg.mediaData, 'base64');
    writeFileSync(destPath, data);
    return { path: destPath, filename, mimetype: msg.mimetype || 'application/octet-stream' };
  }

  const headers = { 'X-API-Key': OPENWA_KEY };

  // Try: openwa download endpoint using message ID
  if (msg.id && OPENWA_URL && SESSION_ID) {
    try {
      const resp = await axios.get(
        `${OPENWA_URL}/sessions/${SESSION_ID}/messages/${msg.id}/download-media`,
        { headers, responseType: 'arraybuffer' }
      );
      writeFileSync(destPath, Buffer.from(resp.data));
      return { path: destPath, filename, mimetype: msg.mimetype || resp.headers['content-type'] || 'application/octet-stream' };
    } catch { /* fall through */ }
  }

  // Try: direct mediaUrl / clientUrl
  const url = msg.mediaUrl || msg.clientUrl;
  if (url) {
    const resp = await axios.get(url, { headers, responseType: 'arraybuffer' });
    writeFileSync(destPath, Buffer.from(resp.data));
    return { path: destPath, filename, mimetype: msg.mimetype || resp.headers['content-type'] || 'application/octet-stream' };
  }

  throw new Error('No media data or download URL found in message');
}

async function triggerDMS() {
  clearDMSTimer();
  pendingChallenge = null;

  const config = getConfig();
  if (!config) return;

  console.log('💀 DMS triggered — sending payload to contact');

  try {
    if (config.filePath) {
      if (!existsSync(config.filePath)) {
        await sendAdminMessage(`💀 DMS triggered but saved file not found: ${config.filePath}`);
        return;
      }
      const base64 = readFileSync(config.filePath).toString('base64');
      const filename = config.filePath.replace(/\\/g, '/').split('/').pop();
      await sendFile(config.contact, base64, filename, config.mimetype || 'application/octet-stream', config.caption || '');
    } else {
      await sendMessage(config.contact, config.message);
    }
    await sendAdminMessage('💀 Dead Man\'s Switch triggered — your message was sent to your contact.');
  } catch (err) {
    console.error('❌ DMS send failed:', err.message);
    await sendAdminMessage(`❌ DMS triggered but failed to send: ${err.message}`);
  }
}

async function sendChallenge() {
  if (pendingChallenge) {
    console.log('💀 DMS: unanswered challenge — triggering');
    await sendAdminMessage('💀 DMS check missed — triggering switch now.');
    await triggerDMS();
    return;
  }

  pendingChallenge = { failedAttempts: 0 };
  await sendAdminMessage(
    '🔐 *Dead Man\'s Switch Check*\n\nReply with your DMS password to confirm you\'re alive.\nYou have until the next interval to respond.\n3 wrong answers will trigger the switch.'
  );
}

function clearDMSTimer() {
  if (dmsTimer) {
    clearInterval(dmsTimer);
    dmsTimer = null;
  }
}

export function scheduleDMSTimer() {
  clearDMSTimer();
  const config = getConfig();
  if (!config?.active) return;
  dmsTimer = setInterval(sendChallenge, config.intervalMs);
  console.log(`💀 DMS active — challenge every ${config.intervalLabel}`);
}

export function initDMS() {
  scheduleDMSTimer();
}

// Returns: string (reply), null (handled — reply sent via sendAdminMessage), false (not DMS-related)
export async function handleDMSMessage(msg) {
  const body = typeof msg === 'string' ? msg : (msg?.body ?? '');
  const text = body.trim();
  const lower = text.toLowerCase();

  // Pending disable confirmation
  if (pendingDisable) {
    const config = getConfig();
    if (text === config?.password) {
      pendingDisable = false;
      clearDMSTimer();
      pendingChallenge = null;
      if (config) saveConfig({ ...config, active: false });
      return '✅ Dead Man\'s Switch disabled.';
    }
    pendingDisable = false;
    return '❌ Wrong password — DMS remains active.';
  }

  // Pending challenge takes priority over everything
  if (pendingChallenge) {
    const config = getConfig();
    if (text === config.password) {
      pendingChallenge = null;
      await sendAdminMessage('✅ DMS check passed. Timer reset.');
      return null;
    }
    pendingChallenge.failedAttempts++;
    if (pendingChallenge.failedAttempts >= 3) {
      await sendAdminMessage('❌ 3 wrong DMS passwords — triggering switch.');
      await triggerDMS();
    } else {
      const rem = 3 - pendingChallenge.failedAttempts;
      await sendAdminMessage(`❌ Wrong DMS password. ${rem} attempt(s) remaining before switch triggers.`);
    }
    return null;
  }

  // Setup wizard intercepts all messages mid-flow
  if (setupState) {
    return handleSetupStep(msg, text);
  }

  // Named DMS commands
  if (/^dms$/i.test(lower) || /^dms setup$/i.test(lower)) {
    setupState = { step: 'password', data: {} };
    const config = getConfig();
    const prefix = config?.active
      ? '⚠️ DMS is already active. This will overwrite the existing config.\n\n'
      : '';
    return `${prefix}💀 *Dead Man\'s Switch Setup*\n\n*Step 1/4 — Password*\nSet the password you\'ll use to confirm you\'re alive when prompted.`;
  }

  if (/^dms (off|disable|cancel|stop)$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is not active.';
    pendingDisable = true;
    return '🔐 Enter your DMS password to disable the switch:';
  }

  if (/^dms status$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is *not active*.';
    const payloadDesc = config.filePath
      ? `📎 File: ${config.filename || config.filePath}`
      : `💬 "${config.message}"`;
    const contact = config.contact.replace(/@.*$/, '');
    return `💀 *DMS Status*\n• Interval: ${config.intervalLabel}\n• Contact: +${contact}\n• Payload: ${payloadDesc}\n• Pending challenge: ${pendingChallenge ? 'Yes' : 'No'}`;
  }

  return false;
}

async function handleSetupStep(msg, text) {
  const { step, data } = setupState;

  if (step === 'password') {
    if (text.length < 4) return '❌ Password must be at least 4 characters. Try again:';
    data.password = text;
    setupState.step = 'timeframe';
    return '✅ Password set.\n\n*Step 2/4 — Check Interval*\nHow often should I ping you?\n\nExamples: `1d` (daily), `12h` (every 12 hours), `30m` (every 30 min)';
  }

  if (step === 'timeframe') {
    const parsed = parseInterval(text);
    if (!parsed) return '❌ Couldn\'t parse that. Use `1d`, `12h`, `2h`, `30m`, etc. Try again:';
    data.intervalMs = parsed.ms;
    data.intervalLabel = parsed.label;
    setupState.step = 'payload';
    return `✅ Interval: ${parsed.label}.\n\n*Step 3/4 — Payload*\nWhat should be sent if the switch triggers?\n\n• Send a *text message* to use it as-is\n• Send a *file* (document, image, etc.) and I\'ll save it to the server`;
  }

  if (step === 'payload') {
    if (isMediaMessage(msg)) {
      await sendAdminMessage('⏳ Downloading and saving your file...');
      try {
        const { path, filename, mimetype } = await downloadMedia(msg);
        data.filePath = path;
        data.filename = filename;
        data.mimetype = mimetype;
        data.message = null;
        setupState.step = 'caption';
        return `✅ File saved: *${filename}*\n\n*Step 3b/4 — Caption (optional)*\nReply with a caption for the file, or send \`-\` to skip.`;
      } catch (err) {
        console.error('❌ DMS media download failed:', err.message);
        return `❌ Couldn\'t download the file: ${err.message}\n\nTry again, or reply with a text message instead:`;
      }
    }

    if (!text) return '❌ Please send a text message or a file:';
    data.message = text;
    data.filePath = null;
    data.filename = null;
    data.mimetype = null;
    setupState.step = 'contact';
    return '✅ Message saved.\n\n*Step 4/4 — Contact*\nWho should receive it if the switch triggers?\n\nReply with a phone number (e.g. `972501234567`) or *send a WhatsApp contact card*.';
  }

  if (step === 'caption') {
    data.caption = text === '-' ? '' : text;
    setupState.step = 'contact';
    return '✅ Caption saved.\n\n*Step 4/4 — Contact*\nWho should receive the file if the switch triggers?\n\nReply with a phone number (e.g. `972501234567`) or *send a WhatsApp contact card*.';
  }

  if (step === 'contact') {
    let digits;

    if (msg?.type === 'vcard' && text) {
      // Extract waid (WhatsApp ID) from vCard TEL line — most reliable
      const waidMatch = text.match(/waid=(\d+)/i);
      if (waidMatch) {
        digits = waidMatch[1];
      } else {
        // Fall back to first TEL number in the vCard
        const telMatch = text.match(/^TEL[^:]*:(.+)$/im);
        digits = telMatch ? telMatch[1].replace(/\D/g, '') : '';
      }
      if (!digits || digits.length < 7) return '❌ Couldn\'t read a phone number from that contact card. Try another or type the number manually:';
    } else {
      digits = text.replace(/\D/g, '');
      if (digits.length < 7) return '❌ Doesn\'t look like a valid phone number. Include the country code (e.g. `972501234567`). Try again:';
    }

    data.contact = `${digits}@c.us`;

    const config = {
      active: true,
      password: data.password,
      intervalMs: data.intervalMs,
      intervalLabel: data.intervalLabel,
      message: data.message || null,
      filePath: data.filePath || null,
      filename: data.filename || null,
      mimetype: data.mimetype || null,
      caption: data.caption || '',
      contact: data.contact,
    };

    saveConfig(config);
    setupState = null;
    scheduleDMSTimer();

    const payloadDesc = data.filePath
      ? `📎 File: *${data.filename}*${data.caption ? ` (caption: "${data.caption}")` : ''}`
      : `💬 Message: "${data.message}"`;

    return `✅ *Dead Man\'s Switch is now active!*\n\n• Ping interval: ${data.intervalLabel}\n• Contact: +${digits}\n• ${payloadDesc}\n\nYou\'ll get a password challenge every ${data.intervalLabel}. Reply correctly to reset the timer.`;
  }

  return false;
}
