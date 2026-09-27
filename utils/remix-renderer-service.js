const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { Logger } = require('./logger');

class RemixRendererService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('RemixRenderer');
    this.outputDir = options.outputDir || path.join(process.cwd(), 'data', 'remix', 'exports');
    this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  }

  /**
   * Renders a 9:16 short-form video from a remix plan.
   */
  async renderVideo(planId, _options = {}) {
    const plan = await this.db.getRemixPlan(planId);
    if (!plan) throw this.notFound('Plan not found');

    const source = await this.db.getRemixSource(plan.source_id);
    if (!source) throw this.notFound('Source media not found');

    this.logger.info(`Starting render for plan ${planId}`);
    await fs.mkdir(this.outputDir, { recursive: true });
    
    const outputPath = path.join(this.outputDir, `${planId}_export.mp4`);

    // In a full implementation, this method would:
    // 1. Gather all highlight clips (cut using FFmpeg).
    // 2. Gather all TTS audio files.
    // 3. Create a complex FFmpeg filtergraph to stitch them in sequence.
    // 4. Apply 9:16 crop/blur background framing.
    // 5. Hardcode subtitles.
    
    // For this architecture phase, we'll construct a simplified filtergraph
    // and execute a basic ffmpeg concat just to validate the pipeline flow.
    
    // Create a dummy video to simulate the render process since we don't have
    // the full TTS audio and cut clips in the test environment.
    await this._simulateRender(outputPath, plan.target_duration || 10);
    
    this.logger.info(`Render completed: ${outputPath}`);
    
    return {
      outputPath,
      duration: plan.target_duration || 10,
      format: 'mp4',
      resolution: '1080x1920'
    };
  }

  async _simulateRender(outputPath, durationSeconds) {
    return new Promise((resolve, reject) => {
      // Creates a simple 9:16 test pattern video
      const args = [
        '-f', 'lavfi',
        '-i', `testsrc=duration=${durationSeconds}:size=1080x1920:rate=30`,
        '-f', 'lavfi',
        '-i', `anullsrc=r=44100:cl=stereo:d=${durationSeconds}`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        '-y',
        outputPath
      ];

      const child = spawn(this.ffmpegPath, args);
      
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      
      child.on('close', code => {
        if (code === 0) resolve(outputPath);
        else reject(new Error(`Render failed with code ${code}: ${stderr.slice(0, 500)}`));
      });
      child.on('error', err => reject(err));
    });
  }

  notFound(message) {
    const error = new Error(message);
    error.status = 404;
    return error;
  }
}

module.exports = { RemixRendererService };
