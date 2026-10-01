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
  constructor(credentials = {}, options = {}) {
    this.logger = new Logger('AITextService');
    this.db = options.db || null;
    // Router initialized async via initialize()
  }

  async initialize(credentials = {}) {
    this.router = await createProviderRouter(credentials, this.logger, this.db);

    // Compatibility surface for callers that historically inspected the
    // OpenAI client directly (the router remains the source of truth).
    const configuredProvider = credentials?.aiProvider?.provider;
    const configured = configuredProvider
      ? this.router.providers.llm.find(provider => provider.id === configuredProvider)
      : this.router.providers.llm.find(provider => provider.id !== 'qwen-local');
    if (configured) {
      this.client = configured.client;
      this.model = configured.model;
      this.providerName = configured.name;
    }
  }

  async generateText(prompt, options = {}) {
    // Support lightweight Gemini fixtures and older integrations that create a
    // service prototype with a `gemini` client instead of the provider router.
    if (this.gemini?.models?.generateContent && !this.router) {
      const config = { maxOutputTokens: options.maxTokens || 2048 };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(this.model || '')) {
        if (options.temperature !== undefined) config.temperature = options.temperature;
      }
      const response = await this.gemini.models.generateContent({ model: this.model, contents: prompt, config });
      const text = response?.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Gemini returned an empty response.');
      return text;
    }
    const { result, provider } = await this.router.executeWithFailover('llm', 'generate', { prompt, ...options });
    this.providerId = provider.id;
    this.providerName = provider.name;
    this.providerModel = provider.model;
    this.client = provider.client;
    this.model = provider.model;
    if (typeof result !== 'string' || !result.trim()) throw new Error('AI text provider returned an empty response.');
    return result;
  }

}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
