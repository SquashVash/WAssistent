import { google } from 'googleapis';

function getAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing Google credentials in .env');
  }

  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return auth;
}

export async function testTasksConnection() {
  try {
    const auth = getAuthClient();
    const tasksApi = google.tasks({ version: 'v1', auth });
    const { data } = await tasksApi.tasklists.list({ maxResults: 10 });
    return { ok: true, detail: `${(data.items || []).length} list(s)` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function getTasks(timezone = 'UTC') {
  const auth = getAuthClient();
  const tasksApi = google.tasks({ version: 'v1', auth });

  const listsRes = await tasksApi.tasklists.list({ maxResults: 10 });
  const lists = listsRes.data.items || [];

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

  const allTasks = [];

  await Promise.all(lists.map(async (list) => {
    const res = await tasksApi.tasks.list({
      tasklist: list.id,
      showCompleted: false,
      showHidden: true,
      maxResults: 100,
    });

    const tasks = (res.data.items || []).filter(t => t.status !== 'completed');

    for (const task of tasks) {
      // Include tasks with no due date, or due today/earlier
      if (!task.due || task.due.slice(0, 10) <= todayStr) {
        allTasks.push({ ...task, listTitle: list.title });
      }
    }
  }));

  return allTasks;
}

export function categorizeTasks(tasks, timezone = 'UTC') {
  const overdue = [];
  const dueToday = [];
  const noDueDate = [];

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

  for (const task of tasks) {
    const due = task.due ? task.due.slice(0, 10) : null;
    if (!due) {
      noDueDate.push(task);
    } else if (due < todayStr) {
      overdue.push(task);
    } else {
      dueToday.push(task);
    }
  }

  return { overdue, dueToday, noDueDate };
}
