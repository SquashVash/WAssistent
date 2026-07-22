import express from 'express';
import { getAIReply } from './ai.js';
import { sendMessage, sendAdminMessage, getContactPhoneNumber } from './messaging.js';
import { handleCommand } from './commands.js';
import { getUserByChatId, getUserByPhone, hasPermission } from './users.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

async function handleIncomingMessage(msg) {
  const { chatId, body, fromMe } = msg;

  if (fromMe) return;
  if (!body?.trim()) return;

  const user = getUserByChatId(chatId);
  if (!user) {
    console.log(`⚠️ Recieved message from unauthorized chat: ${chatId}`);

    // Accounts that message via an opaque @lid id (instead of phone@c.us)
    // won't match directly — try resolving the real phone number via
    // open-wa purely to suggest a link candidate. Never auto-link: doing so
    // based on unauthenticated webhook input would let anyone claiming a
    // known user's chatId silently take over that user's permissions.
    const phone = await getContactPhoneNumber(chatId);
    const byPhone = phone ? getUserByPhone(phone) : null;

    await sendAdminMessage(
      byPhone
        ? `⚠️ Message from unlinked chat \`${chatId}\` — looks like it might be *${byPhone.name}* (+${byPhone.phone}).\nIf that's correct, confirm with:\nlink ${byPhone.phone} ${chatId}`
        : `⚠️ Received message from unauthorized/unlinked chat: \`${chatId}\`\nIf this is a known user, link them with:\nlink <phone> ${chatId}`
    );
    return;
  }

  console.log(`📩 [${chatId}] (${user.name}): ${body}`);

  const commandReply = await handleCommand(msg, user);
  if (commandReply !== false) {
    if (commandReply) await sendMessage(chatId, commandReply);
    console.log(`⚙️  Command handled: ${commandReply}`);
    return;
  }

  if (!hasPermission(user, 'chat')) return;

  const reply = await getAIReply(chatId, body);
  await sendMessage(chatId, reply);
  console.log(`✅ [${chatId}] → ${reply}`);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const rawPayload = JSON.stringify(req.body);
  console.log('📦 Raw webhook payload:', rawPayload.length > 4000 ? `${rawPayload.slice(0, 4000)}…(truncated)` : rawPayload);

  const msg = req.body?.message ?? req.body?.data ?? req.body;

  if (!msg?.chatId) return;

  try {
    await handleIncomingMessage(msg);
  } catch (err) {
    console.error(`❌ Error handling message from ${msg.chatId}:`, err.message);
  }
});

export function startWebhookServer(port) {
  app.listen(port, () => {
    console.log(`🤖 WhatsApp AI bot started (webhook mode)`);
    console.log(`🌐 Listening for webhooks on port ${port}`);
  });
}
