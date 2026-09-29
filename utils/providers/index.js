const { ProviderRouter } = require('./provider-router');
const { GeminiLLMProvider, QwenLocalLLMProvider, OpenAILLMProvider } = require('./llm-provider');
const { GeminiTTSProvider, QwenLocalTTSProvider, KokoroLocalTTSProvider, OpenAITTSProvider, ElevenLabsTTSProvider, FreeTTSProvider } = require('./tts-provider');
const { GeminiImageProvider, FluxLocalImageProvider, OpenAIImageProvider, FreeImageProvider } = require('./image-provider');
const { SlideshowVideoProvider } = require('./video-provider');

function createProviderRouter(credentials, logger) {
  const router = new ProviderRouter(logger);

  // Read credentials (assume standard CredentialManager structure)
  const geminiKey = credentials?.gemini?.apiKey || process.env.GEMINI_API_KEY;

  // --- LLM ---
  // Local first
  router.registerProvider(new QwenLocalLLMProvider());

  // Hosted OSS
  const PROVIDERS = {
    openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6', envKey: 'OPENAI_API_KEY' },
    openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-5.6-sol', envKey: 'OPENROUTER_API_KEY' },
    kimi: { name: 'Kimi (Moonshot AI)', baseURL: 'https://api.moonshot.ai/v1', defaultModel: 'kimi-k3', envKey: 'MOONSHOT_API_KEY' },
    mimo: { name: 'MiMo (Xiaomi)', baseURL: 'https://api.xiaomimimo.com/v1', defaultModel: 'mimo-v2.5-pro', envKey: 'MIMO_API_KEY' },
    glm: { name: 'GLM (Zhipu AI)', baseURL: 'https://api.z.ai/api/paas/v4/', defaultModel: 'glm-5.3', envKey: 'GLM_API_KEY' }
  };
  
  const providerType = credentials?.aiProvider?.provider;
  if (providerType === 'ollama' && credentials?.aiProvider?.endpointUrl) {
    let url = credentials.aiProvider.endpointUrl.replace(/\/$/, '');
    if (!url.endsWith('/v1')) url += '/v1';
    router.registerProvider(new QwenLocalLLMProvider(url, credentials.aiProvider.model || 'qwen2.5:9b'));
  } else if (providerType && PROVIDERS[providerType] && credentials?.aiProvider?.apiKey) {
    const p = PROVIDERS[providerType];
    router.registerProvider(new OpenAILLMProvider(providerType, p.name, credentials.aiProvider.apiKey, p.baseURL, credentials.aiProvider.model || p.defaultModel));
  } else {
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const key = process.env[p.envKey];
      if (key) router.registerProvider(new OpenAILLMProvider(id, p.name, key, p.baseURL, p.defaultModel));
    }
  }

  if (geminiKey) {
    router.registerProvider(new GeminiLLMProvider(geminiKey, credentials?.gemini?.model));
  }

  // --- TTS ---
  if (geminiKey) {
    router.registerProvider(new GeminiTTSProvider(geminiKey, process.env.GEMINI_TTS_MODEL));
  }
  const openaiKey = credentials?.openai?.apiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    router.registerProvider(new OpenAITTSProvider(openaiKey));
  }
  const elevenLabsKey = credentials?.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
  const elevenLabsVoiceId = credentials?.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (elevenLabsKey && elevenLabsVoiceId) {
    router.registerProvider(new ElevenLabsTTSProvider(elevenLabsKey, elevenLabsVoiceId, process.env.ELEVENLABS_TTS_MODEL));
  }
  router.registerProvider(new QwenLocalTTSProvider()); // Stubbed for Phase 4
  router.registerProvider(new KokoroLocalTTSProvider()); // Stubbed for Phase 4
  router.registerProvider(new FreeTTSProvider()); // Guaranteed fallback

  // --- Image ---
  if (geminiKey) {
    router.registerProvider(new GeminiImageProvider(geminiKey, process.env.GEMINI_IMAGE_MODEL));
  }
  if (openaiKey) {
    router.registerProvider(new OpenAIImageProvider(openaiKey));
  }
  router.registerProvider(new FluxLocalImageProvider()); // Stubbed for Phase 4
  router.registerProvider(new FreeImageProvider()); // Guaranteed fallback

  // --- Video ---
  router.registerProvider(new SlideshowVideoProvider());

  return router;
}

module.exports = { createProviderRouter };
