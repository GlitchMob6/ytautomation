const fs = require('fs').promises;
const path = require('path');
const { STATUS } = require('./status');

class PreflightReport {
  constructor(logger) {
    this.logger = logger;
    this.reportData = {
      timestamp: null,
      system: {},
      requirements: {},
      capabilities: {},
      overallReady: false
    };
  }

  startReport() {
    this.reportData.timestamp = new Date().toISOString();
  }

  addSystemInfo(info) {
    this.reportData.system = { ...this.reportData.system, ...info };
  }

  updateRequirement(reqId, status, details) {
    this.reportData.requirements[reqId] = { status, details, timestamp: new Date().toISOString() };
  }

  setCapabilities(capabilities, ready) {
    this.reportData.capabilities = capabilities;
    this.reportData.overallReady = ready;
  }

  async saveReport(reportPath = 'data/preflight') {
    try {
      const fullDir = path.join(process.cwd(), reportPath);
      await fs.mkdir(fullDir, { recursive: true });
      
      const latestPath = path.join(fullDir, 'latest.json');
      const historyPath = path.join(fullDir, `report_${this.reportData.timestamp.replace(/[:.]/g, '-')}.json`);
      
      const content = JSON.stringify(this.reportData, null, 2);
      
      await fs.writeFile(latestPath, content, 'utf8');
      await fs.writeFile(historyPath, content, 'utf8');
      
      this.logger?.info(`Preflight report saved to ${latestPath}`);
    } catch (e) {
      this.logger?.error(`Failed to save preflight report: ${e.message}`);
    }
  }
}

module.exports = { PreflightReport };
