class BaseProvider {
  constructor(id, name, type) {
    this.id = id;
    this.name = name;
    this.type = type; // llm, tts, image, video, transcribe
    this.isAvailable = false;
  }

  async checkAvailability() {
    throw new Error('checkAvailability() must be implemented');
  }

  /**
   * Extremely lightweight check to determine if the provider is actually usable.
   * This should NOT perform a full generation if a lighter check (e.g., config
   * validation, health endpoint, tiny local validation) is possible.
   * Caches results and respects provider rate limits.
   * @returns {Promise<{usable: boolean, reason?: string}>}
   */
  async probe() {
    // Default fallback to checkAvailability for backward compatibility
    try {
      const isAvail = await this.checkAvailability();
      return { usable: isAvail, reason: isAvail ? 'Available' : 'checkAvailability returned false' };
    } catch (err) {
      return { usable: false, reason: err.message };
    }
  }

  async generate(options) {
    throw new Error('generate() must be implemented');
  }
}

module.exports = { BaseProvider };
