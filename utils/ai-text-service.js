const { Logger } = require('./logger');
const { createProviderRouter } = require('./providers/index');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: { name: 'OpenAI', defaultModel: 'gpt-5.6' },
  openrouter: { name: 'OpenRouter', defaultModel: 'openai/gpt-5.6-sol' },
  kimi: { name: 'Kimi (Moonshot AI)', defaultModel: 'kimi-k3' },
  mimo: { name: 'MiMo (Xiaomi)', defaultModel: 'mimo-v2.5-pro' },
  glm: { name: 'GLM (Zhipu AI)', defaultModel: 'glm-5.3' },
};

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.router = createProviderRouter(credentials, this.logger);
  }

  async generateText(prompt, options = {}) {
    const provider = await this.router.getBestProvider('llm');
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.providerModel = provider.model;
    return await provider.generate({ prompt, ...options });
  }

}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
