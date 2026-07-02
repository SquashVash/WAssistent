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

// Drafts a reply to a support email. Pass `previousDraft` + `feedback` to revise
// an earlier draft instead of writing a fresh one.
export async function suggestSupportReply(email, { previousDraft, feedback } = {}) {
  const messages = [
    {
      role: 'system',
      content: 'You are a helpful, professional customer support agent replying on behalf of the business. Write clear, polite, concise email replies. Output only the reply body text — no subject line, no "Dear ..." salutation unless natural, and sign off simply.',
    },
    {
      role: 'user',
      content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.text.slice(0, 4000)}\n\nWrite a reply.`,
    },
  ];

  if (previousDraft && feedback) {
    messages.push({ role: 'assistant', content: previousDraft });
    messages.push({ role: 'user', content: `Revise the reply based on this feedback: ${feedback}` });
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
  });

  return response.choices[0].message.content.trim();
}

export async function extractFlightInfo(emailText) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You extract flight information from emails. Respond with JSON only, no markdown. If no flight found, respond with null.',
      },
      {
        role: 'user',
        content: `Extract the flight callsign (airline code + flight number, e.g. "ELY006", "BA123"), departure date and time from this email. Return JSON: {"callsign":"...","departureIso":"YYYY-MM-DDTHH:MM:SS"} or null if not a flight email or info is missing.\n\n${emailText.slice(0, 4000)}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    if (!parsed || !parsed.callsign || !parsed.departureIso) return null;
    return parsed;
  } catch {
    return null;
  }
}
