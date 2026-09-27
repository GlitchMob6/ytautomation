const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { runFFmpeg, getFFprobePath } = require('./ffmpeg');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

class MediaAnalysisService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('MediaAnalysis');
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data', 'remix');
  }

  /**
   * Run full media analysis on an ingested source.
   * Performs scene detection, frame sampling, and audio inspection.
   */
  async analyze(sourceId, options = {}) {
    const source = await this.db.getRemixSource(sourceId);
    if (!source) throw this.notFound('Source not found');

    this.logger.info(`Analyzing source: ${source.id} (${path.basename(source.file_path)})`);

    const results = {
      sourceId,
      resolution: source.resolution,
      width: source.width,
      height: source.height,
      duration: source.duration,
      aspectRatio: this.computeAspectRatio(source.width, source.height),
      frameRate: source.frame_rate,
      audioInfo: {
        codec: source.audio_codec,
        sampleRate: source.sample_rate,
        channels: source.channels
      }
    };

    // Scene/shot detection
    if (source.media_type === 'video' && source.duration > 0) {
      results.scenes = await this.detectScenes(source, options);
    } else {
      results.scenes = [];
    }

    // Frame sampling
    if (source.media_type === 'video' && source.duration > 0) {
      results.frameSamples = await this.sampleFrames(source, options);
    } else {
      results.frameSamples = [];
    }

    this.logger.info(`Analysis complete: ${results.scenes.length} scenes detected, ${results.frameSamples.length} frames sampled`);
    return results;
  }

  /**
   * Detect scene/shot boundaries using FFmpeg's scene detection filter.
   * Uses a configurable threshold; default 0.3 works well for most content.
   */
  async detectScenes(source, options = {}) {
    const threshold = Math.max(0.1, Math.min(0.9, Number(options.sceneThreshold || 0.3)));
    const maxScenes = Math.max(1, Math.min(500, Number(options.maxScenes || 200)));

    try {
      const { stderr } = await this.runFFmpegCapture([
        '-i', source.file_path,
        '-filter:v', `select='gt(scene\\,${threshold})',showinfo`,
        '-f', 'null', '-'
      ]);

      const scenes = this.parseSceneDetection(stderr, source.duration);
      const limited = scenes.slice(0, maxScenes);

      // Store scenes in the database
      const stored = [];
      for (let i = 0; i < limited.length; i++) {
        const scene = limited[i];
        const endTime = i < limited.length - 1 ? limited[i + 1].startTime : source.duration;
        const saved = await this.db.createRemixSourceScene({
          sourceId: source.id,
          position: i,
          startTime: scene.startTime,
          endTime,
          duration: endTime - scene.startTime,
          sceneType: scene.sceneType || 'cut',
          confidence: scene.confidence,
          framePath: null,
          description: `Scene ${i + 1}: ${this.formatTime(scene.startTime)} – ${this.formatTime(endTime)}`
        });
        stored.push(saved);
      }

      // If no scenes detected, create a single scene spanning the whole video
      if (stored.length === 0) {
        const saved = await this.db.createRemixSourceScene({
          sourceId: source.id,
          position: 0,
          startTime: 0,
          endTime: source.duration,
          duration: source.duration,
          sceneType: 'full',
          confidence: 1.0,
          framePath: null,
          description: `Full video: ${this.formatTime(0)} – ${this.formatTime(source.duration)}`
        });
        stored.push(saved);
      }

      return stored;
    } catch (error) {
      this.logger.warn(`Scene detection failed, creating single-scene fallback: ${error.message}`);
      const saved = await this.db.createRemixSourceScene({
        sourceId: source.id,
        position: 0,
        startTime: 0,
        endTime: source.duration,
        duration: source.duration,
        sceneType: 'full',
        confidence: 1.0,
        framePath: null,
        description: `Full video: ${this.formatTime(0)} – ${this.formatTime(source.duration)}`
      });
      return [saved];
    }
  }

  /**
   * Parse FFmpeg scene detection output from stderr.
   */
  parseSceneDetection(stderr, totalDuration) {
    const scenes = [];
    const output = String(stderr || '');

    // Parse showinfo filter output for pts_time values
    const regex = /pts_time:\s*([\d.]+)/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      const time = Number(match[1]);
      if (Number.isFinite(time) && time >= 0 && time <= totalDuration) {
        scenes.push({
          startTime: time,
          sceneType: 'cut',
          confidence: 0.8
        });
      }
    }

    // Ensure we always have a scene starting at 0
    if (scenes.length === 0 || scenes[0].startTime > 0.5) {
      scenes.unshift({ startTime: 0, sceneType: 'start', confidence: 1.0 });
    }

    // Deduplicate scenes that are too close together (< 0.5s)
    const deduped = [scenes[0]];
    for (let i = 1; i < scenes.length; i++) {
      if (scenes[i].startTime - deduped[deduped.length - 1].startTime >= 0.5) {
        deduped.push(scenes[i]);
      }
    }

    return deduped;
  }

  /**
   * Sample frames from the video at regular intervals.
   * Useful for visual analysis and thumbnail selection.
   */
  async sampleFrames(source, options = {}) {
    const count = Math.max(1, Math.min(100, Number(options.frameSampleCount || 10)));
    const interval = source.duration / (count + 1);
    const outputDir = path.join(this.dataRoot, 'frames', source.id);
    await fs.mkdir(outputDir, { recursive: true });

    const frames = [];
    for (let i = 0; i < count; i++) {
      const timestamp = Math.min(source.duration - 0.1, (i + 1) * interval);
      const outputPath = path.join(outputDir, `frame_${String(i).padStart(4, '0')}.jpg`);

      try {
        await runFFmpeg([
          '-y', '-ss', timestamp.toFixed(2),
          '-i', source.file_path,
          '-frames:v', '1',
          '-q:v', '2',
          outputPath
        ]);

        const stat = await fs.stat(outputPath).catch(() => null);
        if (stat && stat.size > 0) {
          frames.push({
            index: i,
            timestamp,
            path: outputPath,
            formattedTime: this.formatTime(timestamp)
          });
        }
      } catch (error) {
        this.logger.warn(`Frame sampling failed at ${this.formatTime(timestamp)}: ${error.message}`);
      }
    }

    return frames;
  }

  /**
   * Extract detailed audio stream information from a source file.
   */
  async inspectAudio(sourceId) {
    const source = await this.db.getRemixSource(sourceId);
    if (!source) throw this.notFound('Source not found');

    try {
      const { stdout } = await execFileAsync(getFFprobePath(), [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-select_streams', 'a',
        source.file_path
      ], { maxBuffer: 4 * 1024 * 1024 });

      const data = JSON.parse(stdout);
      return {
        sourceId,
        streams: (data.streams || []).map((s, i) => ({
          index: i,
          codec: s.codec_name,
          codecLong: s.codec_long_name,
          sampleRate: Number(s.sample_rate || 0),
          channels: Number(s.channels || 0),
          channelLayout: s.channel_layout || null,
          bitrate: Number(s.bit_rate || 0),
          duration: Number(s.duration || 0),
          sampleFormat: s.sample_fmt || null
        }))
      };
    } catch (error) {
      this.logger.warn(`Audio inspection failed: ${error.message}`);
      return {
        sourceId,
        streams: [{
          index: 0,
          codec: source.audio_codec,
          sampleRate: source.sample_rate,
          channels: source.channels,
          duration: source.duration
        }]
      };
    }
  }

  /**
   * Compute the display aspect ratio from width and height.
   */
  computeAspectRatio(width, height) {
    if (!width || !height) return null;
    const gcd = this.gcd(width, height);
    return `${width / gcd}:${height / gcd}`;
  }

  gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  }

  /**
   * Run FFmpeg and capture both stdout and stderr.
   * FFmpeg writes diagnostic output to stderr even on success.
   */
  async runFFmpegCapture(args) {
    const { getFFmpegPath } = require('./ffmpeg');
    try {
      return await execFileAsync(getFFmpegPath(), args, { maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      // FFmpeg returns non-zero exit code with -f null but still writes useful data to stderr
      if (error.stderr) {
        return { stdout: error.stdout || '', stderr: error.stderr };
      }
      throw error;
    }
  }

  formatTime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = (s % 60).toFixed(1);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(4, '0')}`;
    return `${m}:${String(sec).padStart(4, '0')}`;
  }

  notFound(message) {
    const error = new Error(message);
    error.status = 404;
    return error;
  }
}

module.exports = { MediaAnalysisService };
