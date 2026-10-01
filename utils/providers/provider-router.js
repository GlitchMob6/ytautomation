const {
  providerToCapabilityRecord,
  selectDeterministicRoute
} = require('../model-capability-registry');
const { classifyFailure, determineRecovery, RECOVERY_ACTION } = require('./failure-classifier');
const { adaptOptions, IncompatibleRequestError } = require('./option-adapter');
const { validateArtifact } = require('./artifact-validator');

// ─── Bounded limits ──────────────────────────────────────────────────
const MAX_TOTAL_ATTEMPTS = 6;          // Across all providers
const MAX_RECOVERY_TIME_MS = 120_000;  // 2 minutes total
const MAX_SAME_PROVIDER_RETRIES = 2;   // Max retries on a single provider

class ProviderRouter {
  constructor(logger) {
    this.logger = logger || console;
    this.providers = {
      llm: [],
      tts: [],
      image: [],
      video: [],
      transcribe: [],
      browser: []
    };
    this.healthStore = null;  // Set via setHealthStore() after DB init
  }

  /**
   * Attach a persistent ProviderHealthStore instance.
   * Must be called after the database is initialized.
   */
  setHealthStore(store) {
    this.healthStore = store;
  }

  registerProvider(provider, metadata = {}) {
    if (this.providers[provider.type]) {
      provider.capabilityRecord = providerToCapabilityRecord(provider, metadata);
      this.providers[provider.type].push(provider);
      this.logger.info(`Registered ${provider.type} provider: ${provider.name}`);
    } else {
      this.logger.error(`Unknown provider type: ${provider.type}`);
    }
  }

  async getBestProvider(type, options = {}) {
    const list = this.providers[type];
    if (!list || list.length === 0) {
      throw new Error(`No providers registered for type: ${type}`);
    }

    if (!options.request && !options.route) {
      for (const provider of list) {
        if (await this.isProviderAvailable(provider)) return provider;
      }
      throw new Error(`No available providers found for type: ${type}`);
    }

    const route = await this.route(type, options.request || options);
    if (route.selected) return list.find(provider => provider.capabilityRecord.id === route.selected.id);
    throw new Error(`No available providers found for type: ${type}`);
  }

  async isProviderAvailable(provider) {
    try {
      // Check persistent quarantine first
      if (this.healthStore) {
        const health = await this.healthStore.isQuarantined(provider.id, provider.model);
        if (health.quarantined) {
          this.logger.info?.(`Provider ${provider.name} is quarantined until ${health.degradedUntil} (${health.failureCategory})`);
          return false;
        }
      }

      // Check in-memory degradation (backward compat)
      if (provider._degradedUntil && provider._degradedUntil > Date.now()) {
        return false;
      }

      if (typeof provider.checkAvailability === 'function') return Boolean(await provider.checkAvailability());
      if (typeof provider.isAvailable === 'function') return Boolean(await provider.isAvailable());
      return provider.isAvailable !== false;
    } catch (error) {
      this.logger.warn?.(`Provider availability check failed for ${provider.id || provider.name}: ${error.message}`);
      return false;
    }
  }

  listProviders(type) {
    const providers = type ? (this.providers[type] || []) : Object.values(this.providers).flat();
    return providers.map(provider => ({
      ...provider.capabilityRecord,
      api: provider.capabilityRecord?.api || { enabled: true }
    }));
  }

  async describeProviders(type) {
    const providers = type ? (this.providers[type] || []) : Object.values(this.providers).flat();
    return Promise.all(providers.map(async provider => ({
      ...provider.capabilityRecord,
      available: await this.isProviderAvailable(provider)
    })));
  }

  async route(type, request = {}) {
    const providers = this.providers[type] || [];
    const records = [];
    for (const provider of providers) {
      const available = await this.isProviderAvailable(provider);
      records.push({ ...provider.capabilityRecord, available });
    }
    return selectDeterministicRoute(records, { ...request, modality: request.modality || type }, {
      preferredProvider: request.preferredProvider,
      preferredModel: request.preferredModel
    });
  }

