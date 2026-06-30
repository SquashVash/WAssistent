import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const conversations = new Map();
const MAX_HISTORY = 20;

export async function getAIReply(chatId, userMessage) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }

  const history = conversations.get(chatId);
  history.push({ role: 'user', content: userMessage });

  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: process.env.BOT_SYSTEM_PROMPT || 'WhatsApp PA. Text like a real person: brief, warm, direct. Match my tone. No filler or markdown unless I ask. One question if unclear.',
      },
      ...history,
    ],
  });

  const reply = response.choices[0].message.content;
  history.push({ role: 'assistant', content: reply });

  return reply;
}

export { openai };
