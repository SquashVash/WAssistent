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
        content: 'You are writing the opening for a personal daily briefing message.\n\nRead the brief below and write 1–3 sentences that capture what actually matters about today — the things worth knowing before reading the full details (e.g. a packed schedule, an overdue task, travel, a payment due, a conflict between two things, or nothing notable at all). Skip anything routine or already obvious from the section headers.\n\nWrite like an actual person texting someone they know, not a report or an announcement. Use plain, everyday words and natural rhythm — contractions are fine, vary your sentence openings, and don\'t force every sentence into the same shape. It should read like something a thoughtful friend who happens to be organized would text, not like a system-generated summary.\n\nTone: warm, calm, direct — not stiff or corporate. Never invent information that isn\'t in the brief. Avoid clichés ("busy day ahead", "don\'t forget to") and generic encouragement ("you\'ve got this", "make the most of it") — and avoid sounding like you\'re narrating a press release.\n\nIf the day is genuinely uneventful, say so plainly and simply, the way a person would mention it in passing.',
      },
      {
        role: 'user',
        content: `Today is ${todayLabel}.\n\n${briefBody || 'Nothing scheduled today.'}`,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

// Turns one or more plain reminder texts into a short, casual WhatsApp-style nudge.
// Pass an array when several reminders fire at once so they're folded into one message.
export async function humanizeReminder(texts) {
  const list = Array.isArray(texts) ? texts : [texts];

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: list.length > 1
          ? 'Write a short, warm, casual message covering all of these reminders at once, like texting a friend. Mention each one. A sentence or two per reminder at most, no markdown, no greeting, no numbered/bulleted list.'
          : 'Write a short, warm, casual reminder message, like texting a friend. One or two sentences, no markdown, no greeting.',
      },
      {
        role: 'user',
        content: list.length > 1
          ? `Remind me to:\n${list.map(t => `- ${t}`).join('\n')}`
          : `Remind me to: ${list[0]}`,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

export async function extractHotelBooking(emailText) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You extract hotel booking details from confirmation emails. Respond with JSON only, no markdown. If this isn\'t a hotel booking confirmation, or the check-in/check-out dates are missing, respond with null.',
      },
      {
        role: 'user',
        content: `Extract the hotel name, check-in date/time, and check-out date/time from this email. Return JSON: {"hotelName":"...","checkIn":{"date":"YYYY-MM-DD","time":"HH:MM or null"},"checkOut":{"date":"YYYY-MM-DD","time":"HH:MM or null"}} or null if not a hotel booking confirmation or the dates are missing.\n\n${emailText.slice(0, 4000)}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    if (!parsed || !parsed.checkIn?.date || !parsed.checkOut?.date) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Picks up to `count` most worth-doing tasks from a list of no-due-date tasks (which
// have no built-in priority field), based purely on the task text, ranked most
// important first. Returns [] if the list is empty or nothing stands out.
export async function suggestPriorityTasks(tasks, count = 3) {
  if (!tasks.length) return [];

  const list = tasks.map((t, i) => `${i + 1}. ${t.title}${t.notes ? ` — ${t.notes}` : ''}`).join('\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are picking which tasks from a to-do list are most worth doing today if there's spare time. These tasks have no due date and no explicit priority — judge based on the task text alone (urgency implied by wording, consequences of delay, effort vs. impact). Respond with JSON only: {"indices": [<1-based numbers>, ...]}, ranked most important first, with up to ${count} entries. Return fewer (or an empty array) if there aren't that many worth highlighting.`,
      },
      {
        role: 'user',
        content: list,
      },
    ],
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    const indices = Array.isArray(parsed?.indices) ? parsed.indices : [];
    const seen = new Set();
    const picked = [];
    for (const idx of indices) {
      if (typeof idx !== 'number' || idx < 1 || idx > tasks.length || seen.has(idx)) continue;
      seen.add(idx);
      picked.push(tasks[idx - 1]);
      if (picked.length >= count) break;
    }
    return picked;
  } catch {
    return [];
  }
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
