/**
 * Persistent Provider Health Store
 *
 * Persists provider degradation/quarantine state to SQLite so it
 * survives Node restarts. Tracks failure history, quarantine windows,
 * and success timestamps per provider+model pair.
 */

const path = require('path');
const fs = require('fs').promises;

class ProviderHealthStore {
  constructor(dbInstance, logger) {
    this.db = dbInstance;
    this.logger = logger || console;
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return;
    // Create the health table if it doesn't exist
    await this.db.executeQuery(`
      CREATE TABLE IF NOT EXISTS provider_health (
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        modality TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'usable',
        failure_category TEXT,
        failure_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        degraded_until TEXT,
        last_success TEXT,
        last_failure TEXT,
        last_failure_reason TEXT,
        evidence TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider_id, model)
      )
    `);
    this._initialized = true;
  }

  /**
   * Record a successful generation from a provider.
   * Resets failure counters and marks the provider usable.
   */
  async recordSuccess(providerId, model, modality) {
    await this.initialize();
    const now = new Date().toISOString();
    await this.db.executeQuery(`
      INSERT INTO provider_health (provider_id, model, modality, state, failure_count, consecutive_failures, last_success, degraded_until, updated_at)
      VALUES (?, ?, ?, 'usable', 0, 0, ?, NULL, ?)
      ON CONFLICT(provider_id, model) DO UPDATE SET
        state = 'usable',
        consecutive_failures = 0,
        last_success = ?,
        degraded_until = NULL,
        updated_at = ?
    `, [providerId, model || '', modality || '', now, now, now, now]);
  }

  /**
   * Record a failure from a provider.
   * Increments counters, stores evidence, and applies quarantine.
   */
  async recordFailure(providerId, model, modality, classification) {
    await this.initialize();
    const now = new Date().toISOString();
    const quarantineMs = classification.quarantineDurationMs || 5 * 60 * 1000;
    const degradedUntil = new Date(Date.now() + quarantineMs).toISOString();
    const state = classification.category === 'auth' ? 'unavailable' : 'degraded';
    const evidenceStr = JSON.stringify(classification.evidence || {});

    // First check if row exists
    const existing = await this.db.getRow(
      'SELECT failure_count, consecutive_failures FROM provider_health WHERE provider_id = ? AND model = ?',
      [providerId, model || '']
    );

    if (existing) {
      await this.db.executeQuery(`
        UPDATE provider_health SET
          state = ?,
          modality = ?,
          failure_category = ?,
          failure_count = failure_count + 1,
          consecutive_failures = consecutive_failures + 1,
          degraded_until = ?,
          last_failure = ?,
          last_failure_reason = ?,
          evidence = ?,
          updated_at = ?
        WHERE provider_id = ? AND model = ?
      `, [
        state, modality || '', classification.category,
        degradedUntil, now, classification.evidence?.message || '',
        evidenceStr, now, providerId, model || ''
      ]);
    } else {
      await this.db.executeQuery(`
        INSERT INTO provider_health (provider_id, model, modality, state, failure_category, failure_count, consecutive_failures, degraded_until, last_failure, last_failure_reason, evidence, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      `, [
        providerId, model || '', modality || '', state,
        classification.category, degradedUntil, now,
        classification.evidence?.message || '', evidenceStr, now
      ]);
    }
  }

  /**
   * Check if a provider is currently quarantined.
   * Returns { quarantined, state, degradedUntil, failureCategory, consecutiveFailures }
   */
  async isQuarantined(providerId, model) {
    await this.initialize();
    const row = await this.db.getRow(
      'SELECT * FROM provider_health WHERE provider_id = ? AND model = ?',
      [providerId, model || '']
    );

    if (!row) return { quarantined: false, state: 'unknown' };

    const now = new Date();
    const degradedUntil = row.degraded_until ? new Date(row.degraded_until) : null;

    if (degradedUntil && degradedUntil > now) {
      return {
        quarantined: true,
        state: row.state,
        degradedUntil: row.degraded_until,
        failureCategory: row.failure_category,
        consecutiveFailures: row.consecutive_failures,
        lastFailureReason: row.last_failure_reason,
      };
    }

    return {
      quarantined: false,
      state: row.state === 'degraded' ? 'recovered' : row.state,
      failureCategory: row.failure_category,
      consecutiveFailures: row.consecutive_failures,
      lastSuccess: row.last_success,
    };
  }

  /**
   * Get health summary for all providers.
   */
  async getHealthSummary() {
    await this.initialize();
    const rows = await this.db.getAllRows(
      'SELECT * FROM provider_health ORDER BY modality, provider_id'
    );
    const now = new Date();
    return rows.map(row => ({
      providerId: row.provider_id,
      model: row.model,
      modality: row.modality,
      state: row.state,
      failureCategory: row.failure_category,
      failureCount: row.failure_count,
      consecutiveFailures: row.consecutive_failures,
      degradedUntil: row.degraded_until,
      isCurrentlyQuarantined: row.degraded_until ? new Date(row.degraded_until) > now : false,
      lastSuccess: row.last_success,
      lastFailure: row.last_failure,
      lastFailureReason: row.last_failure_reason,
    }));
  }

  /**
   * Clear quarantine for a specific provider (e.g., after credential update).
   */
  async clearQuarantine(providerId, model) {
    await this.initialize();
    await this.db.executeQuery(`
      UPDATE provider_health SET
        state = 'usable',
        consecutive_failures = 0,
        degraded_until = NULL,
        updated_at = ?
      WHERE provider_id = ? AND model = ?
    `, [new Date().toISOString(), providerId, model || '']);
  }

  /**
   * Clear all quarantines (e.g., fresh start).
   */
  async clearAll() {
    await this.initialize();
    await this.db.executeQuery('DELETE FROM provider_health');
  }
}

module.exports = { ProviderHealthStore };
