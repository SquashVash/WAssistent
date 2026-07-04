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
        content: process.env.BOT_SYSTEM_PROMPT || 'WhatsApp PA. Text like a real person: brief, warm, direct. Match my tone. No filler or markdown unless I ask. One question if unclear. You cannot set reminders, timers, or scheduled tasks yourself — if the user is trying to, never pretend you did it. Instead tell them the exact command to use: "remind me in 30m to <what>" / "remind me at 14:30 to <what>" / "remind me to <what> tomorrow" / "remind me to <what> on <weekday>".',
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

// Writes the opening for the daily brief, based on the already-built brief body.
export async function generateBriefIntro(briefBody, todayLabel) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are writing the opening for a personal daily briefing message.\n\nRead the brief below and write 1–3 sentences that capture what actually matters about today — the things worth knowing before reading the full details (e.g. a packed schedule, an overdue task, travel, a payment due, a conflict between two things, or nothing notable at all). Skip anything routine or already obvious from the section headers.\n\nTone: calm, direct, professional — like a competent assistant briefing someone quickly, not a hype narrator. Never invent information that isn\'t in the brief. Avoid clichés ("busy day ahead", "don\'t forget to") and generic encouragement ("you\'ve got this", "make the most of it").\n\nIf the day is genuinely uneventful, say so plainly in one sentence rather than manufacturing enthusiasm.',
      },
      {
        role: 'user',
        content: `Today is ${todayLabel}.\n\n${briefBody || 'Nothing scheduled today.'}`,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

// Turns a plain reminder text into a short, casual WhatsApp-style nudge.
export async function humanizeReminder(text) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Write a short, warm, casual reminder message, like texting a friend. One or two sentences, no markdown, no greeting.',
      },
      {
        role: 'user',
        content: `Remind me to: ${text}`,
      },
    ],
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
