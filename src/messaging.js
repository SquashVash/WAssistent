import axios from 'axios';

const OPENWA_URL = process.env.OPENWA_API_URL;
const OPENWA_KEY = process.env.OPENWA_API_KEY;
const SESSION_ID = process.env.OPENWA_SESSION_ID;
const ADMIN_CHAT_ID = process.env.MY_CHAT_ID;

const headers = { 'X-API-Key': OPENWA_KEY };

export async function sendMessage(chatId, text) {
  await axios.post(
    `${OPENWA_URL}/sessions/${SESSION_ID}/messages/send-text`,
    { chatId, text },
    { headers }
  );
}


export async function sendAdminMessage(text) {
  await axios.post(
    `${OPENWA_URL}/sessions/${SESSION_ID}/messages/send-text`,
    { chatId: ADMIN_CHAT_ID, text },
    { headers }
  );
}

/**
 * @param {string} chatId
 * @param {string} content - Main message body
 * @param {Array<{id: string, text: string}>} buttons - Up to 3 buttons
 * @param {string} [footer] - Optional footer text
 */
export async function sendButtons(chatId, content, buttons, footer = '') {
  await axios.post(
    `${OPENWA_URL}/sessions/${SESSION_ID}/messages/sendButtons`,
    { chatId, content, footer, buttons },
    { headers }
  );
}