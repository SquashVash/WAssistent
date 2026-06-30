import { getSetting, setSetting } from './settings.js';
import { sendAdminMessage, sendMessage } from './messaging.js';

const SETTINGS_KEY = 'dms';

// In-memory state
let setupState = null;       // { step, data } during setup wizard
let pendingChallenge = null; // { failedAttempts } when awaiting password response
let pendingDisable = false;  // waiting for password to confirm DMS disable
let pendingAction = null;    // { type: 'pause'|'sleep'|'start', parsed? } awaiting password
let dmsTimer = null;
let sleepTimer = null;       // setTimeout handle for auto-resume after sleep

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

async function triggerDMS() {
  clearDMSTimer();
  clearSleepTimer();
  pendingChallenge = null;

  const config = getConfig();
  if (!config) return;

  console.log('💀 DMS triggered — sending message to contact');

  try {
    await sendMessage(config.contact, config.message);
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

function clearSleepTimer() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
}

async function resumeFromSleep() {
  clearSleepTimer();
  const config = getConfig();
  if (!config?.active) return;
  saveConfig({ ...config, paused: false, sleepUntil: null });
  scheduleDMSTimer();
  await sendAdminMessage('⏰ DMS sleep period ended — switch is active again.');
}

export function scheduleDMSTimer() {
  clearDMSTimer();
  const config = getConfig();
  if (!config?.active || config?.paused) return;
  dmsTimer = setInterval(sendChallenge, config.intervalMs);
  console.log(`💀 DMS active — challenge every ${config.intervalLabel}`);
}

export function initDMS() {
  const config = getConfig();
  if (!config?.active) return;

  if (config.paused && config.sleepUntil) {
    const remaining = config.sleepUntil - Date.now();
    if (remaining > 0) {
      // Still sleeping — restore the wake-up timer
      console.log(`💤 DMS sleeping — resuming in ${Math.round(remaining / 60_000)} min`);
      sleepTimer = setTimeout(resumeFromSleep, remaining);
    } else {
      // Sleep expired while bot was offline — resume now
      resumeFromSleep();
    }
  } else {
    scheduleDMSTimer();
  }
}

// Returns: string (reply), null (handled — reply sent via sendAdminMessage), false (not DMS-related)
export async function handleDMSMessage(msg) {
  const body = typeof msg === 'string' ? msg : (msg?.body ?? '');
  const text = body.trim();
  const lower = text.toLowerCase();

  // Pending password confirmation (disable / pause / sleep / start)
  if (pendingDisable || pendingAction) {
    if (/^cancel$/i.test(lower)) {
      pendingDisable = false;
      pendingAction = null;
      return '❌ Cancelled — DMS unchanged.';
    }
    const config = getConfig();
    const correct = text === config?.password;

    if (pendingDisable) {
      pendingDisable = false;
      if (!correct) return '❌ Wrong password — DMS remains active.';
      clearDMSTimer();
      clearSleepTimer();
      pendingChallenge = null;
      saveConfig({ ...config, active: false, paused: false, sleepUntil: null });
      return '✅ Dead Man\'s Switch disabled.';
    }

    if (pendingAction) {
      const action = pendingAction;
      pendingAction = null;
      if (!correct) return '❌ Wrong password — DMS unchanged.';

      if (action.type === 'pause') {
        clearDMSTimer();
        clearSleepTimer();
        pendingChallenge = null;
        saveConfig({ ...config, paused: true, sleepUntil: null });
        return '⏸ Dead Man\'s Switch paused. Send `DMS start` to resume.';
      }

      if (action.type === 'sleep') {
        clearDMSTimer();
        clearSleepTimer();
        pendingChallenge = null;
        const sleepUntil = Date.now() + action.parsed.ms;
        saveConfig({ ...config, paused: true, sleepUntil });
        sleepTimer = setTimeout(resumeFromSleep, action.parsed.ms);
        return `💤 DMS sleeping for ${action.parsed.label}. Switch will auto-resume after that.`;
      }

      if (action.type === 'start') {
        clearSleepTimer();
        saveConfig({ ...config, paused: false, sleepUntil: null });
        scheduleDMSTimer();
        return '▶️ Dead Man\'s Switch resumed.';
      }
    }
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
    if (/^cancel$/i.test(lower)) {
      setupState = null;
      return '❌ DMS setup cancelled.';
    }
    return handleSetupStep(msg, text);
  }

  // Named DMS commands
  if (/^dms$/i.test(lower) || /^dms setup$/i.test(lower)) {
    setupState = { step: 'password', data: {} };
    const config = getConfig();
    const prefix = config?.active
      ? '⚠️ DMS is already active. This will overwrite the existing config.\n\n'
      : '';
    return `${prefix}💀 *Dead Man\'s Switch Setup*\n\n*Step 1/4 — Password*\nSet the password you\'ll use to confirm you\'re alive when prompted.\n\nSend \`cancel\` at any time to abort.`;
  }

  if (/^dms disable$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is not active.';
    pendingDisable = true;
    return '🔐 Enter your DMS password to disable the switch:';
  }

  if (/^dms pause$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is not active.';
    if (config.paused) return '⏸ DMS is already paused. Send `DMS start` to resume.';
    pendingAction = { type: 'pause' };
    return '🔐 Enter your DMS password to pause the switch:';
  }

  if (/^dms sleep (.+)$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is not active.';
    const sleepArg = lower.match(/^dms sleep (.+)$/i)[1].trim();
    const parsed = parseInterval(sleepArg);
    if (!parsed) return '❌ Couldn\'t parse sleep duration. Use `1d`, `12h`, `2h`, `30m`, etc.';
    pendingAction = { type: 'sleep', parsed };
    return `🔐 Enter your DMS password to sleep for ${parsed.label}:`;
  }

  if (/^dms start$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is not active.';
    if (!config.paused) return '▶️ DMS is already running.';
    pendingAction = { type: 'start' };
    return '🔐 Enter your DMS password to resume the switch:';
  }

  if (/^dms status$/i.test(lower)) {
    const config = getConfig();
    if (!config?.active) return '💀 Dead Man\'s Switch is *not active*.';
    const contact = config.contact.replace(/@.*$/, '');
    let stateLabel;
    if (config.paused && config.sleepUntil) {
      const remaining = Math.max(0, Math.round((config.sleepUntil - Date.now()) / 60_000));
      stateLabel = `💤 Sleeping (${remaining} min remaining)`;
    } else if (config.paused) {
      stateLabel = '⏸ Paused';
    } else {
      stateLabel = `▶️ Running (challenge every ${config.intervalLabel})`;
    }
    return `💀 *DMS Status*\n• State: ${stateLabel}\n• Contact: +${contact}\n• Message: "${config.message}"\n• Pending challenge: ${pendingChallenge ? 'Yes' : 'No'}`;
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
    return `✅ Interval: ${parsed.label}.\n\n*Step 3/4 — Message*\nWhat message should be sent to your contact if the switch triggers?`;
  }

  if (step === 'payload') {
    if (!text) return '❌ Please send a text message:';
    data.message = text;
    setupState.step = 'contact';
    return '✅ Message saved.\n\n*Step 4/4 — Contact*\nWho should receive it if the switch triggers?\n\nReply with a phone number (e.g. `972501234567`) or *send a WhatsApp contact card*.';
  }

  if (step === 'contact') {
    let digits;

    if ((msg?.type === 'vcard' || text.trimStart().startsWith('BEGIN:VCARD')) && text) {
      const waidMatch = text.match(/waid=(\d+)/i);
      if (waidMatch) {
        digits = waidMatch[1];
      } else {
        const telMatch = text.match(/^TEL[^:]*:(.+)$/im);
        digits = telMatch ? telMatch[1].replace(/\D/g, '') : '';
      }
      if (!digits || digits.length < 7) return '❌ Couldn\'t read a phone number from that contact card. Try another or type the number manually:';
    } else {
      digits = text.replace(/\D/g, '');
      if (digits.length < 7) return '❌ Doesn\'t look like a valid phone number. Include the country code (e.g. `972501234567`). Try again:';
    }

    data.contact = `${digits}@c.us`;

    saveConfig({
      active: true,
      paused: false,
      sleepUntil: null,
      password: data.password,
      intervalMs: data.intervalMs,
      intervalLabel: data.intervalLabel,
      message: data.message,
      contact: data.contact,
    });

    setupState = null;
    scheduleDMSTimer();

    return `✅ *Dead Man\'s Switch is now active!*\n\n• Ping interval: ${data.intervalLabel}\n• Contact: +${digits}\n• Message: "${data.message}"\n\nYou\'ll get a password challenge every ${data.intervalLabel}. Reply correctly to reset the timer.`;
  }

  return false;
}
