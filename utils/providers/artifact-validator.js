const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

async function validateArtifact(filePath, type, options = {}) {
  if (!filePath) {
    throw new Error(`Validation failed: No file path provided for ${type}`);
  }

  try {
    const stats = await fs.stat(filePath);
    if (stats.size < 100) {
      throw new Error(`Validation failed: File size too small (${stats.size} bytes)`);
    }

    // Basic HTML check to prevent saving websites as images
    const buffer = Buffer.alloc(100);
    const fd = await fs.open(filePath, 'r');
    await fd.read(buffer, 0, 100, 0);
    await fd.close();

    const header = buffer.toString('utf8').toLowerCase().trim();
    if (header.startsWith('<!doctype') || header.startsWith('<html')) {
      throw new Error('Validation failed: Downloaded file is an HTML page (website screenshot block)');
    }

    if (type === 'video') {
      // Validate MP4 via FFmpeg/ffprobe if available
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height,codec_name',
          '-of', 'json',
          filePath
        ]);
        
        const info = JSON.parse(stdout);
        if (!info.streams || info.streams.length === 0) {
          throw new Error('Validation failed: No video stream found');
        }
        
        const stream = info.streams[0];
        
        if (options.minWidth && stream.width < options.minWidth) {
          throw new Error(`Validation failed: Video width ${stream.width} is smaller than required ${options.minWidth}`);
        }
        
      } catch (e) {
        if (e.message.includes('Validation failed')) throw e;
        // If ffprobe fails completely, we consider it invalid
        throw new Error(`Validation failed: Not a valid video file (${e.message})`);
      }
    }
    
    if (type === 'image') {
      // Very basic sanity check for image types
      // JPG: FF D8 FF
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      // WEBP: RIFF ... WEBP
      const hex = buffer.toString('hex').toUpperCase();
      if (!hex.startsWith('FFD8FF') && !hex.startsWith('89504E47') && !hex.includes('57454250')) {
        // Just a loose fallback warning
      }
    }

    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Validation failed: File does not exist at ${filePath}`);
    }
    throw error;
  }
}

module.exports = { validateArtifact };
