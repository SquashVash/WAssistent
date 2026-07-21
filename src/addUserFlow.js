import { addUser, grantPermission, PERMISSION_TAGS } from './users.js';

// In-memory state
let addUserState = null; // { step: 'contact' | 'name' | 'permissions', data: { name, phone } }

function parseContact(msg, text) {
  if ((msg?.type === 'vcard' || text.trimStart().startsWith('BEGIN:VCARD')) && text) {
    const waidMatch = text.match(/waid=(\d+)/i);
    let digits;
    if (waidMatch) {
      digits = waidMatch[1];
    } else {
      const telMatch = text.match(/^TEL[^:]*:(.+)$/im);
      digits = telMatch ? telMatch[1].replace(/\D/g, '') : '';
    }
    if (!digits || digits.length < 7) return { error: '❌ Couldn\'t read a phone number from that contact card. Try another or type the number manually:' };

    const fnMatch = text.match(/^FN:(.+)$/im);
    const name = fnMatch ? fnMatch[1].trim() : null;
    return { digits, name };
  }

  const digits = text.replace(/\D/g, '');
  if (digits.length < 7) return { error: '❌ Doesn\'t look like a valid phone number. Include the country code (e.g. `972501234567`). Try again:' };
  return { digits, name: null };
}

function formatSummary(name, phone, role, permissions) {
  const perms = role === 'custom' ? ` — permissions: ${permissions.join(', ')}` : '';
  return `✅ Added *${name}* (+${phone}) as *${role}*${perms}.`;
}

async function handleStep(msg, text) {
  const { step, data } = addUserState;
  const lower = text.toLowerCase();

  if (step === 'contact') {
    const result = parseContact(msg, text);
    if (result.error) return result.error;

    data.phone = result.digits;

    if (result.name) {
      data.name = result.name;
      addUserState.step = 'permissions';
      return `✅ Got *${result.name}* (+${result.digits}).\n\n*Permissions*\nReply with a role (\`owner\`, \`admin\`, \`user\`) or a comma-separated list of permission tags:\n${PERMISSION_TAGS.join(', ')}`;
    }

    addUserState.step = 'name';
    return `✅ Number saved: +${result.digits}\n\nWhat's their name?`;
  }

  if (step === 'name') {
    if (!text) return '❌ Please send a name:';
    data.name = text;
    addUserState.step = 'permissions';
    return `*Permissions*\nReply with a role (\`owner\`, \`admin\`, \`user\`) or a comma-separated list of permission tags:\n${PERMISSION_TAGS.join(', ')}`;
  }

  if (step === 'permissions') {
    let role;
    let permissions = [];

    if (/^(owner|admin|user)$/i.test(lower)) {
      role = lower;
    } else {
      const tags = text.split(/[,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
      const invalid = tags.filter(t => !PERMISSION_TAGS.includes(t));
      if (!tags.length || invalid.length) {
        const invalidNote = invalid.length ? `❌ Unknown permission(s): ${invalid.join(', ')}.\n\n` : '❌ Please reply with a role or at least one valid permission tag.\n\n';
        return `${invalidNote}Valid tags: ${PERMISSION_TAGS.join(', ')}`;
      }
      role = 'custom';
      permissions = tags;
    }

    const added = addUser({ name: data.name, phone: data.phone, role });
    if (!added) {
      addUserState = null;
      return `⚠️ A user with phone +${data.phone} already exists.`;
    }
    for (const tag of permissions) grantPermission(data.phone, tag);

    addUserState = null;
    return formatSummary(added.name, added.phone, role, permissions);
  }

  return false;
}

// Returns: string (reply), false (not this flow's business)
export async function handleAddUserFlow(msg) {
  const body = typeof msg === 'string' ? msg : (msg?.body ?? '');
  const text = body.trim();
  const lower = text.toLowerCase();

  if (addUserState) {
    if (/^cancel$/i.test(lower)) {
      addUserState = null;
      return '❌ Add user cancelled.';
    }
    return handleStep(msg, text);
  }

  if (/^add user$/i.test(lower)) {
    addUserState = { step: 'contact', data: {} };
    return '👤 *Add User*\n\nSend a phone number (e.g. `972501234567`) or *share a WhatsApp contact card*.\n\nSend `cancel` at any time to abort.';
  }

  return false;
}
