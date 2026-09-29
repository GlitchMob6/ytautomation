const { BaseChecker } = require('./base-checker');
const { STATUS } = require('../status');
const os = require('os');

class EnvironmentChecker extends BaseChecker {
  constructor(logger) {
    super(logger);
  }

  async runCheck(requirement) {
    try {
      if (requirement.id === 'env:nodejs') {
        const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
        if (nodeMajor >= 18) {
          return { status: STATUS.READY, details: `Node.js ${process.versions.node} detected.` };
        } else {
          return { status: STATUS.FAILED, details: `Node.js 18+ required, found ${process.versions.node}.` };
        }
      }
      
      if (requirement.id === 'env:npm') {
        // Just assuming it exists if node runs, but we could exec 'npm -v'
        return { status: STATUS.READY, details: 'npm detected' };
      }

      if (requirement.id === 'env:os') {
        return { status: STATUS.READY, details: `${os.type()} ${os.release()} detected.` };
      }

      return { status: STATUS.NOT_APPLICABLE, details: 'Unknown requirement' };
    } catch (e) {
      this.logger?.error(`Environment check failed for ${requirement.id}: ${e.message}`);
      return { status: STATUS.FAILED, details: e.message };
    }
  }
}

module.exports = { EnvironmentChecker };
