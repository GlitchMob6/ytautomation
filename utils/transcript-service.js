const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { runFFmpeg } = require('./ffmpeg');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3'];

class TranscriptService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('Transcript');
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data', 'remix');
    this.whisperPath = options.whisperPath || process.env.WHISPER_PATH || 'whisper';
    this.whisperModel = options.whisperModel || process.env.WHISPER_MODEL || 'base';
    this.whisperLanguage = options.whisperLanguage || process.env.WHISPER_LANGUAGE || null;
    this.maxDurationSeconds = Number(options.maxDurationSeconds || process.env.TRANSCRIPT_MAX_DURATION || 7200);
  }

  /**
   * Transcribe a source media file.
   * Extracts audio, runs Whisper, parses output, stores result.
   */
  async transcribe(sourceId, options = {}) {
    const source = await this.db.getRemixSource(sourceId);
    if (!source) throw this.notFound('Source not found');

    // Check for existing transcript
    const existing = await this.db.getRemixTranscript(sourceId);
    if (existing && existing.status === 'completed' && options.force !== true) {
      this.logger.info(`Using existing transcript for ${sourceId}`);
      return existing;
    }

    if (source.duration > this.maxDurationSeconds) {
      throw this.invalid(`Source duration (${Math.round(source.duration)}s) exceeds maximum (${this.maxDurationSeconds}s). Set TRANSCRIPT_MAX_DURATION to increase.`);
    }

    const model = options.model || this.whisperModel;
    const language = options.language || this.whisperLanguage;

    // Create a pending transcript record
    await this.db.saveRemixTranscript({
      sourceId,
      provider: 'whisper',
      model,
      language: language || 'auto',
      fullText: '',
      segments: [],
      status: 'processing',
      error: null
    });

    try {
      // Step 1: Extract audio to WAV for Whisper
      const audioPath = await this.extractAudio(source);

      // Step 2: Run Whisper transcription
      const whisperAvailable = await this.checkWhisper();
      let result;

      if (whisperAvailable) {
        result = await this.runWhisper(audioPath, { model, language });
      } else {
        // Fallback: generate a placeholder indicating Whisper is needed
        this.logger.warn('Whisper is not installed. Install it with: pip install openai-whisper');
        result = this.generatePlaceholderTranscript(source);
      }

      // Step 3: Store the transcript
      const transcript = await this.db.saveRemixTranscript({
        sourceId,
        provider: whisperAvailable ? 'whisper' : 'placeholder',
        model: whisperAvailable ? model : 'none',
        language: result.language || language || 'auto',
        fullText: result.text,
        segments: result.segments,
        status: 'completed',
        error: null
      });

      this.logger.info(`Transcription complete: ${result.segments.length} segments, ${result.text.length} characters`);
      return transcript;
    } catch (error) {
      await this.db.saveRemixTranscript({
        sourceId,
        provider: 'whisper',
        model,
        language: language || 'auto',
        fullText: '',
        segments: [],
        status: 'failed',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Extract audio from source file as a 16kHz mono WAV for Whisper.
   */
  async extractAudio(source) {
    const outputDir = path.join(this.dataRoot, 'audio', source.id);
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'transcript_input.wav');

    await runFFmpeg([
      '-y', '-i', source.file_path,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-vn',
      outputPath
    ]);

    const stat = await fs.stat(outputPath).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new Error('Audio extraction produced no output');
    }
    return outputPath;
  }

  /**
   * Check if Whisper CLI is available.
   */
  async checkWhisper() {
    try {
      await execFileAsync(this.whisperPath, ['--help'], { timeout: 10000 });
      return true;
    } catch (error) {
      // Some whisper builds don't support --help cleanly
      if (error.stderr && (error.stderr.includes('whisper') || error.stderr.includes('usage'))) {
        return true;
      }
      return false;
    }
  }

  /**
   * Run Whisper transcription and parse the output.
   */
  async runWhisper(audioPath, options = {}) {
    const model = options.model || this.whisperModel;
    const language = options.language;
    const outputDir = path.dirname(audioPath);

    const args = [
      audioPath,
      '--model', model,
      '--output_format', 'json',
      '--output_dir', outputDir,
      '--word_timestamps', 'True'
    ];

    if (language) {
      args.push('--language', language);
    }

    this.logger.info(`Running Whisper (model: ${model})...`);

    return new Promise((resolve, reject) => {
      const child = spawn(this.whisperPath, args, {
        timeout: this.maxDurationSeconds * 2 * 1000,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let _stdout = '';
      let stderr = '';

      child.stdout.on('data', data => { _stdout += data; });
      child.stderr.on('data', data => { stderr += data; });

      child.on('close', async (code) => {
        if (code !== 0) {
          return reject(new Error(`Whisper exited with code ${code}: ${stderr.slice(0, 500)}`));
        }

        try {
          // Whisper outputs a JSON file named after the input
          const baseName = path.basename(audioPath, path.extname(audioPath));
          const jsonPath = path.join(outputDir, `${baseName}.json`);
          const jsonContent = await fs.readFile(jsonPath, 'utf8');
          const data = JSON.parse(jsonContent);
          resolve(this.parseWhisperOutput(data));
        } catch (parseError) {
          reject(new Error(`Failed to parse Whisper output: ${parseError.message}`));
        }
      });

      child.on('error', error => {
        reject(new Error(`Failed to run Whisper: ${error.message}`));
      });
    });
  }

  /**
   * Parse Whisper JSON output into normalized segments.
   */
  parseWhisperOutput(data) {
    const segments = (data.segments || []).map((seg, index) => ({
      index,
      start: Number(seg.start || 0),
      end: Number(seg.end || 0),
      text: String(seg.text || '').trim(),
      words: (seg.words || []).map(w => ({
        word: String(w.word || '').trim(),
        start: Number(w.start || 0),
        end: Number(w.end || 0),
        probability: Number(w.probability || 0)
      })),
      avgLogprob: seg.avg_logprob || null,
      noSpeechProb: seg.no_speech_prob || null
    }));

    const fullText = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();

    return {
      text: fullText,
      language: data.language || null,
      segments
    };
  }

  /**
   * Generate a placeholder transcript when Whisper is not available.
   * Marks it clearly as a placeholder so it can be replaced later.
   */
  generatePlaceholderTranscript(source) {
    const segmentDuration = 30;
    const segmentCount = Math.max(1, Math.ceil(source.duration / segmentDuration));
    const segments = [];

    for (let i = 0; i < segmentCount; i++) {
      const start = i * segmentDuration;
      const end = Math.min((i + 1) * segmentDuration, source.duration);
      segments.push({
        index: i,
        start,
        end,
        text: `[Transcription pending: ${this.formatTime(start)} – ${this.formatTime(end)}]`,
        words: [],
        avgLogprob: null,
        noSpeechProb: null
      });
    }

    return {
      text: `[Transcription unavailable — install Whisper: pip install openai-whisper]`,
      language: null,
      segments
    };
  }

  /**
   * Align transcript segments to detected scenes.
   * Returns scenes enriched with their corresponding transcript text.
   */
  async alignToScenes(sourceId) {
    const transcript = await this.db.getRemixTranscript(sourceId);
    if (!transcript || transcript.status !== 'completed') {
      throw this.invalid('A completed transcript is required for scene alignment');
    }

    const scenes = await this.db.listRemixSourceScenes(sourceId);
    if (!scenes.length) {
      throw this.invalid('Source scenes must be analyzed before alignment');
    }

    const segments = transcript.segments || [];

    return scenes.map(scene => {
      const overlapping = segments.filter(seg =>
        seg.start < scene.end_time && seg.end > scene.start_time
      );

      const text = overlapping.map(seg => seg.text).join(' ').replace(/\s+/g, ' ').trim();

      return {
        ...scene,
        transcriptText: text,
        transcriptSegmentCount: overlapping.length,
        transcriptWordCount: text.split(/\s+/).filter(Boolean).length
      };
    });
  }

  /**
   * Get the transcript for a source.
   */
  async getTranscript(sourceId) {
    const transcript = await this.db.getRemixTranscript(sourceId);
    if (!transcript) throw this.notFound('Transcript not found');
    return transcript;
  }

  formatTime(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.round(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  invalid(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
  }

  notFound(message) {
    const error = new Error(message);
    error.status = 404;
    return error;
  }
}

module.exports = { TranscriptService, WHISPER_MODELS };
