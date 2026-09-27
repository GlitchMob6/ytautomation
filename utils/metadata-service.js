const { Logger } = require('./logger');
const crypto = require('crypto');

class MetadataService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('MetadataService');
  }

  /**
   * Generates FFmpeg arguments to embed metadata into the final video file.
   * Supports injecting provenance info, copyright, and custom titles.
   */
  getMetadataArgs(options = {}) {
    const args = [];

    if (options.title) {
      args.push('-metadata', `title=${options.title}`);
    }

    if (options.description) {
      args.push('-metadata', `description=${options.description}`);
    }

    if (options.author) {
      args.push('-metadata', `artist=${options.author}`);
      args.push('-metadata', `author=${options.author}`);
    }

    if (options.copyright) {
      args.push('-metadata', `copyright=${options.copyright}`);
    }
    
    // Custom AgentTube Provenance injection
    if (options.provenanceId) {
      args.push('-metadata', `comment=AgentTubeProvenance:${options.provenanceId}`);
    }

    // Force creation of a UUID for this render
    const renderUuid = crypto.randomUUID();
    args.push('-metadata', `creation_time=now`);
    args.push('-metadata', `encoded_by=AgentTube_RemixEngine`);
    args.push('-metadata', `render_uuid=${renderUuid}`);

    return args;
  }

  /**
   * Verifies that provenance metadata exists in a rendered file.
   */
  async verifyProvenance(probeData) {
    const format = probeData.format || {};
    const tags = format.tags || {};
    
    const hasProvenance = Object.keys(tags).some(k => 
      (k.toLowerCase() === 'comment' && tags[k].includes('AgentTubeProvenance')) ||
      k.toLowerCase() === 'render_uuid'
    );
    
    return hasProvenance;
  }
}

module.exports = { MetadataService };
