const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { BaseProvider } = require('./base-provider');

class BrowserProvider extends BaseProvider {
  constructor() {
    super('system-browser', 'System Chromium Browser', 'browser');
    this.detectedBrowser = null;
    this.allFound = [];
  }

  async checkAvailability() {
    // Collect all candidates
    const paths = this._getPossiblePaths();
    
    // Deduplicate by path
    const uniquePaths = new Map();
    for (const p of paths) {
      if (!uniquePaths.has(p.executablePath) && fs.existsSync(p.executablePath)) {
        uniquePaths.set(p.executablePath, p);
      }
    }
    
    this.allFound = Array.from(uniquePaths.values());
    return this.allFound.length > 0;
  }

  _getPossiblePaths() {
    const paths = [];

    // 1. Config/env
    if (process.env.SPUD_BROWSER_PATH) {
      paths.push({ browser: 'Custom', executablePath: process.env.SPUD_BROWSER_PATH, source: 'config' });
    }

    // 2. Known Windows locations
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];

    const knownPaths = [
      { browser: 'Google Chrome', suffix: 'Google\\Chrome\\Application\\chrome.exe' },
      { browser: 'Microsoft Edge', suffix: 'Microsoft\\Edge\\Application\\msedge.exe' },
      { browser: 'Brave', suffix: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
      { browser: 'Vivaldi', suffix: 'Vivaldi\\Application\\vivaldi.exe' },
      { browser: 'Chromium', suffix: 'Chromium\\Application\\chrome.exe' },
      { browser: 'Opera', suffix: 'Opera\\launcher.exe' },
      { browser: 'Opera GX', suffix: 'Opera GX\\launcher.exe' }
    ];

    const bases = [programFiles, programFilesX86, localAppData].filter(Boolean);

    for (const b of bases) {
      for (const k of knownPaths) {
        paths.push({ browser: k.browser, executablePath: path.join(b, k.suffix), source: 'known-location' });
      }
    }

    // 3. PATH discovery
    const exes = [
      { name: 'chrome.exe', browser: 'Google Chrome' },
      { name: 'msedge.exe', browser: 'Microsoft Edge' },
      { name: 'brave.exe', browser: 'Brave' },
      { name: 'vivaldi.exe', browser: 'Vivaldi' },
      { name: 'chromium.exe', browser: 'Chromium' },
      { name: 'opera.exe', browser: 'Opera' }
    ];

    for (const exe of exes) {
      try {
        const out = execSync(`where ${exe.name} 2>nul`).toString().trim().split('\n');
        for (const line of out) {
          if (line.trim()) {
            paths.push({ browser: exe.browser, executablePath: line.trim(), source: 'path' });
          }
        }
      } catch(e) {}
    }
    
    // 4. Registry App Paths
    for (const exe of exes) {
      try {
        const out = execSync(`reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe.name}" /ve 2>nul`).toString();
        const match = out.match(/REG_SZ\s+([^\r\n]+)/);
        if (match && match[1]) {
           paths.push({ browser: exe.browser, executablePath: match[1].trim(), source: 'registry' });
        }
      } catch(e) {}
    }

    return paths;
  }

  async probe() {
    try {
      const isAvailable = await this.checkAvailability();
      if (!isAvailable) {
        return { usable: false, reason: 'No browser executable found' };
      }

      const errors = [];

      for (const candidate of this.allFound) {
        let browser;
        try {
          // Lightweight launch test
          browser = await chromium.launch({
            executablePath: candidate.executablePath,
            headless: true,
            args: ['--no-sandbox']
          });
          
          const context = await browser.newContext();
          const page = await context.newPage();
          
          // Load a local/simple page
          await page.setContent('<html><body><h1>Spud Wrench Browser Test</h1></body></html>');
          await page.waitForLoadState('domcontentloaded');
          
          const version = await browser.version();
          candidate.version = version;
          candidate.available = true;
          
          await browser.close();
          
          this.detectedBrowser = candidate;
          
          return { 
            usable: true, 
            reason: 'Browser launched successfully',
            browserInfo: this.detectedBrowser,
            tested: this.allFound.length
          };
        } catch (err) {
          if (browser) await browser.close().catch(() => {});
          errors.push(`${candidate.browser} (${candidate.executablePath}): ${err.message}`);
        }
      }

      // If we exhaust all candidates and none work
      return { 
        usable: false, 
        reason: 'All detected browsers failed to launch.\n' + errors.join('\n'),
        tested: this.allFound.length
      };

    } catch (err) {
      return { usable: false, reason: err.message };
    }
  }
}

module.exports = BrowserProvider;
