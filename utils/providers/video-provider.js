const { BaseProvider } = require('./base-provider');

class SlideshowVideoProvider extends BaseProvider {
  constructor() {
    super('slideshow', 'FFmpeg Slideshow', 'video');
  }

  async checkAvailability() {
    const { checkFFmpeg } = require('../ffmpeg');
    return await checkFFmpeg();
  }

  async generate(options) {
    // Phase 4/5 integration point for video assembly
    // For now, this just acts as a router destination
    throw new Error('Slideshow generation logic belongs in media-generation-service for now');
  }
}

module.exports = { SlideshowVideoProvider };
