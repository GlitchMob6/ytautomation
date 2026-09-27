const { Logger } = require('./logger');
const { MediaEnhancementService } = require('./media-enhancement-service');

class DeepCleanService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('DeepClean');
    this.enhancementService = options.enhancementService || new MediaEnhancementService({ logger: this.logger });
  }

  /**
   * Generates a multi-pass enhancement configuration.
   * "Deep Clean" applies maximum repair efforts to noisy/low-quality media.
   */
  getDeepCleanConfig(probeData = {}) {
    this.logger.info('Analyzing probe data for Deep Clean configuration');

    const config = {
      video: {
        denoise: true,
        deblock: true,
        colorCorrect: true,
        sharpen: true
      },
      audio: {
        normalize: true,
        denoiseAudio: true,
        compressor: true
      }
    };

    // If probe data indicates it's already high quality, we might disable some filters
    if (probeData.format && probeData.format.bit_rate) {
      const bitRate = parseInt(probeData.format.bit_rate, 10);
      if (bitRate > 5000000) {
        // High bitrate video might not need heavy deblocking
        this.logger.info('High bitrate detected, disabling deblock filter');
        config.video.deblock = false;
      }
    }

    return config;
  }

  /**
   * Applies the deep clean filter configuration to an FFmpeg argument array.
   */
  applyDeepClean(args, probeData = {}) {
    const config = this.getDeepCleanConfig(probeData);
    
    // Create combined options object
    const options = {
      ...config.video,
      ...config.audio
    };

    this.logger.info(`Applying Deep Clean enhancements: ${JSON.stringify(options)}`);
    
    return this.enhancementService.applyEnhancements(args, options);
  }
}

module.exports = { DeepCleanService };
