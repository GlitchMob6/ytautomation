const { BaseProvider } = require('./base-provider');

class GeminiLLMProvider extends BaseProvider {
  constructor(apiKey, model) {
    super('gemini-llm', 'Google Gemini LLM', 'llm');
    this.apiKey = apiKey;
    this.model = model || 'gemini-3.7-flash';
    this.client = null;
  }

  async checkAvailability() {
    if (!this.apiKey) return false;
    try {
      if (!this.client) {
        const { GoogleGenAI } = require('@google/genai');
        this.client = new GoogleGenAI({ apiKey: this.apiKey });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async generate(options) {
    const prompt = options.prompt;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    const config = { maxOutputTokens: maxTokens };
    if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(this.model)) {
      config.temperature = temperature;
    }

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config,
    });
    
    const text = response && response.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`Gemini LLM returned an empty response.`);
    }
    return text;
  }
}

// Local Qwen LLM Provider for Phase 4
const OpenAI = require('openai');

class QwenLocalLLMProvider extends BaseProvider {
  constructor(baseURL = 'http://127.0.0.1:11434/v1', model = 'qwen2.5') {
    super('qwen-local', 'Qwen Local (OpenAI Compatible)', 'llm');
    this.baseURL = baseURL; // Default to Ollama/LMStudio default port
    this.model = model;
    this.client = new OpenAI({ apiKey: 'local', baseURL: this.baseURL });
  }

  async checkAvailability() {
    try {
      const response = await this.client.models.list();
      const models = response.data.map(m => m.id);
      return models.includes(this.model);
    } catch (e) {
      return false;
    }
  }

  async generate(options) {
    const prompt = options.prompt;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Qwen Local returned an empty response.');
    }
    return content;
  }
}

class OpenAILLMProvider extends BaseProvider {
  constructor(id, name, apiKey, baseURL, model) {
    super(id, name, 'llm');
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async checkAvailability() {
    return !!this.apiKey;
  }

  async generate(options) {
    const prompt = options.prompt;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    const params = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    };

    try {
      const response = await this.client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens,
      });
      return response.choices?.[0]?.message?.content;
    } catch (error) {
      if (error && error.status === 400 && /max(_completion)?_tokens/i.test(error.message || '')) {
        const response = await this.client.chat.completions.create({
          ...params,
          max_tokens: maxTokens,
        });
        return response.choices?.[0]?.message?.content;
      }
      throw error;
    }
  }
}

module.exports = { GeminiLLMProvider, QwenLocalLLMProvider, OpenAILLMProvider };
