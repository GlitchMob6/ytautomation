/**
 * Walkthrough GUI — Backend API routes.
 *
 * Provides endpoints that the web-based setup wizard (dashboard/walkthrough.html)
 * calls to check the system, test API keys, and save credentials.
 *
 * Usage:
 *   const { mountWalkthroughAPI } = require('./walkthrough-api');
 *   mountWalkthroughAPI(app);          // adds routes under /api/walkthrough/*
 *   // also serves /walkthrough → walkthrough.html
 */

const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { CredentialManager } = require('./utils/credential-manager');
const { AITextService } = require('./utils/ai-text-service');
const { Database } = require('./database/db');

// ── Provider maps (kept in sync with walkthrough.js / walkthrough.html) ──

const PROVIDER_SAVE_MAP = {
  gemini(creds, apiKey, model)     { creds.gemini = { apiKey }; creds.aiProvider = { provider: 'gemini', apiKey, model }; },
  openai(creds, apiKey, model)     { creds.openai = { apiKey }; creds.aiProvider = { provider: 'openai', apiKey, model }; },
  openrouter(creds, apiKey, model) { creds.aiProvider = { provider: 'openrouter', apiKey, model }; },
  kimi(creds, apiKey, model)       { creds.aiProvider = { provider: 'kimi', apiKey, model }; },
  mimo(creds, apiKey, model)       { creds.aiProvider = { provider: 'mimo', apiKey, model }; },
  glm(creds, apiKey, model)        { creds.aiProvider = { provider: 'glm', apiKey, model }; }
};

const VIDEO_SAVE_MAP = {
  slideshow()                             { /* nothing to persist */ },
  seedance(creds, key)                    { creds.replicate = { ...(creds.replicate || {}), apiKey: key }; },
  minimax_h3(creds, key)                  { creds.minimax = { apiKey: key }; },
  google_omni(creds, key)                 { creds.gemini = { ...(creds.gemini || {}), apiKey: key }; },
  kling(creds, key, secret)               { creds.kling = { accessKey: key, secretKey: secret }; },
  wan(creds, key)                         { creds.wan = { apiKey: key }; }
};

// ── Helpers ──────────────────────────────────────────────────────────────

