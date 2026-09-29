class BaseChecker {
  constructor(logger) {
    this.logger = logger;
  }

  async runCheck(requirement) {
    throw new Error('runCheck must be implemented by subclasses');
  }

  async performInstall(requirement) {
    throw new Error('performInstall must be implemented by subclasses if installation is supported');
  }

  async performVerification(requirement) {
    throw new Error('performVerification must be implemented by subclasses if verification is supported');
  }
}

module.exports = { BaseChecker };
