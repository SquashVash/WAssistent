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

export async function sendDocument(chatId, base64Data, filename, caption = '') {
  await axios.post(
    `${OPENWA_URL}/sessions/${SESSION_ID}/messages/send-document`,
    { chatId, base64: base64Data, mimetype: 'application/pdf', filename, caption },
    { headers }
  );
}

export async function sendFile(chatId, base64Data, filename, mimetype, caption = '') {
  await axios.post(
    `${OPENWA_URL}/sessions/${SESSION_ID}/messages/send-document`,
    { chatId, base64: base64Data, mimetype, filename, caption },
    { headers }
  );
}

export async function sendImage(chatId, base64Data, caption = '') {
  await axios.post(
    `${OPENWA_URL}/sessions/${SESSION_ID}/messages/send-image`,
    { chatId, base64: `data:image/png;base64,${base64Data}`, caption },
    { headers }
  );
}
