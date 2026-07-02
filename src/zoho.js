import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sendDocument } from './messaging.js';

const ZOHO_HOST = process.env.ZOHO_IMAP_HOST || 'imap.zoho.com';

// Zoho accounts scanned for receipt PDFs. Passwords are Zoho "app-specific
// passwords" (Zoho Mail Settings -> Security -> App Passwords), read from env.
const ZOHO_ACCOUNTS = [
  { email: 'shay@kovets.com', passwordEnv: 'ZOHO_PASSWORD_SHAY' },
  { email: 'support@kovets.com', passwordEnv: 'ZOHO_PASSWORD_SUPPORT' },
];

// Cap how many recent messages we inspect per account for an unbounded (all-time) search.
const MAX_UIDS_PER_ACCOUNT = 100;

function getConfiguredAccounts() {
  return ZOHO_ACCOUNTS
    .map(a => ({ email: a.email, password: process.env[a.passwordEnv] }))
    .filter(a => a.password);
}

async function openClient(account) {
  const client = new ImapFlow({
    host: ZOHO_HOST,
    port: 993,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
  });
  await client.connect();
  return client;
}

function hasPdfAttachment(node, isRoot = true) {
  if (!node) return false;
  if (!isRoot) {
    const filename = node.parameters?.name || node.dispositionParameters?.filename || '';
    const isPdf = node.type === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
    if (isPdf) return true;
  }
  return (node.childNodes || []).some(child => hasPdfAttachment(child, false));
}

async function sendZohoAttachments(account, uid, sourceName, subject, from) {
  let client;
  try {
    client = await openClient(account);
    const lock = await client.getMailboxLock('INBOX');
    let sentAny = false;
    try {
      const { content } = await client.download(uid, undefined, { uid: true });
      const parsed = await simpleParser(content);
      for (const att of parsed.attachments || []) {
        const isPdf = att.contentType === 'application/pdf' || att.filename?.toLowerCase().endsWith('.pdf');
        if (!isPdf) continue;
        const base64 = att.content.toString('base64');
        const caption = `🧾 *${sourceName}*\n${subject}\nFrom: ${from}`;
        await sendDocument(process.env.MY_CHAT_ID, base64, att.filename || 'receipt.pdf', caption);
        console.log(`   ↳ sent "${att.filename}" (${sourceName}) via Zoho (${account.email}) ✅`);
        sentAny = true;
      }
    } finally {
      lock.release();
    }
    return sentAny;
  } catch (err) {
    console.error(`❌ Zoho (${account.email}): failed to send attachment for uid ${uid}:`, err.message);
    return false;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// Lists PDF-attachment emails across configured Zoho accounts as generic receipt candidates.
// `start`/`end` are Date objects (end exclusive); either may be omitted for an all-time search.
export async function listZohoReceiptCandidates({ start, end } = {}) {
  const accounts = getConfiguredAccounts();
  const candidates = [];

  for (const account of accounts) {
    let client;
    try {
      client = await openClient(account);
      const lock = await client.getMailboxLock('INBOX');
      try {
        const searchCriteria = {};
        if (start) searchCriteria.since = start;
        if (end) searchCriteria.before = end;

        let uids = await client.search(Object.keys(searchCriteria).length ? searchCriteria : { all: true });
        if (!start && !end && uids.length > MAX_UIDS_PER_ACCOUNT) {
          uids = uids.slice(-MAX_UIDS_PER_ACCOUNT);
        }

        for (const uid of uids) {
          const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
          if (!msg || !hasPdfAttachment(msg.bodyStructure)) continue;

          const subject = msg.envelope?.subject || '';
          const fromAddr = msg.envelope?.from?.[0];
          const from = fromAddr ? `${fromAddr.name || ''} <${fromAddr.address}>`.trim() : '';
          const date = msg.envelope?.date ? new Date(msg.envelope.date) : null;

          candidates.push({
            subject,
            from,
            date,
            sendAttachments: (sourceName) => sendZohoAttachments(account, uid, sourceName, subject, from),
          });
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error(`❌ Zoho (${account.email}): failed to scan inbox:`, err.message);
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }

  return candidates;
}
