import 'dotenv/config';
import { startWebhookServer } from './src/webhook.js';
import { scheduleDailyBrief } from './src/brief.js';

const PORT = process.env.WEBHOOK_PORT || process.env.PORT || 3000;

startWebhookServer(PORT);
scheduleDailyBrief();
