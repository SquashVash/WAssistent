import 'dotenv/config';
import { startWebhookServer } from './src/webhook.js';
import { scheduleDailyBrief } from './src/brief.js';
import { startGmailWatcher } from './src/gmail.js';
import { startFlightTracker, restoreScheduledTrackings } from './src/flightTracker.js';
import { initDMS } from './src/dms.js';
import { scheduleNightlyChecks } from './src/nightly.js';

const PORT = process.env.WEBHOOK_PORT || process.env.PORT || 3000;

startWebhookServer(PORT);
scheduleDailyBrief();
startGmailWatcher();
startFlightTracker();
restoreScheduledTrackings();
initDMS();
scheduleNightlyChecks();
