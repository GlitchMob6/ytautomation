const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { getFFprobePath, getMediaDuration } = require('./ffmpeg');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SUPPORTED_VIDEO = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.wmv', '.ts', '.m4v']);
const SUPPORTED_AUDIO = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma', '.opus']);
const RIGHTS_STATUSES = new Set(['owned', 'licensed', 'fair_use', 'creative_commons', 'pending', 'unknown']);

class SourceIngestionService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('SourceIngestion');
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data', 'remix');
  }

  /**
   * Ingest a local media file as a remix source.
   * Validates the file, probes metadata, computes a checksum, and stores a record.
   */
  async ingest(input = {}) {
    const filePath = String(input.filePath || '').trim();
    if (!filePath) throw this.invalid('A file path is required');

    const resolved = path.resolve(filePath);
    const ext = path.extname(resolved).toLowerCase();
    const isVideo = SUPPORTED_VIDEO.has(ext);
    const isAudio = SUPPORTED_AUDIO.has(ext);
    if (!isVideo && !isAudio) {
      throw this.invalid(`Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_VIDEO, ...SUPPORTED_AUDIO].join(', ')}`);
    }
    const stat = await this.requireFile(resolved);

    this.logger.info(`Ingesting source media: ${path.basename(resolved)}`);

    // Probe media metadata
    const probe = await this.probeMedia(resolved);

    // Compute file checksum for deduplication
    const checksum = await this.computeChecksum(resolved);

    // Check for duplicate
    const existing = await this.db.getRemixSourceByChecksum(checksum);
    if (existing) {
      this.logger.info(`Source already ingested: ${existing.id}`);
      return existing;
    }

    // Normalize rights status
    const rightsStatus = RIGHTS_STATUSES.has(input.rightsStatus) ? input.rightsStatus : 'pending';

    const source = {
      filePath: resolved,
      originalUrl: this.text(input.originalUrl, 2000) || null,
      creatorName: this.text(input.creatorName, 300) || null,
      rightsStatus,
      duration: probe.duration,
      resolution: probe.resolution,
      width: probe.width,
      height: probe.height,
      codec: probe.videoCodec || null,
      audioCodec: probe.audioCodec || null,
      sampleRate: probe.sampleRate || null,
      channels: probe.channels || null,
      bitrate: probe.bitrate || null,
      frameRate: probe.frameRate || null,
      fileSize: stat.size,
      checksum,
      mediaType: isVideo ? 'video' : 'audio',
      notes: this.text(input.notes, 2000) || null
    };

    const saved = await this.db.createRemixSource(source);
    this.logger.info(`Source ingested: ${saved.id} (${probe.resolution || 'audio-only'}, ${this.formatDuration(probe.duration)})`);
    return saved;
  }

  /**
   * Probe a media file using FFprobe and return structured metadata.
   */
  async probeMedia(filePath) {
    try {
      const { stdout } = await execFileAsync(getFFprobePath(), [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ], { maxBuffer: 8 * 1024 * 1024 });

      const data = JSON.parse(stdout);
      return this.parseProbeData(data, filePath);
    } catch (error) {
      // Fallback: try to get at least duration
      this.logger.warn(`FFprobe JSON failed, falling back to duration-only: ${error.message}`);
      try {
        const duration = await getMediaDuration(filePath);
        return { duration, resolution: null, width: 0, height: 0, videoCodec: null, audioCodec: null, sampleRate: null, channels: null, bitrate: null, frameRate: null, streams: [] };
      } catch (fallbackError) {
        throw this.invalid(`Could not probe media file: ${fallbackError.message}`);
      }
    }
  }

  parseProbeData(data, _filePath) {
    const format = data.format || {};
    const streams = data.streams || [];
    const videoStream = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const duration = Number(format.duration || videoStream?.duration || audioStream?.duration || 0);
    const width = Number(videoStream?.width || 0);
    const height = Number(videoStream?.height || 0);
    const resolution = width && height ? `${width}x${height}` : null;

    let frameRate = null;
    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split('/');
      if (parts.length === 2 && Number(parts[1])) {
        frameRate = Math.round((Number(parts[0]) / Number(parts[1])) * 100) / 100;
      }
    }

    return {
      duration,
      resolution,
      width,
      height,
      videoCodec: videoStream?.codec_name || null,
      audioCodec: audioStream?.codec_name || null,
      sampleRate: Number(audioStream?.sample_rate || 0) || null,
      channels: Number(audioStream?.channels || 0) || null,
      bitrate: Number(format.bit_rate || 0) || null,
      frameRate,
      streams: streams.map(s => ({
        index: s.index,
        codecType: s.codec_type,
        codecName: s.codec_name,
        width: s.width,
        height: s.height,
        sampleRate: s.sample_rate,
        channels: s.channels,
        duration: Number(s.duration || 0) || null
      }))
    };
  }

  /**
   * Compute a SHA-256 checksum of the first 64MB of a file.
   * Hashing the entire file would be too slow for very large media files.
   */
  async computeChecksum(filePath) {
    const CHUNK_SIZE = 64 * 1024 * 1024;
    const fileHandle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, (await fileHandle.stat()).size));
      await fileHandle.read(buffer, 0, buffer.length, 0);
      return crypto.createHash('sha256').update(buffer).digest('hex');
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Retrieve a previously ingested source.
   */
  async getSource(sourceId) {
    const source = await this.db.getRemixSource(sourceId);
    if (!source) throw this.notFound('Source not found');
    return source;
  }

  /**
   * List all ingested sources.
   */
  async listSources(limit = 50) {
    return this.db.listRemixSources(limit);
  }

  /**
   * Update rights/provenance information for a source.
   */
  async updateRights(sourceId, input = {}) {
    const source = await this.getSource(sourceId);
    const changes = {};
    if (input.rightsStatus !== undefined) {
      if (!RIGHTS_STATUSES.has(input.rightsStatus)) throw this.invalid('Invalid rights status');
      changes.rightsStatus = input.rightsStatus;
    }
    if (input.creatorName !== undefined) changes.creatorName = this.text(input.creatorName, 300);
    if (input.originalUrl !== undefined) changes.originalUrl = this.text(input.originalUrl, 2000);
    if (input.notes !== undefined) changes.notes = this.text(input.notes, 2000);
    if (!Object.keys(changes).length) return source;
    return this.db.updateRemixSource(sourceId, changes);
  }

  async requireFile(filePath) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a file');
      if (stat.size === 0) throw new Error('File is empty');
      return stat;
    } catch (error) {
      throw this.invalid(`File not accessible: ${filePath} — ${error.message}`);
    }
  }

  text(value, limit) {
    return String(value || '').trim().slice(0, limit);
  }

  formatDuration(seconds) {
    if (!seconds) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    if (h > 0) return `${h}h${m}m${s}s`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
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

module.exports = { SourceIngestionService, SUPPORTED_VIDEO, SUPPORTED_AUDIO, RIGHTS_STATUSES };