function checkFFmpeg() {
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// ── Mount function ───────────────────────────────────────────────────────

function mountWalkthroughAPI(app) {
  const cm = new CredentialManager();

  // Serve the walkthrough HTML page
  app.get('/walkthrough', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'walkthrough.html'));
  });

  // ── System check ─────────────────────────────────────────────────────
  app.get('/api/walkthrough/system-check', async (_req, res) => {
    try {
      const checks = [];

      // Node.js
      const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
      checks.push({ name: `Node.js ${process.versions.node}`, ok: nodeMajor >= 18, hint: 'Version 18+ required' });

      // FFmpeg
      const ffmpegOk = await checkFFmpeg();
      checks.push({ name: 'FFmpeg (video assembly)', ok: ffmpegOk, hint: 'Install from ffmpeg.org' });

      // Database
      let dbOk = false;
      try {
        const db = new Database();
        await db.initialize();
        await db.close();
        dbOk = true;
      } catch (_) { /* ignore */ }
      checks.push({ name: 'Database', ok: dbOk, hint: 'Database initialization failed' });

      // Folders
      const dirs = [
        'config', 'logs', 'data', 'data/production', 'data/assets', 'data/videos',
        'data/audio', 'data/scripts', 'data/captions', 'temp/processing', 'uploads/thumbnails',
        'output', 'output/scripts', 'output/thumbnails', 'output/videos', 'output/metadata'
      ];
      let foldersOk = true;
      for (const dir of dirs) {
        try { await fs.mkdir(path.join(__dirname, dir), { recursive: true }); }
        catch (_) { foldersOk = false; }
      }
      checks.push({ name: 'Project folders', ok: foldersOk, hint: 'Could not create some directories' });

      // .env
      let envOk = false;
      try {
        await fs.access(path.join(__dirname, '.env'));
        envOk = true;
      } catch (_) {
        try {
          await fs.writeFile(path.join(__dirname, '.env'), [
            '# Created by the setup wizard',
            'NODE_ENV=production', 'PORT=3456', 'LOG_LEVEL=info', ''
          ].join('\n'));
          envOk = true;
        } catch (__) { /* ignore */ }
      }
      checks.push({ name: '.env file', ok: envOk, hint: 'Could not create .env' });

      res.json({ checks });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Test AI key ──────────────────────────────────────────────────────
  app.post('/api/walkthrough/test-key', async (req, res) => {
    try {
      const { provider, apiKey, model } = req.body;
      if (!provider || !apiKey) return res.status(400).json({ success: false, error: 'Provider and API key are required' });

      // Build a minimal credentials object for AITextService
      const testCreds = { aiProvider: { provider, apiKey, model } };
      if (provider === 'gemini') testCreds.gemini = { apiKey };
      if (provider === 'openai') testCreds.openai = { apiKey };

      const service = new AITextService(testCreds);
      const reply = await service.generateText('Reply with the single word OK.', { maxTokens: 20, temperature: 0 });
      const success = typeof reply === 'string' && reply.length > 0;
      res.json({ success, reply: success ? reply.slice(0, 50) : null });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  // ── Save AI provider ────────────────────────────────────────────────
  app.post('/api/walkthrough/save-ai-provider', async (req, res) => {
    try {
      const { provider, apiKey, model } = req.body;
      if (!provider || !apiKey) return res.status(400).json({ error: 'Missing fields' });

      await cm.loadCredentials();
      const saveFn = PROVIDER_SAVE_MAP[provider];
      if (saveFn) saveFn(cm.credentials, apiKey, model);
      await cm.saveCredentials();

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Save video provider ─────────────────────────────────────────────
  app.post('/api/walkthrough/save-video-provider', async (req, res) => {
    try {
      const { provider, apiKey, secretKey } = req.body;
      if (!provider) return res.status(400).json({ error: 'Missing provider' });

      await cm.loadCredentials();
      const saveFn = VIDEO_SAVE_MAP[provider];
      if (saveFn && apiKey) saveFn(cm.credentials, apiKey, secretKey);
      await cm.saveCredentials();

      // Also save to DB setting
      let db;
      try {
        db = new Database();
        await db.initialize();
        await db.setSetting('video_provider', provider);
      } finally {
        if (db) await db.close();
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Save project basics ─────────────────────────────────────────────
  app.post('/api/walkthrough/save-project', async (req, res) => {
    try {
      const { channelName, targetAudience, postingFrequency } = req.body;

      await cm.loadCredentials();
      cm.credentials.channel = {
        ...(cm.credentials.channel || {}),
        channelName: channelName || 'My Content Studio',
        channelDescription: cm.credentials.channel?.channelDescription || 'AI content studio',
        defaultCategory: cm.credentials.channel?.defaultCategory || '22',
        defaultPrivacy: cm.credentials.channel?.defaultPrivacy || 'private'
      };
      cm.credentials.content = {
        contentTypes: cm.credentials.content?.contentTypes || ['tutorial', 'explainer', 'list'],
        competitorChannels: cm.credentials.content?.competitorChannels || [],
        targetAudience: targetAudience || 'General audience interested in educational content',
        postingFrequency: postingFrequency || 'weekly',
        preferredPostTime: cm.credentials.content?.preferredPostTime || '14:00'
      };
      await cm.saveCredentials();

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Final summary ───────────────────────────────────────────────────
  app.get('/api/walkthrough/summary', async (_req, res) => {
    try {
      await cm.loadCredentials();
      await cm.loadTokens();
      const creds = cm.credentials;

      const hasText = cm.hasAITextProvider();
      const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
      const hasMedia = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini);
      const hasFFmpeg = await checkFFmpeg();

      const capabilities = [
        { name: 'Write scripts & pick topics', ok: hasText },
        { name: 'Generate images & voice', ok: hasMedia },
        { name: 'Assemble .mp4 videos', ok: hasFFmpeg },
        { name: 'AI video clips', ok: false } // Would need provider registry check
      ];

      // Try to check video provider
      try {
        const { VideoProviderRegistry } = require('./utils/video-provider-registry');
        const providers = new VideoProviderRegistry(creds).list();
        capabilities[3].ok = providers.some(p => p.available);
      } catch (_) { /* registry not available */ }

      res.json({
        capabilities,
        outputPath: path.join(__dirname, 'output'),
        projectName: creds.channel?.channelName || null,
        aiProvider: creds.aiProvider?.provider || null
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { mountWalkthroughAPI };
