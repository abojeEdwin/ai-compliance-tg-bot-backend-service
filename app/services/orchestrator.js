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
      const response = await axios.post(process.env.PYTHON_RAG_SERVICE_URL, {
        prompt: ctx.rawInput,
        history: history
      });

      ctx.ragAnswer = response.data.answer;
      return ctx;
    } catch (err) {
      ctx.error = err.message || 'Error occurred during Python RAG evaluation';
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
    ctx.ragAnswer = "I'm experiencing a brief system connection error while reaching my knowledge cluster. Please try again shortly!";
    return ctx;
  }
}

module.exports = {
  RouterNode,
  RagExecutionNode,
  ErrorHandlingNode
};