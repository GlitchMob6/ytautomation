const { execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let cachedPath = null;

/**
 * Resolve the FFmpeg binary to use, in order of preference:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled binary from the optional ffmpeg-static package
 * 3. `ffmpeg` on the system PATH
 */
function getFFmpegPath() {
  if (cachedPath) {
    return cachedPath;
  }

  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }

  try {
    cachedPath = require('ffmpeg-static');
  } catch (error) {
    cachedPath = null;
  }

  cachedPath = cachedPath || 'ffmpeg';
  return cachedPath;
}

async function checkFFmpeg() {
  try {
    await execFileAsync(getFFmpegPath(), ['-version']);
    return true;
  } catch (error) {
    return false;
  }
}

async function runFFmpeg(args) {
  return execFileAsync(getFFmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
}

function getFFprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const ffmpegPath = getFFmpegPath();
  if (ffmpegPath !== 'ffmpeg') {
    const candidate = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    if (candidate !== ffmpegPath && fs.existsSync(candidate)) return candidate;
  }
  return 'ffprobe';
}

async function getMediaDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    const duration = Number(String(stdout || '').trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch (_error) {
    // The bundled ffmpeg-static package does not include ffprobe; use FFmpeg's metadata output below.
  }

  try {
    await runFFmpeg(['-i', filePath]);
  } catch (error) {
    const match = String(error.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (match) {
      const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(duration) && duration > 0) return duration;
    }
  }
  throw new Error(`Could not determine media duration for ${filePath}`);
}

function ffmpegInstallHint() {
  const hints = {
    win32: 'winget install Gyan.FFmpeg (then restart your terminal)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg (or your distro equivalent)'
  };

  const platformHint = hints[process.platform] || 'https://ffmpeg.org/download.html';
  return `FFmpeg not found. Install it with: ${platformHint} — or run "npm install" again to fetch the bundled ffmpeg-static binary, or set FFMPEG_PATH to your ffmpeg executable.`;
}

/**
 * Probe a media file and return structured metadata as a JSON object.
 * Returns format info, streams, duration, resolution, codecs, etc.
 */
async function getMediaInfo(filePath) {
  const { stdout } = await execFileAsync(getFFprobePath(), [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/**
 * Extract the audio stream from a media file.
 * @param {string} inputPath - Source media file.
 * @param {string} outputPath - Destination audio file (e.g. .wav, .mp3).
 * @param {object} options - { sampleRate, channels, codec }
 */
async function extractAudioStream(inputPath, outputPath, options = {}) {
  const args = ['-y', '-i', inputPath, '-vn'];
  if (options.sampleRate) args.push('-ar', String(options.sampleRate));
  if (options.channels) args.push('-ac', String(options.channels));
  if (options.codec) {
    args.push('-c:a', options.codec);
  } else {
    const ext = require('path').extname(outputPath).toLowerCase();
    if (ext === '.wav') args.push('-c:a', 'pcm_s16le');
    else if (ext === '.mp3') args.push('-c:a', 'libmp3lame');
    else if (ext === '.aac' || ext === '.m4a') args.push('-c:a', 'aac');
  }
  args.push(outputPath);
  await runFFmpeg(args);
  return outputPath;
}

/**
 * Sample frames from a video at regular intervals.
 * @param {string} inputPath - Source video file.
 * @param {string} outputDir - Directory to write frame images.
 * @param {object} options - { count, format, quality }
 * @returns {string[]} Array of output file paths.
 */
async function sampleFramesFromVideo(inputPath, outputDir, options = {}) {
  const fsPromises = require('fs').promises;
  const pathModule = require('path');
  await fsPromises.mkdir(outputDir, { recursive: true });

  const count = Math.max(1, Math.min(100, Number(options.count || 10)));
  const format = options.format || 'jpg';
  const quality = options.quality || 2;

  // Get duration first
  const duration = await getMediaDuration(inputPath);
  const interval = duration / (count + 1);
  const paths = [];

  for (let i = 0; i < count; i++) {
    const timestamp = Math.min(duration - 0.1, (i + 1) * interval);
    const outputPath = pathModule.join(outputDir, `frame_${String(i).padStart(4, '0')}.${format}`);
    try {
      await runFFmpeg([
        '-y', '-ss', timestamp.toFixed(2),
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', String(quality),
        outputPath
      ]);
      const stat = await fsPromises.stat(outputPath).catch(() => null);
      if (stat && stat.size > 0) paths.push(outputPath);
    } catch (_err) {
      // Skip frames that fail
    }
  }
  return paths;
}

module.exports = { getFFmpegPath, getFFprobePath, getMediaDuration, getMediaInfo, extractAudioStream, sampleFramesFromVideo, checkFFmpeg, runFFmpeg, ffmpegInstallHint };