  /* Legacy implementation retained for backward compatibility */
  async getBestProviderLegacy(type) {
    const list = this.providers[type];
    if (!list || list.length === 0) {
      throw new Error(`No providers registered for type: ${type}`);
    }
    for (const provider of list) {
      if (await this.isProviderAvailable(provider)) {
        return provider;
      }
    }
    throw new Error(`No available providers found for type: ${type}`);
  }

  // ─── Self-Healing Execution Engine ───────────────────────────────

  /**
   * Execute a capability request with full self-healing:
   * - Failure classification
   * - Recovery policy (retry/backoff/failover)
   * - Persistent quarantine
   * - Bounded attempts and time
   * - Creator-friendly messaging
   */
  async executeWithFailover(type, methodName, options = {}) {
    const routeInfo = await this.route(type, options.request || options);

    if (!routeInfo.candidates || routeInfo.candidates.length === 0) {
      throw new Error(`No available providers found for capability: ${type}`);
    }

    const attemptHistory = [];
    const startTime = Date.now();
    let totalAttempts = 0;
    let candidateIndex = 0;
    let creatorMessage = null;

    while (candidateIndex < routeInfo.candidates.length && totalAttempts < MAX_TOTAL_ATTEMPTS) {
      // ── Bounded time check ──
      if (Date.now() - startTime > MAX_RECOVERY_TIME_MS) {
        break;
      }

      const candidateRecord = routeInfo.candidates[candidateIndex];
      const provider = this.providers[type].find(p => p.capabilityRecord.id === candidateRecord.id);

      if (!provider) {
        candidateIndex++;
        continue;
      }

      // Check how many times we've already tried this specific provider
      const sameProviderAttempts = attemptHistory.filter(a => a.providerId === provider.id);
      if (sameProviderAttempts.length >= MAX_SAME_PROVIDER_RETRIES) {
        candidateIndex++;
        continue;
      }

      totalAttempts++;

      const attemptRecord = {
        attemptNumber: totalAttempts,
        providerId: provider.id,
        providerName: provider.name,
        model: provider.model || candidateRecord.model,
        startedAt: new Date().toISOString(),
        result: null,
        error: null,
        failureCategory: null,
        recoveryAction: null,
        artifactPath: null,
        verified: false,
      };

      this.logger.info(`[SelfHeal] Routing ${type} to ${provider.name} (Attempt ${totalAttempts}/${MAX_TOTAL_ATTEMPTS})`);

      if (candidateIndex > 0 && !creatorMessage) {
        creatorMessage = `Your first visual service wasn't available, so Spud Wrench is trying another one.`;
      }

      let adaptedOptions = options;
      try {
        if (type === 'image' || type === 'video') {
           const adaptResult = adaptOptions(options, candidateRecord);
           adaptedOptions = adaptResult.adaptedOptions;
           if (adaptResult.adaptationsLog.length > 0) {
             this.logger.info(`[SelfHeal] Adapted options for ${provider.name}: ${adaptResult.adaptationsLog.join(', ')}`);
             // Optionally record adaptations in attemptRecord
             attemptRecord.adaptations = adaptResult.adaptationsLog;
           }
        }
      } catch (adaptError) {
        if (adaptError instanceof IncompatibleRequestError) {
          this.logger.warn(`[SelfHeal] Provider ${provider.name} is incompatible: ${adaptError.message}`);
          attemptRecord.result = 'skipped';
          attemptRecord.error = adaptError.message;
          attemptRecord.failureCategory = 'incompatible_request';
          attemptHistory.push(attemptRecord);
          candidateIndex++;
          continue;
        }
        throw adaptError;
      }

      try {
        const result = await provider[methodName](adaptedOptions);
        
        // ── Validate the resulting artifact ──
        if (result?.path && (type === 'image' || type === 'video')) {
          await validateArtifact(result.path, type, adaptedOptions);
        } else if (adaptedOptions?.outputPath && (type === 'image' || type === 'video')) {
          await validateArtifact(adaptedOptions.outputPath, type, adaptedOptions);
        }

        attemptRecord.result = 'success';
        attemptRecord.artifactPath = result?.path || adaptedOptions?.outputPath || null;
        attemptRecord.verified = true;
        attemptHistory.push(attemptRecord);

        // Record success in persistent store
        if (this.healthStore) {
          await this.healthStore.recordSuccess(provider.id, provider.model || '', type);
        }

        this.logger.info(`[SelfHeal] ${provider.name} succeeded for ${type} (Artifact verified)`);

        return {
          result,
          provider,
          attemptHistory,
          creatorMessage,
          totalAttempts,
          elapsed: Date.now() - startTime,
        };
      } catch (error) {
        // ── Classify the failure ──
        const classification = classifyFailure(error);
        attemptRecord.result = 'failure';
        attemptRecord.error = error.message;
        attemptRecord.failureCategory = classification.category;

        this.logger.warn(`[SelfHeal] ${provider.name} failed (${classification.category}): ${error.message}`);

        // ── Record failure in persistent store ──
        if (this.healthStore) {
          await this.healthStore.recordFailure(provider.id, provider.model || '', type, classification);
        }

        // ── In-memory degradation (fast path for this process) ──
        if (classification.quarantineDurationMs) {
          provider._degradedUntil = Date.now() + classification.quarantineDurationMs;
        }

        // ── Determine recovery action ──
        const recovery = determineRecovery(classification, attemptHistory);
        attemptRecord.recoveryAction = recovery.action;
        attemptHistory.push(attemptRecord);

        switch (recovery.action) {
          case RECOVERY_ACTION.RETRY_BACKOFF:
          case RECOVERY_ACTION.RETRY_AFTER:
            // Stay on the same provider, wait, then retry
            if (recovery.delayMs > 0 && (Date.now() - startTime + recovery.delayMs) < MAX_RECOVERY_TIME_MS) {
              this.logger.info(`[SelfHeal] Waiting ${recovery.delayMs}ms before retry...`);
              await sleep(recovery.delayMs);
              // Don't increment candidateIndex — retry same provider
            } else {
              candidateIndex++;  // Exceeded time budget, move on
            }
            break;

          case RECOVERY_ACTION.DEGRADE_FAILOVER:
          case RECOVERY_ACTION.ADAPT_FAILOVER:
          case RECOVERY_ACTION.FAILOVER:
            candidateIndex++;  // Move to next provider
            break;

          case RECOVERY_ACTION.STOP:
          default:
            // Mark remaining candidates as untried, stop immediately
            candidateIndex = routeInfo.candidates.length;
            break;
        }
      }
    }

    // ── All paths exhausted ──
    const errorSummary = attemptHistory
      .filter(a => a.result === 'failure' || a.result === 'skipped')
      .map(a => `${a.providerName} (${a.failureCategory}): ${a.error}`)
      .join('; ');

    const err = new Error(
      `All verified providers failed for ${type}. ` +
      `${totalAttempts} attempts in ${Date.now() - startTime}ms. ` +
      `Failures: ${errorSummary}`
    );
    err.attemptHistory = attemptHistory;
    err.creatorMessage = attemptHistory.length > 0
      ? `Spud Wrench tried every available option for this step, but none of them worked right now. Check your setup or try again later.`
      : `No services are set up for this step yet.`;
    throw err;
  }

  // ─── Convenience methods ─────────────────────────────────────────

  async generateText(options) {
    const { result } = await this.executeWithFailover('llm', 'generate', options);
    return result;
  }

  async generateSpeech(options) {
    const { result } = await this.executeWithFailover('tts', 'generate', options);
    return result;
  }

  async generateImage(options) {
    const { result } = await this.executeWithFailover('image', 'generate', options);
    return result;
  }

  async generateVideo(options) {
    const { result } = await this.executeWithFailover('video', 'generate', options);
    return result;
  }

  async transcribe(options) {
    const { result } = await this.executeWithFailover('transcribe', 'generate', options);
    return result;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { ProviderRouter };
