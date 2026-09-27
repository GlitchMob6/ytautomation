const { Logger } = require('./logger');

class MediaEnhancementService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('MediaEnhancement');
  }

  /**
   * Generates FFmpeg video filtergraph strings for various enhancements
   */
  getVideoFilters(options = {}) {
    const filters = [];

    if (options.denoise) {
      // hqdn3d is a high-quality 3D denoise filter
      filters.push('hqdn3d=4.0:3.0:6.0:4.5');
    }

    if (options.deblock) {
      // pp (postprocessing) for deblocking
      filters.push('pp=al');
    }

    if (options.colorCorrect) {
      // eq filter for basic color correction: contrast, brightness, saturation, gamma
      filters.push('eq=contrast=1.1:brightness=0.02:saturation=1.2:gamma=1.05');
    }

    if (options.sharpen) {
      // unsharp mask
      filters.push('unsharp=5:5:1.0:5:5:0.0');
    }

    return filters.join(',');
  }

  /**
   * Generates FFmpeg audio filtergraph strings for enhancements
   */
  getAudioFilters(options = {}) {
    const filters = [];

    if (options.normalize) {
      // loudnorm for EBU R128 loudness normalization
      filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    }

    if (options.denoiseAudio) {
      // afftdn for Fast Fourier Transform Noise Reduction
      filters.push('afftdn=nf=-25');
    }
    
    if (options.compressor) {
      // acompressor for dynamic range compression
      filters.push('acompressor=threshold=-20dB:ratio=4:attack=5:release=50:makeup=2');
    }

    return filters.join(',');
  }

  /**
   * Apply enhancements to an FFmpeg argument array
   */
  applyEnhancements(args, options = {}) {
    const vFilters = this.getVideoFilters(options);
    const aFilters = this.getAudioFilters(options);

    // This is a naive injection that assumes simple inputs.
    // In a complex filtergraph (like the renderer), these need to be integrated
    // into the specific video/audio nodes.
    
    if (vFilters) {
      const vIdx = args.indexOf('-vf');
      if (vIdx > -1) {
        args[vIdx + 1] = `${args[vIdx + 1]},${vFilters}`;
      } else {
        args.push('-vf', vFilters);
      }
    }

    if (aFilters) {
      const aIdx = args.indexOf('-af');
      if (aIdx > -1) {
        args[aIdx + 1] = `${args[aIdx + 1]},${aFilters}`;
      } else {
        args.push('-af', aFilters);
      }
    }

    return args;
  }
}

module.exports = { MediaEnhancementService };
