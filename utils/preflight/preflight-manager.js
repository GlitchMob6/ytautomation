const { getAllRequirements, getRequirement } = require('./registry');
const { STATUS, SEVERITY, CATEGORIES, CAPABILITIES } = require('./status');
const { EnvironmentChecker } = require('./checkers/environment-checker');
const { HardwareChecker } = require('./checkers/hardware-checker');
const { DependencyChecker } = require('./checkers/dependency-checker');
const { PreflightReport } = require('./preflight-report');

class PreflightManager {
  constructor(logger) {
    this.logger = logger || console;
    this.checkers = {
      [CATEGORIES.ENVIRONMENT]: new EnvironmentChecker(this.logger),
      [CATEGORIES.HARDWARE]: new HardwareChecker(this.logger),
      [CATEGORIES.DEPENDENCY]: new DependencyChecker(this.logger),
    };
    this.report = new PreflightReport(this.logger);
    this.capabilitiesReady = {};
  }

  async runAllChecks() {
    this.logger.info('Starting full preflight checks...');
    this.report.startReport();
    
    const requirements = getAllRequirements();
    
    for (const req of requirements) {
      await this.checkRequirement(req.id);
    }

    this.evaluateCapabilities();
    await this.report.saveReport();
    
    return this.capabilitiesReady;
  }

  async checkRequirement(reqId) {
    const req = getRequirement(reqId);
    if (!req) throw new Error(`Requirement ${reqId} not found`);

    req.status = STATUS.CHECKING;
    this.report.updateRequirement(reqId, req.status, 'Checking...');

    const checker = this.checkers[req.category];
    if (checker) {
      const { status, details } = await checker.runCheck(req);
      req.status = status;
      req.details = details;
    } else {
      req.status = STATUS.NOT_CHECKED;
      req.details = `No checker configured for category: ${req.category}`;
    }

    this.report.updateRequirement(reqId, req.status, req.details);
    return req;
  }

  async bypassRequirement(reqId) {
    const req = getRequirement(reqId);
    if (!req) throw new Error(`Requirement ${reqId} not found`);

    if (req.bypassAllowed) {
      req.status = STATUS.BYPASSED;
      req.details = 'Bypassed by user. Degraded functionality expected.';
      this.report.updateRequirement(reqId, req.status, req.details);
      this.evaluateCapabilities();
    } else {
      throw new Error(`Requirement ${reqId} cannot be bypassed.`);
    }
  }

  evaluateCapabilities() {
    // Reset capabilities
    Object.values(CAPABILITIES).forEach(cap => {
      this.capabilitiesReady[cap] = true; // Assume ready until proven blocked
    });

    const requirements = getAllRequirements();
    let overallReady = true;

    for (const req of requirements) {
      if (req.status === STATUS.FAILED || req.status === STATUS.MISSING) {
        if (req.severity === SEVERITY.HARD_BLOCKER) {
          req.affects.forEach(cap => {
            this.capabilitiesReady[cap] = false;
          });
          overallReady = false;
        }
      }
    }

    this.report.setCapabilities(this.capabilitiesReady, overallReady);
    return this.capabilitiesReady;
  }
}

module.exports = { PreflightManager };
