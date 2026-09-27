const { Logger } = require('./logger');

class AudioSyncService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('AudioSync');
  }

  /**
   * Analyzes an FFmpeg probe result to check if audio drift exceeds a threshold.
   */
  detectDrift(videoDuration, audioDuration, thresholdSeconds = 0.5) {
    if (!videoDuration || !audioDuration) return 0;
    const diff = audioDuration - videoDuration;
    
    if (Math.abs(diff) > thresholdSeconds) {
      this.logger.warn(`Audio drift detected: ${diff.toFixed(3)}s difference`);
      return diff;
    }
    
    return 0;
  }

  /**
   * Calculates the tempo adjustment required to stretch/squeeze audio to match video duration.
   */
  calculateTempoAdjustment(videoDuration, audioDuration) {
    if (!videoDuration || !audioDuration) return 1.0;
    
    // tempo = audioDuration / videoDuration (e.g. 10s audio for 5s video needs tempo 2.0 to speed up)
    const tempo = audioDuration / videoDuration;
    
    // FFmpeg atempo limits are 0.5 to 2.0 per filter
    return Math.max(0.5, Math.min(2.0, tempo));
  }

  /**
   * Returns FFmpeg audio filter strings to repair A/V sync issues
   */
  getRepairFilters(videoDuration, audioDuration, options = {}) {
    const diff = this.detectDrift(videoDuration, audioDuration, options.threshold || 0.1);
    
    if (diff === 0) return null;

    if (options.method === 'stretch') {
      const tempo = this.calculateTempoAdjustment(videoDuration, audioDuration);
      if (tempo !== 1.0) {
        return `atempo=${tempo.toFixed(4)}`;
      }
    } else {
      // Default method: trim or pad
      if (diff > 0) {
        // Audio is longer than video -> trim audio
        return `atrim=0:${videoDuration}`;
      } else {
        // Audio is shorter than video -> pad audio (apad)
        return 'apad';
      }
    }

    return null;
  }
}

module.exports = { AudioSyncService };
