const axios = require('axios');

class RouterNode {
  constructor() {
    this.name = 'IntentRouterNode';
  }

  async execute(ctx) {
    const text = ctx.rawInput.toLowerCase();
    
    if (text.includes('api') || text.includes('sdk') || text.includes('code') || text.includes('endpoint')) {
      ctx.category = 'technical';
    } else {
      ctx.category = 'commercial';
    }
    return ctx;
  }
}

class RagExecutionNode {
  constructor() {
    this.name = 'CohereRagNode';
  }

  async execute(ctx) {
    try {
      const history = ctx.history || [];
      const response = await axios.post(
        process.env.PYTHON_RAG_SERVICE_URL,
        { prompt: ctx.rawInput, history },
        { timeout: 25000 } // fail fast — don't let a slow RAG service hang forever
      );

      ctx.ragAnswer = response.data.answer;
      return ctx;
    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      console.error(`[RAG] ${isTimeout ? 'Timeout' : 'Request failed'}: ${err.message}`);
      ctx.error = isTimeout
        ? 'RAG service timed out — it may be cold-starting. Please try again in a moment.'
        : (err.message || 'Error occurred during Python RAG evaluation');
      throw err;
    }
  }
}

class ErrorHandlingNode {
  constructor() {
    this.name = 'SystemErrorNode';
  }

  async execute(ctx) {
    console.error(`Custom Orchestrator Failure Trace for User [${ctx.telegramUserId}]: ${ctx.error}`);
    const isColdStart = ctx.error?.includes('timeout') || ctx.error?.includes('cold-starting') || ctx.error?.includes('hang up');
    ctx.ragAnswer = isColdStart
      ? '⏳ My knowledge service is warming up after a period of inactivity. Please send your message again in about 30 seconds!'
      : "I'm experiencing a brief system error while reaching my knowledge cluster. Please try again shortly!";
    return ctx;
  }
}

module.exports = {
  RouterNode,
  RagExecutionNode,
  ErrorHandlingNode
};