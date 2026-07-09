const express = require('express');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const { RouterNode, RagExecutionNode, ErrorHandlingNode } = require('./services/orchestrator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const routerNode = new RouterNode();
const ragNode   = new RagExecutionNode();
const errorNode = new ErrorHandlingNode();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ---------------------------------------------------------------------------
// Global crash guard — prevents unhandled rejections from killing the process
// (was causing exit status 128 after RAG service timeout)
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason?.message || reason);
});

// ---------------------------------------------------------------------------
// In-memory session store
// Each entry: { history: Array, expiresAt: number (ms timestamp) }
// TTL: 30 minutes | Sliding window: last 10 messages
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY    = 10;
const sessionStore   = new Map();

// Prune expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStore) {
    if (entry.expiresAt <= now) sessionStore.delete(key);
  }
}, 10 * 60 * 1000);

function getSession(userId) {
  const key   = `tg:session:${userId}`;
  const entry = sessionStore.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    sessionStore.delete(key);
    return [];
  }
  return entry.history;
}

function setSession(userId, history) {
  sessionStore.set(`tg:session:${userId}`, {
    history,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

function deleteSession(userId) {
  sessionStore.delete(`tg:session:${userId}`);
}

// ---------------------------------------------------------------------------
// Core message processor — runs async / fire-and-forget so the webhook
// 200 OK is returned to Telegram immediately (avoids the 90s timeout crash)
// ---------------------------------------------------------------------------
async function handleMessage(ctx, incomingText) {
  const userId = ctx.from.id;
  let history  = getSession(userId);

  let workflowCtx = { telegramUserId: userId, rawInput: incomingText, history };

  try {
    workflowCtx = await routerNode.execute(workflowCtx);
    workflowCtx = await ragNode.execute(workflowCtx);

    history.push({ role: 'user',    content: incomingText });
    history.push({ role: 'chatbot', content: workflowCtx.ragAnswer });
    setSession(userId, history.slice(-MAX_HISTORY));

    await ctx.reply(workflowCtx.ragAnswer);
  } catch (error) {
    console.error(`[Orchestrator] Error for user ${userId}:`, error.message);
    workflowCtx.error = error.message;
    workflowCtx = await errorNode.execute(workflowCtx);
    await ctx.reply(workflowCtx.ragAnswer);
  }
}

// ---------------------------------------------------------------------------
// Bot handlers
// ---------------------------------------------------------------------------
bot.start(async (ctx) => {
  deleteSession(ctx.from.id);
  ctx.reply(
    'Welcome! I am an AI Compliance Automation Assistant Bot!\n\n' +
    'Ask me anything about integrating our SDKs, APIs, verification workflows, or commercial business details.'
  );
});

bot.on('text', async (ctx) => {
  const incomingText = ctx.message.text;
  const userId       = ctx.from.id;

  // Show typing indicator immediately so the user knows the bot is alive
  await ctx.sendChatAction('typing').catch(() => {});

  // Fire-and-forget: don't await — this ensures the webhook handler returns
  // its 200 OK to Telegram without waiting for the (slow) RAG service
  handleMessage(ctx, incomingText).catch((err) => {
    console.error(`[Bot] Uncaught error for user ${userId}:`, err.message);
  });
});

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', engine: 'custom-node', sessions: sessionStore.size });
});

// Telegram POSTs every update here; respond 200 immediately then process async
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch((err) => {
    console.error('[Webhook] handleUpdate error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`📡 Express server listening on port ${PORT}`);

  const webhookUrl = process.env.WEBHOOK_URL;

  if (webhookUrl) {
    // Production: register webhook with Telegram
    try {
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`🔗 Webhook registered: ${webhookUrl}`);
      console.log('🤖 Bot ready (webhook mode)');
    } catch (err) {
      console.error('❌ Failed to set webhook:', err.message);
    }

    // Warm up the Python RAG service on startup so Render's free-tier cold
    // start doesn't hit the first real user — fire-and-forget, non-blocking
    const ragUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (ragUrl) {
      const axios = require('axios');
      axios
        .post(ragUrl, { prompt: '__warmup__', history: [] }, { timeout: 60000 })
        .then(() => console.log('🔥 RAG service warmed up'))
        .catch((e) => console.warn('⚠️  RAG warmup failed (still cold-starting):', e.message));
    }
  } else {
    // Local dev: long polling fallback
    console.log('⚠️  WEBHOOK_URL not set — starting in long-polling mode (local dev only)');
    bot.launch().then(() => {
      console.log('🤖 Telegram Bot Engine actively listening (polling)...');
    });
  }
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));