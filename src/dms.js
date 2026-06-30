import { existsSync, readFileSync } from 'fs';
import { getSetting, setSetting } from './settings.js';
import { sendAdminMessage, sendMessage, sendFile } from './messaging.js';

const SETTINGS_KEY = 'dms';

// In-memory state
let setupState = null;      // { step, data } during setup wizard
let pendingChallenge = null; // { failedAttempts } when awaiting password response
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

function getMimeType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mimes = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    zip: 'application/zip',
  };
  return mimes[ext] || 'application/octet-stream';
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
        await sendAdminMessage(`💀 DMS triggered but file not found: ${config.filePath}`);
        return;
      }
      const base64 = readFileSync(config.filePath).toString('base64');
      const filename = config.filePath.replace(/\\/g, '/').split('/').pop();
      const mimetype = getMimeType(filename);
      await sendFile(config.contact, base64, filename, mimetype, config.caption || '');
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
    // Previous challenge never answered → trigger
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

// Returns: string (reply), null (handled, no reply), false (not DMS-related)
export async function handleDMSMessage(body) {
  const text = body.trim();
  const lower = text.toLowerCase();

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
    return handleSetupStep(text);
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
    clearDMSTimer();
    pendingChallenge = null;
    const config = getConfig();
    if (config) saveConfig({ ...config, active: false });
    return '✅ Dead Man\'s Switch disabled.';
  }

  if (/^dms status$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is *not active*.';
    const payloadDesc = config.filePath ? `📎 File: ${config.filePath}` : `💬 "${config.message}"`;
    const contact = config.contact.replace(/@.*$/, '');
    return `💀 *DMS Status*\n• Interval: ${config.intervalLabel}\n• Contact: +${contact}\n• Payload: ${payloadDesc}\n• Pending challenge: ${pendingChallenge ? 'Yes' : 'No'}`;
  }

  return false;
}

async function handleSetupStep(text) {
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
    return `✅ Interval: ${parsed.label}.\n\n*Step 3/4 — Payload*\nWhat should be sent if the switch triggers?\n\n• Reply with a *text message* to send as-is\n• Reply with a *local file path* (e.g. \`C:\\docs\\letter.pdf\`) to send a file`;
  }

  if (step === 'payload') {
    const looksLikePath = /^([A-Za-z]:[/\\]|\/|\.\.?[/\\])/.test(text);
    if (looksLikePath) {
      if (!existsSync(text)) {
        return `❌ File not found at "${text}". Fix the path or reply with a text message instead:`;
      }
      data.filePath = text;
      data.message = null;
      data.caption = '';
      setupState.step = 'caption';
      return '✅ File saved.\n\n*Step 3b/4 — Caption (optional)*\nReply with a caption for the file, or send `-` to skip.';
    }
    data.message = text;
    data.filePath = null;
    setupState.step = 'contact';
    return '✅ Message saved.\n\n*Step 4/4 — Contact*\nWho should receive the message if the switch triggers?\n\nReply with a phone number including country code (e.g. `972501234567`).';
  }

  if (step === 'caption') {
    data.caption = text === '-' ? '' : text;
    setupState.step = 'contact';
    return '✅ Caption saved.\n\n*Step 4/4 — Contact*\nWho should receive the file if the switch triggers?\n\nReply with a phone number including country code (e.g. `972501234567`).';
  }

  if (step === 'contact') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 7) return '❌ Doesn\'t look like a valid phone number. Include the country code (e.g. `972501234567`). Try again:';
    data.contact = `${digits}@c.us`;

    const config = {
      active: true,
      password: data.password,
      intervalMs: data.intervalMs,
      intervalLabel: data.intervalLabel,
      message: data.message || null,
      filePath: data.filePath || null,
      caption: data.caption || '',
      contact: data.contact,
    };

    saveConfig(config);
    setupState = null;
    scheduleDMSTimer();

    const payloadDesc = data.filePath
      ? `📎 File: ${data.filePath}${data.caption ? ` (caption: "${data.caption}")` : ''}`
      : `💬 Message: "${data.message}"`;

    return `✅ *Dead Man\'s Switch is now active!*\n\n• Ping interval: ${data.intervalLabel}\n• Contact: +${digits}\n• ${payloadDesc}\n\nYou\'ll get a password challenge every ${data.intervalLabel}. Reply correctly to reset the timer.`;
  }

  return false;
}
