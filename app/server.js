const express = require('express');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const { RouterNode, RagExecutionNode, ErrorHandlingNode } = require('./services/orchestrator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const routerNode = new RouterNode();
const ragNode = new RagExecutionNode();
const errorNode = new ErrorHandlingNode();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ---------------------------------------------------------------------------
// In-memory session store (replaces Redis)
// Each entry: { history: Array, expiresAt: number (ms timestamp) }
// TTL: 30 minutes | Sliding window: last 10 messages
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY   = 10;              // messages (user + chatbot combined)
const sessionStore  = new Map();

// Prune expired sessions every 10 minutes to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStore) {
    if (entry.expiresAt <= now) sessionStore.delete(key);
  }
}, 10 * 60 * 1000);

function getSession(userId) {
  const key = `tg:session:${userId}`;
  const entry = sessionStore.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    sessionStore.delete(key);
    return [];
  }
  return entry.history;
}

function setSession(userId, history) {
  const key = `tg:session:${userId}`;
  sessionStore.set(key, {
    history,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

function deleteSession(userId) {
  sessionStore.delete(`tg:session:${userId}`);
}
// ---------------------------------------------------------------------------

bot.start(async (ctx) => {
  deleteSession(ctx.from.id);
  ctx.reply("Welcome! I am an AI Compliance Automation Assistant Bot!\n\nAsk me anything about integrating our SDKs, APIs, verification workflows, or commercial business details.");
});

bot.on('text', async (ctx) => {
  const incomingText = ctx.message.text;
  const userId = ctx.from.id;

  let history = getSession(userId);

  let workflowCtx = {
    telegramUserId: userId,
    rawInput: incomingText,
    history: history
  };

  await ctx.sendChatAction('typing');

  try {
    workflowCtx = await routerNode.execute(workflowCtx);
    workflowCtx = await ragNode.execute(workflowCtx);

    history.push({ role: 'user', content: incomingText });
    history.push({ role: 'chatbot', content: workflowCtx.ragAnswer });
    history = history.slice(-MAX_HISTORY);

    setSession(userId, history);

    await ctx.reply(workflowCtx.ragAnswer);

  } catch (error) {
    console.error(`[Orchestrator] Error for user ${userId}:`, error.message);
    workflowCtx.error = error.message;
    workflowCtx = await errorNode.execute(workflowCtx);
    await ctx.reply(workflowCtx.ragAnswer);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: "ok", engine: "custom-node", sessions: sessionStore.size });
});

// ---------------------------------------------------------------------------
// Telegram webhook endpoint
// Telegram POSTs every incoming update to this route in production
// ---------------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body, res);
});

app.listen(PORT, async () => {
  console.log(`📡 Express server listening on port ${PORT}`);

  const webhookUrl = process.env.WEBHOOK_URL; // e.g. https://your-app.vercel.app/webhook

  if (webhookUrl) {
    // Production: register webhook with Telegram then wait for POSTs
    try {
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`🔗 Webhook registered: ${webhookUrl}`);
      console.log('🤖 Bot ready (webhook mode)');
    } catch (err) {
      console.error('❌ Failed to set webhook:', err.message);
    }
  } else {
    // Local development: fall back to long polling
    console.log('⚠️  WEBHOOK_URL not set — starting in long-polling mode (local dev only)');
    bot.launch().then(() => {
      console.log('🤖 Telegram Bot Engine actively listening (polling)...');
    });
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));