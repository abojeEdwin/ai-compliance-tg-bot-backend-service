const express = require('express');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const { RouterNode, RagExecutionNode, ErrorHandlingNode } = require('./services/orchestrator');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const routerNode = new RouterNode();
const ragNode = new RagExecutionNode();
const errorNode = new ErrorHandlingNode();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const redisClient = createClient({ url: process.env.REDIS_URL});
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.connect().catch(console.error);

bot.start(async (ctx) => {
  await redisClient.del(`tg:session:${ctx.from.id}`);
  ctx.reply("Welcome! I am an AI Compliance Automation Assistant Bot!\n\nAsk me anything about integrating our SDKs, APIs, verification workflows, or commercial business details.");
});

bot.on('text', async (ctx) => {
  const incomingText = ctx.message.text;
  const userId = ctx.from.id;
  const sessionKey = `tg:session:${userId}`;

  // Gracefully degrade to stateless mode if Redis is unavailable
  let history = [];
  try {
    const rawHistory = await redisClient.get(sessionKey);
    history = rawHistory ? JSON.parse(rawHistory) : [];
  } catch (redisReadErr) {
    console.error(`[Redis] Failed to read session for user ${userId}:`, redisReadErr.message);
  }

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
    history = history.slice(-10);

    // Persist updated history — fail silently so the reply still goes through
    try {
      await redisClient.setEx(sessionKey, 1800, JSON.stringify(history));
    } catch (redisWriteErr) {
      console.error(`[Redis] Failed to write session for user ${userId}:`, redisWriteErr.message);
    }

    await ctx.reply(workflowCtx.ragAnswer);

  } catch (error) {
    console.error(`[Orchestrator] Error for user ${userId}:`, error.message);
    workflowCtx.error = error.message;
    workflowCtx = await errorNode.execute(workflowCtx);
    await ctx.reply(workflowCtx.ragAnswer);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: "ok", engine: "custom-node" });
});

app.listen(PORT, () => {
  console.log(`📡 Express server monitoring health on port ${PORT}`);
  
  bot.launch().then(() => {
    console.log('🤖 Telegram Automation Bot Engine actively listening...');
  });
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));