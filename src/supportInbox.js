import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { getZohoAccount, openZohoClient, describeImapError } from './zoho.js';
import { suggestSupportReply } from './ai.js';
import { sendMessage } from './messaging.js';
import { getSetting, setSetting } from './settings.js';

const DEFAULT_POLL_MINUTES = 15;

let pollTimer = null;
// UIDs we've already notified about, so unread emails don't re-trigger a message every poll.
const notifiedUids = new Set();

// In-memory reply-flow state: { account, uids, index, current, stats }
let flowState = null;

export function getSupportPollMinutes() {
  return parseInt(getSetting('supportPollMinutes', 'SUPPORT_POLL_MINUTES', DEFAULT_POLL_MINUTES), 10);
}

export function setSupportPollInterval(minutes) {
  setSetting('supportPollMinutes', minutes);
  startSupportInboxWatcher();
}

// ---- IMAP helpers (scoped to the support@ account) ----

async function withSupportClient(fn) {
  const account = getZohoAccount('support');
  if (!account) throw new Error('ZOHO_PASSWORD_SUPPORT not set');

  const client = await openZohoClient(account);
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function listUnseenUids() {
  // search() returns sequence numbers unless uid:true is passed — everything downstream
  // (download/messageFlagsAdd/messageMove) expects real UIDs.
  return withSupportClient(client => client.search({ seen: false }, { uid: true }));
}

async function fetchEmail(uid) {
  return withSupportClient(async (client) => {
    const { content } = await client.download(uid, undefined, { uid: true });
    const parsed = await simpleParser(content);
    return {
      uid,
      subject: parsed.subject || '(no subject)',
      from: parsed.from?.text || '',
      fromAddress: parsed.from?.value?.[0]?.address || '',
      text: (parsed.text || parsed.html || '').toString().trim(),
      messageId: parsed.messageId,
    };
  });
}

async function markSeen(uid) {
  return withSupportClient(client => client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }));
}

async function moveToTrash(uid) {
  return withSupportClient(async (client) => {
    const mailboxes = await client.list();
    const trash = mailboxes.find(mb => mb.specialUse === '\\Trash') || mailboxes.find(mb => /trash/i.test(mb.name));
    if (trash) {
      await client.messageMove(uid, trash.path, { uid: true });
    } else {
      await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
      await client.messageDelete(uid, { uid: true });
    }
  });
}

// ---- SMTP (sending replies) ----

