const { ProviderRouter } = require('./provider-router');
const { GeminiLLMProvider, QwenLocalLLMProvider, OpenAILLMProvider } = require('./llm-provider');
const { GeminiTTSProvider, QwenLocalTTSProvider, KokoroLocalTTSProvider, OpenAITTSProvider, ElevenLabsTTSProvider, FreeTTSProvider } = require('./tts-provider');
const { GeminiImageProvider, FluxLocalImageProvider, OpenAIImageProvider, FreeImageProvider } = require('./image-provider');
const { SlideshowVideoProvider } = require('./video-provider');
const BrowserProvider = require('./browser-provider');
const { AUTHORITATIVE_PROVIDER_DICTIONARY, ReadinessState } = require('../model-capability-registry');
const { ProviderHealthStore } = require('./provider-health-store');

async function createProviderRouter(credentials, logger, db) {
  const router = new ProviderRouter(logger);
  const readiness = new ReadinessState();

  // Wire persistent health store if a database instance is available
  if (db) {
    const healthStore = new ProviderHealthStore(db, logger);
    await healthStore.initialize();
    router.setHealthStore(healthStore);
  }

  // Helper to extract credentials
  const getCred = (envKey, credPath) => {
    if (credPath) {
      const parts = credPath.split('.');
      let val = credentials;
      for (const p of parts) val = val?.[p];
      if (val) return val;
    }
    return process.env[envKey];
  };

  // Factory mapping
  const factory = {
    'qwen-local': () => {
      const endpoint = credentials?.aiProvider?.provider === 'ollama' ? credentials.aiProvider.endpointUrl : null;
      let url = endpoint ? endpoint.replace(/\/$/, '') : null;
      if (url && !url.endsWith('/v1')) url += '/v1';
      return new QwenLocalLLMProvider(url, credentials?.aiProvider?.model || 'qwen2.5:9b');
    },
    'openai': () => new OpenAILLMProvider('openai', 'OpenAI', getCred('OPENAI_API_KEY', 'aiProvider.apiKey'), 'https://api.openai.com/v1', credentials?.aiProvider?.model || 'gpt-5.6'),
    'gemini': () => new GeminiLLMProvider(getCred('GEMINI_API_KEY', 'gemini.apiKey'), credentials?.gemini?.model),
    'pollinations': () => new FreeImageProvider(),
    'flux-local': () => new FluxLocalImageProvider(),
    'openai-image': () => new OpenAIImageProvider(getCred('OPENAI_API_KEY', 'openai.apiKey')),
    'gemini-image': () => new GeminiImageProvider(getCred('GEMINI_API_KEY', 'gemini.apiKey'), process.env.GEMINI_IMAGE_MODEL),
    'free-tts': () => new FreeTTSProvider(),
    'openai-tts': () => new OpenAITTSProvider(getCred('OPENAI_API_KEY', 'openai.apiKey')),
    'gemini-tts': () => new GeminiTTSProvider(getCred('GEMINI_API_KEY', 'gemini.apiKey'), process.env.GEMINI_TTS_MODEL),
    'ffmpeg-slideshow': () => new SlideshowVideoProvider(),
    'openai-whisper': () => null, // Stubbed
    'system-browser': () => new BrowserProvider()
  };

  const probes = [];

  for (const entry of AUTHORITATIVE_PROVIDER_DICTIONARY) {
    const creator = factory[entry.id];
    let providerInstance = null;
    let probePromise = null;

    if (creator) {
      try {
        providerInstance = creator();
      } catch (err) {
        // Failed to instantiate
      }
    }

    if (providerInstance) {
      router.registerProvider(providerInstance, entry);
      readiness.setOptionState(entry, 'probing');
      probePromise = providerInstance.probe().then(res => {
        readiness.updateFromProbe(entry, res);
      });
    } else {
      readiness.setOptionState(entry, 'missing', 'Provider implementation missing, credentials absent, or failed to initialize');
      probePromise = Promise.resolve();
    }
    
    probes.push(probePromise);
  }

  // Wait for all lightweight probes to complete
  await Promise.all(probes);
  
  router.readiness = readiness;
  return router;
}

module.exports = { createProviderRouter, ProviderHealthStore };
