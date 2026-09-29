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

  async generate(options) {
    throw new Error('generate() must be implemented');
  }
}

module.exports = { BaseProvider };
