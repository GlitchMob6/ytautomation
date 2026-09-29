const { BaseChecker } = require('./base-checker');
const { STATUS } = require('../status');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { checkFFmpeg } = require('../../ffmpeg'); // Use existing utility

class DependencyChecker extends BaseChecker {
  constructor(logger) {
    super(logger);
  }

  async runCheck(requirement) {
    try {
      if (requirement.id === 'dep:ffmpeg') {
        const isReady = await checkFFmpeg();
        if (isReady) {
          return { status: STATUS.READY, details: 'FFmpeg is installed and accessible.' };
        } else {
          return { status: STATUS.FAILED, details: 'FFmpeg not found in PATH or ffmpeg-static.' };
        }
      }

      if (requirement.id === 'dep:playwright') {
        try {
          // Check if playwright chromium is available
          // Just a basic check to see if the module exists and can launch (simulated here)
          require.resolve('playwright');
          return { status: STATUS.READY, details: 'Playwright is installed.' };
        } catch (e) {
          return { status: STATUS.FAILED, details: 'Playwright is not installed.' };
        }
      }

      if (requirement.id.startsWith('model:')) {
        const modelName = requirement.id.split(':')[1];
        const fs = require('fs');
        const path = require('path');
        const modelPath = path.join(process.cwd(), 'models', modelName);
        if (fs.existsSync(modelPath)) {
          return { status: STATUS.READY, details: 'Local model weights found.' };
        } else {
          return { status: STATUS.FAILED, details: 'Model weights are not downloaded.' };
        }
      }

      return { status: STATUS.NOT_APPLICABLE, details: 'Unknown requirement' };
    } catch (e) {
      this.logger?.error(`Dependency check failed for ${requirement.id}: ${e.message}`);
      return { status: STATUS.FAILED, details: e.message };
    }
  }
}

module.exports = { DependencyChecker };
