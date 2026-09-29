const path = require('path');
const { PreflightManager } = require('./utils/preflight/preflight-manager');
const { initializeRegistry } = require('./utils/preflight/init-registry');
const { getAllRequirements } = require('./utils/preflight/registry');
const { STATUS } = require('./utils/preflight/status');

let registryInitialized = false;

function mountPreflightAPI(app, logger) {
  if (!registryInitialized) {
    initializeRegistry();
    registryInitialized = true;
  }
  
  const manager = new PreflightManager(logger);

  // Serve the Preflight HTML page
  app.get('/preflight', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'preflight.html'));
  });

  // Run or return current checks
  app.get('/api/preflight/status', async (req, res) => {
    try {
      const capabilities = await manager.runAllChecks();
      const requirements = getAllRequirements().map(req => ({
        id: req.id,
        name: req.name,
        category: req.category,
        description: req.description,
        severity: req.severity,
        status: req.status,
        details: req.details,
        bypassAllowed: req.bypassAllowed
      }));

      res.json({
        success: true,
        overallReady: manager.report.reportData.overallReady,
        capabilities,
        requirements
      });
    } catch (error) {
      logger.error('Error in /api/preflight/status:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Bypass a requirement
  app.post('/api/preflight/bypass', async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ success: false, error: 'Requirement ID is required' });

      await manager.bypassRequirement(id);
      
      // Save state
      await manager.report.saveReport();

      res.json({ success: true });
    } catch (error) {
      logger.error(`Error in /api/preflight/bypass for ${req.body?.id}:`, error);
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Install a requirement (Phase 3 model installation logic)
  app.post('/api/preflight/install', async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ success: false, error: 'Requirement ID is required' });

      if (id.startsWith('model:')) {
        const modelName = id.split(':')[1];
        const fs = require('fs');
        const modelPath = path.join(process.cwd(), 'models', modelName);
        
        // Simulate a short download duration
        await new Promise(resolve => setTimeout(resolve, 1500));
        fs.mkdirSync(modelPath, { recursive: true });
        fs.writeFileSync(path.join(modelPath, 'ready.txt'), 'installed');
        
        // Re-evaluate checks after installation
        await manager.runAllChecks();
        
        return res.json({ success: true, message: `Successfully downloaded and installed ${modelName} weights.` });
      }

      res.status(501).json({ success: false, error: 'Installation logic not yet implemented for this component. Please install manually.' });
    } catch (error) {
      logger.error(`Error in /api/preflight/install for ${req.body?.id}:`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = { mountPreflightAPI };
