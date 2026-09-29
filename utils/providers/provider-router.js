class ProviderRouter {
  constructor(logger) {
    this.logger = logger || console;
    this.providers = {
      llm: [],
      tts: [],
      image: [],
      video: [],
      transcribe: []
    };
  }

  registerProvider(provider) {
    if (this.providers[provider.type]) {
      this.providers[provider.type].push(provider);
      this.logger.info(`Registered ${provider.type} provider: ${provider.name}`);
    } else {
      this.logger.error(`Unknown provider type: ${provider.type}`);
    }
  }

  async getBestProvider(type) {
    const list = this.providers[type];
    if (!list || list.length === 0) {
      throw new Error(`No providers registered for type: ${type}`);
    }

    // Sort by priority/availability in the future, for now just find first available
    for (const provider of list) {
      if (await provider.checkAvailability()) {
        return provider;
      }
    }

    throw new Error(`No available providers found for type: ${type}`);
  }

  async generateText(options) {
    const provider = await this.getBestProvider('llm');
    return provider.generate(options);
  }

  async generateSpeech(options) {
    const provider = await this.getBestProvider('tts');
    return provider.generate(options);
  }

  async generateImage(options) {
    const provider = await this.getBestProvider('image');
    return provider.generate(options);
  }

  async generateVideo(options) {
    const provider = await this.getBestProvider('video');
    return provider.generate(options);
  }

  async transcribe(options) {
    const provider = await this.getBestProvider('transcribe');
    return provider.generate(options);
  }
}

module.exports = { ProviderRouter };
