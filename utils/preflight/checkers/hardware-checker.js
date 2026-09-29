const { BaseChecker } = require('./base-checker');
const { STATUS } = require('../status');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class HardwareChecker extends BaseChecker {
  constructor(logger) {
    super(logger);
  }

  async runCheck(requirement) {
    try {
      if (requirement.id === 'hw:ram') {
        const totalMemGB = os.totalmem() / (1024 ** 3);
        if (totalMemGB >= 15.0) {
          return { status: STATUS.READY, details: `${totalMemGB.toFixed(1)} GB RAM detected.` };
        } else if (totalMemGB >= 8) {
          return { status: STATUS.WARNING, details: `${totalMemGB.toFixed(1)} GB RAM detected. 15.0GB recommended.` };
        } else {
          return { status: STATUS.FAILED, details: `${totalMemGB.toFixed(1)} GB RAM detected. 8GB minimum required.` };
        }
      }

      if (requirement.id === 'hw:gpu') {
        // Very basic GPU check using nvidia-smi if available
        try {
          const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
          return { status: STATUS.READY, details: `GPU detected: ${stdout.trim()}` };
        } catch (e) {
          return { status: STATUS.WARNING, details: 'NVIDIA GPU not detected via nvidia-smi. Local models may run slowly.' };
        }
      }

      return { status: STATUS.NOT_APPLICABLE, details: 'Unknown requirement' };
    } catch (e) {
      this.logger?.error(`Hardware check failed for ${requirement.id}: ${e.message}`);
      return { status: STATUS.FAILED, details: e.message };
    }
  }
}

module.exports = { HardwareChecker };
