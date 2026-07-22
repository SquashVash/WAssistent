import express from 'express';
import { getAIReply } from './ai.js';
import { sendMessage, sendAdminMessage } from './messaging.js';
import { handleCommand } from './commands.js';
import { handleChangeNotification } from './watch.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

async function handleIncomingMessage(msg) {
  const { chatId, body, fromMe } = msg;

  if (fromMe) return;
  if (!body?.trim()) return;
  if (chatId !== process.env.MY_CHAT_ID) {
    const phone = chatId.replace(/@.*$/, '');
    console.log(`⚠️ Recieved message from unauthorized chat: ${chatId}`);
    await sendAdminMessage(`⚠️ Received message from unauthorized number: +${phone}`)
    return;
  }


  console.log(`📩 [${chatId}]: ${body}`);

  if (chatId === process.env.MY_CHAT_ID) {
    const commandReply = await handleCommand(msg);
    if (commandReply !== false) {
      if (commandReply) await sendMessage(chatId, commandReply);
      console.log(`⚙️  Command handled: ${commandReply}`);
      return;
    }
  }

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

// changedetection.io → Apprise json:// notification on a page change
app.post('/webhook/changedetection', async (req, res) => {
  if (req.get('X-CD-Token') !== process.env.CHANGEDETECTION_WEBHOOK_TOKEN) {
    console.log('⚠️ Rejected changedetection webhook with bad token');
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  try {
    await handleChangeNotification(req.body);
  } catch (err) {
    console.error('❌ Error handling changedetection notification:', err.message);
  }
});

export function startWebhookServer(port) {
  app.listen(port, () => {
    console.log(`🤖 WhatsApp AI bot started (webhook mode)`);
    console.log(`🌐 Listening for webhooks on port ${port}`);
  });
}