function getSmtpTransport(account) {
  // Port 465 (implicit TLS) is the default, but some hosts block it while leaving 587
  // (STARTTLS) open — set ZOHO_SMTP_PORT=587 to try the alternative.
  const port = parseInt(process.env.ZOHO_SMTP_PORT || '465', 10);
  return nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com',
    port,
    secure: port === 465,
    auth: { user: account.email, pass: account.password },
    // Fail fast instead of nodemailer's default 2-minute connection timeout — if the
    // network/port is blocked (common on some VPS hosts), we want a quick, clear error.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

async function sendReply(account, email, replyText) {
  const transport = getSmtpTransport(account);
  const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
  await transport.sendMail({
    from: account.email,
    to: email.fromAddress || email.from,
    subject,
    text: replyText,
    inReplyTo: email.messageId,
    references: email.messageId,
  });
}

// Verifies SMTP login/connectivity without sending an email — for the `status` command.
export async function testSmtpConnection() {
  const account = getZohoAccount('support');
  if (!account) return { ok: false, detail: 'ZOHO_PASSWORD_SUPPORT not set' };

  const transport = getSmtpTransport(account);
  try {
    await transport.verify();
    const port = parseInt(process.env.ZOHO_SMTP_PORT || '465', 10);
    return { ok: true, detail: `${account.email} via ${process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com'}:${port}` };
  } catch (err) {
    return { ok: false, detail: err.code ? `${err.code}: ${err.message}` : err.message };
  }
}

// ---- Reply flow ----

function truncate(text, max = 800) {
  const t = text.replace(/\r\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const OPTIONS_HINT = 'Options: `send` · `adjust <feedback>` · `edit <text>` · `delete` · `ignore` · `cancel`';

async function presentCurrent() {
  if (flowState.index >= flowState.uids.length) {
    const { sent, deleted, ignored } = flowState.stats;
    const summary = `✅ *Support reply flow complete*\nSent: ${sent} · Deleted: ${deleted} · Ignored: ${ignored}`;
    flowState = null;
    return summary;
  }

  const uid = flowState.uids[flowState.index];

  let email, draft;
  try {
    email = await fetchEmail(uid);
    draft = await suggestSupportReply(email);
  } catch (err) {
    flowState = null;
    return `❌ Failed to load the next email: ${err.message}\n\nSend \`support reply\` to try again.`;
  }

  flowState.current = { ...email, draft };

  const pos = flowState.index + 1;
  const total = flowState.uids.length;
  return `📧 *Support Email (${pos}/${total})*\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${truncate(email.text)}\n\n💬 *Suggested reply:*\n${draft}\n\n${OPTIONS_HINT}`;
}

async function startFlow() {
  if (flowState) return '⚠️ A support reply flow is already in progress. Send `cancel` to stop it first.';

  const account = getZohoAccount('support');
  if (!account) return '❌ Zoho support account not configured (ZOHO_PASSWORD_SUPPORT missing).';

  let uids;
  try {
    uids = (await listUnseenUids()).sort((a, b) => a - b);
  } catch (err) {
    return `❌ Couldn't check the support inbox: ${describeImapError(err)}`;
  }

  if (!uids.length) return '📭 No unread support emails.';

  flowState = { account, uids, index: 0, current: null, stats: { sent: 0, deleted: 0, ignored: 0 } };
  return presentCurrent();
}

async function advanceFlow(action, arg) {
  const { current, account } = flowState;

  if (action === 'cancel') {
    const remaining = flowState.uids.length - flowState.index;
    flowState = null;
    return `❌ Reply flow cancelled. ${remaining} email(s) still unread.`;
  }

  if (action === 'send') {
    try {
      await sendReply(account, current, current.draft);
      await markSeen(current.uid);
    } catch (err) {
      return `❌ Failed to send reply: ${err.message}\n\nThe draft is unchanged — try \`send\` again, or \`adjust\`/\`edit\` it first.`;
    }
    flowState.stats.sent++;
    flowState.index++;
    return `✅ Reply sent.\n\n${await presentCurrent()}`;
  }

  if (action === 'adjust') {
    if (!arg) return '❌ Tell me what to adjust, e.g. `adjust make it more formal`.';
    try {
      current.draft = await suggestSupportReply(current, { previousDraft: current.draft, feedback: arg });
    } catch (err) {
      return `❌ Failed to generate a revised draft: ${err.message}`;
    }
    return `💬 *Updated reply:*\n${current.draft}\n\n${OPTIONS_HINT}`;
  }

  if (action === 'edit') {
    if (!arg) return '❌ Send the exact reply text after `edit`.';
    current.draft = arg;
    return `💬 *Updated reply:*\n${current.draft}\n\n${OPTIONS_HINT}`;
  }

  if (action === 'delete') {
    try {
      await moveToTrash(current.uid);
    } catch (err) {
      return `❌ Failed to delete email: ${err.message}\n\nTry \`delete\` again, or \`ignore\` to move on.`;
    }
    flowState.stats.deleted++;
    flowState.index++;
    return `🗑️ Email moved to Trash.\n\n${await presentCurrent()}`;
  }

  if (action === 'ignore') {
    try {
      await markSeen(current.uid);
    } catch (err) {
      return `❌ Failed to mark email as read: ${err.message}\n\nTry \`ignore\` again.`;
    }
    flowState.stats.ignored++;
    flowState.index++;
    return `⏭️ Skipped.\n\n${await presentCurrent()}`;
  }

  return null;
}

async function manualCheck() {
  const account = getZohoAccount('support');
  if (!account) return '❌ Zoho support account not configured (ZOHO_PASSWORD_SUPPORT missing).';

  try {
    const uids = await listUnseenUids();
    if (!uids.length) return '📭 No unread support emails.';
    return `📬 ${uids.length} unread support email(s). Send \`support reply\` to go through them.`;
  } catch (err) {
    return `❌ Support inbox check failed: ${describeImapError(err)}`;
  }
}

// ---- Chat command entry point ----

export async function handleSupportMessage(msg) {
  try {
    return await routeSupportMessage(msg);
  } catch (err) {
    // Last-resort safety net: an uncaught throw here would otherwise be swallowed
    // by webhook.js's outer catch and never reach the user as a reply.
    console.error('❌ Support inbox command failed:', err.message);
    return `❌ Something went wrong: ${err.message}`;
  }
}

async function routeSupportMessage(msg) {
  const body = typeof msg === 'string' ? msg : (msg?.body ?? '');
  const text = body.trim();
  const lower = text.toLowerCase();

  // Active reply flow intercepts everything until it's finished or cancelled.
  if (flowState) {
    if (/^cancel$/i.test(lower)) return advanceFlow('cancel');
    if (/^send$/i.test(lower)) return advanceFlow('send');
    if (/^delete$/i.test(lower)) return advanceFlow('delete');
    if (/^ignore$/i.test(lower)) return advanceFlow('ignore');

    const adjustMatch = text.match(/^adjust\s+(.+)$/i);
    if (adjustMatch) return advanceFlow('adjust', adjustMatch[1].trim());

    const editMatch = text.match(/^edit\s+(.+)$/i);
    if (editMatch) return advanceFlow('edit', editMatch[1].trim());

    return `❓ Didn't recognize that.\n${OPTIONS_HINT}`;
  }

  if (/^support reply$/i.test(lower)) return startFlow();
  if (/^support check$/i.test(lower)) return manualCheck();

  if (/^support interval$/i.test(lower)) {
    return `📬 Support inbox check interval: every ${getSupportPollMinutes()} min`;
  }

  const intervalMatch = lower.match(/^set support interval (\d+)(m|h)?$/i);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = (intervalMatch[2] || 'm').toLowerCase();
    const minutes = unit === 'h' ? value * 60 : value;
    if (minutes < 1) return '❌ Interval must be at least 1 minute.';
    setSupportPollInterval(minutes);
    return `✅ Support inbox check interval set to ${minutes} min.`;
  }

  return false;
}

// ---- Background poller ----

// Diffs the current unread UIDs against what's already been notified about, marking
// the new ones as notified. Shared by the background poller and the `scan` command
// so they don't both announce the same unread emails.
async function getNewUnreadSupportEmails() {
  const uids = await listUnseenUids();
  const newUids = uids.filter(uid => !notifiedUids.has(uid));
  newUids.forEach(uid => notifiedUids.add(uid));
  return { total: uids.length, newCount: newUids.length };
}

async function checkSupportInbox() {
  const account = getZohoAccount('support');
  if (!account) return;

  let result;
  try {
    result = await getNewUnreadSupportEmails();
  } catch (err) {
    console.error('❌ Support inbox check failed:', describeImapError(err));
    return;
  }

  if (!result.newCount) return;

  const suffix = result.newCount < result.total ? ` (${result.newCount} new)` : '';
  await sendMessage(
    process.env.MY_CHAT_ID,
    `📬 *Support Inbox*\nYou have ${result.total} unread support email(s)${suffix}.\n\nSend \`support reply\` to go through them.`
  );
}

// For the `scan` command digest — throws if the support account isn't configured,
// same as the other scan checks, so the missing-config error surfaces in the summary.
export async function checkSupportInboxForScan() {
  const account = getZohoAccount('support');
  if (!account) throw new Error('ZOHO_PASSWORD_SUPPORT not set');

  const { total, newCount } = await getNewUnreadSupportEmails();
  if (!newCount) return [];

  const suffix = newCount < total ? ` (${newCount} new)` : '';
  return [`📬 ${total} unread support email(s)${suffix} — send \`support reply\` to go through them.`];
}

export function startSupportInboxWatcher() {
  if (pollTimer) clearInterval(pollTimer);

  const account = getZohoAccount('support');
  if (!account) {
    console.log('📬 Support inbox watcher not started (ZOHO_PASSWORD_SUPPORT not set)');
    return;
  }

  const minutes = getSupportPollMinutes();
  console.log(`📬 Support inbox watcher started (polling every ${minutes} min)`);
  checkSupportInbox().catch(err => console.error('❌ Support inbox: initial check failed:', err.message));
  pollTimer = setInterval(() => {
    checkSupportInbox().catch(err => console.error('❌ Support inbox check error:', err.message));
  }, minutes * 60 * 1000);
}
