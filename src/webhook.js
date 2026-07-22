import express from 'express';
import { getAIReply } from './ai.js';
import { sendMessage, sendAdminMessage, getContactPhoneNumber } from './messaging.js';
import { handleCommand } from './commands.js';
import { getUserByChatId, getUserByPhone, linkWhatsappId, hasPermission } from './users.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

async function resolveUser(chatId) {
  const direct = getUserByChatId(chatId);
  if (direct) return direct;

  // Accounts that message via an opaque @lid id (instead of phone@c.us) won't
  // match directly — try resolving the real phone number via open-wa and
  // auto-link if it belongs to a known user.
  const phone = await getContactPhoneNumber(chatId);
  if (!phone) return null;
  const byPhone = getUserByPhone(phone);
  if (!byPhone) return null;

  linkWhatsappId(byPhone.phone, chatId);
  console.log(`🔗 Auto-linked ${byPhone.name} (+${byPhone.phone}) to chat id ${chatId}`);
  return { ...byPhone, whatsappId: chatId };
}

async function handleIncomingMessage(msg) {
  const { chatId, body, fromMe } = msg;

  if (fromMe) return;
  if (!body?.trim()) return;

  const user = await resolveUser(chatId);
  if (!user) {
    console.log(`⚠️ Recieved message from unauthorized chat: ${chatId}`);
    await sendAdminMessage(
      `⚠️ Received message from unauthorized/unlinked chat: \`${chatId}\`\n` +
      `If this is a known user, link them with:\nlink <phone> ${chatId}`
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
