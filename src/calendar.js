import { google } from 'googleapis';

function getAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing Google Calendar credentials in .env (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
  }

  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return auth;
}

export async function testCalendarConnection() {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const { data } = await calendar.calendars.get({ calendarId });
    return { ok: true, detail: data.summary || calendarId };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function getUpcomingEvents(timezone = 'UTC', days = 7) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: timezone,
  });

  return res.data.items || [];
}

export async function getTodaysEvents(timezone = 'UTC') {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const now = new Date();
  const startOfDay = new Date(now.toLocaleDateString('en-CA', { timeZone: timezone }) + 'T00:00:00');
  const endOfDay = new Date(now.toLocaleDateString('en-CA', { timeZone: timezone }) + 'T23:59:59');

  const res = await calendar.events.list({
    calendarId,
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: timezone,
  });

  return res.data.items || [];
}

export function formatEventsForPrompt(events, timezone = 'UTC') {
  if (!events.length) return 'No events scheduled for today.';

  const lines = events.map(event => {
    const start = event.start?.dateTime || event.start?.date;
    const end = event.end?.dateTime || event.end?.date;

    let timeStr = 'All day';
    if (event.start?.dateTime) {
      const startTime = new Date(start).toLocaleTimeString('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      const endTime = new Date(end).toLocaleTimeString('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      timeStr = `${startTime} – ${endTime}`;
    }

    const location = event.location ? ` @ ${event.location}` : '';
    return `• ${timeStr}: ${event.summary || '(No title)'}${location}`;
  });

  return lines.join('\n');
}
