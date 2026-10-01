/**
 * Failure Classification & Recovery Policy
 *
 * Classifies runtime provider errors into actionable categories and
 * determines the correct recovery strategy for each.
 */

// ─── Failure Categories ──────────────────────────────────────────────
const FAILURE_CATEGORY = Object.freeze({
  TRANSIENT:       'transient',        // Network timeouts, DNS, connection reset
  RATE_LIMITED:    'rate_limited',      // 429 / quota exhausted
  AUTH:            'auth',             // Invalid key, expired token, 401/403
  PROVIDER_DOWN:   'provider_down',    // 5xx, service unavailable
  RESOURCE:        'resource',         // VRAM OOM, disk full, CUDA error
  INVALID_REQUEST: 'invalid_request',  // 400, unsupported option, bad prompt
  PERMANENT:       'permanent',        // Unknown / unrecoverable
});

// ─── Recovery Actions ────────────────────────────────────────────────
const RECOVERY_ACTION = Object.freeze({
  RETRY_BACKOFF:      'retry_backoff',       // Retry same provider with backoff
  RETRY_AFTER:        'retry_after',         // Respect Retry-After header
  FAILOVER:           'failover',            // Try next verified provider
  DEGRADE_FAILOVER:   'degrade_failover',    // Quarantine provider, try next
  ADAPT_FAILOVER:     'adapt_failover',      // Try next provider, maybe adapt options
  STOP:               'stop',                // No recovery possible
});

// ─── Classifier ──────────────────────────────────────────────────────

/**
 * Classify a provider error into a failure category.
 * Returns { category, retryable, retryAfterMs, evidence }
 */
function classifyFailure(error) {
  const msg = (error.message || '').toLowerCase();
  const code = error.code || error.statusCode || extractStatusCode(error);
  const evidence = {
    message: error.message,
    code,
    name: error.name,
  };

  // ── Authentication / Credential ────────────────────────────────
  if (
    code === 401 || code === 403 ||
    msg.includes('api key not valid') ||
    msg.includes('invalid api key') ||
    msg.includes('api_key_invalid') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('authentication') ||
    msg.includes('permission denied') ||
    msg.includes('invalid_api_key') ||
    msg.includes('expired token')
  ) {
    return {
      category: FAILURE_CATEGORY.AUTH,
      retryable: false,
      retryAfterMs: null,
      quarantineDurationMs: 30 * 60 * 1000,  // 30 min — needs credential fix
      evidence,
    };
  }

  // ── Rate Limit ─────────────────────────────────────────────────
  if (
    code === 429 ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('quota') ||
    msg.includes('too many requests') ||
    msg.includes('resource exhausted') ||
    msg.includes('resource_exhausted')
  ) {
    const retryAfterMs = extractRetryAfter(error) || 60_000;
    return {
      category: FAILURE_CATEGORY.RATE_LIMITED,
      retryable: true,
      retryAfterMs,
      quarantineDurationMs: retryAfterMs,
      evidence,
    };
  }

  // ── Resource / VRAM / OOM ──────────────────────────────────────
  if (
    msg.includes('out of memory') ||
    msg.includes('oom') ||
    msg.includes('vram') ||
    msg.includes('cuda') ||
    msg.includes('gpu memory') ||
    msg.includes('enospc') ||
    msg.includes('disk full') ||
    msg.includes('no space left')
  ) {
    return {
      category: FAILURE_CATEGORY.RESOURCE,
      retryable: false,
      retryAfterMs: null,
      quarantineDurationMs: 10 * 60 * 1000,  // 10 min
      evidence,
    };
  }

  // ── Invalid Request / Unsupported ──────────────────────────────
  if (
    code === 400 ||
    msg.includes('invalid') && !msg.includes('api key') ||
    msg.includes('unsupported') ||
    msg.includes('bad request') ||
    msg.includes('not supported') ||
    msg.includes('invalid_argument') && !msg.includes('api_key')
  ) {
    // Don't classify as invalid_request if it's clearly an auth issue
    if (msg.includes('api key') || msg.includes('api_key_invalid')) {
      return {
        category: FAILURE_CATEGORY.AUTH,
        retryable: false,
        retryAfterMs: null,
        quarantineDurationMs: 30 * 60 * 1000,
        evidence,
      };
    }
    return {
      category: FAILURE_CATEGORY.INVALID_REQUEST,
      retryable: false,
      retryAfterMs: null,
      quarantineDurationMs: null,
      evidence,
    };
  }

  // ── Provider Down / 5xx ────────────────────────────────────────
  if (
    (code >= 500 && code < 600) ||
    msg.includes('service unavailable') ||
    msg.includes('internal server error') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout') ||
    msg.includes('server error')
  ) {
    return {
      category: FAILURE_CATEGORY.PROVIDER_DOWN,
      retryable: true,
      retryAfterMs: 30_000,
      quarantineDurationMs: 5 * 60 * 1000,
      evidence,
    };
  }

  // ── Transient / Network ────────────────────────────────────────
  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'EPIPE' ||
    error.code === 'EAI_AGAIN' ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('dns') ||
    msg.includes('fetch failed')
  ) {
    return {
      category: FAILURE_CATEGORY.TRANSIENT,
      retryable: true,
      retryAfterMs: 5_000,
      quarantineDurationMs: 2 * 60 * 1000,
      evidence,
    };
  }

  // ── Permanent / Unknown ────────────────────────────────────────
  return {
    category: FAILURE_CATEGORY.PERMANENT,
    retryable: false,
    retryAfterMs: null,
    quarantineDurationMs: 15 * 60 * 1000,
    evidence,
  };
}

// ─── Recovery Policy ─────────────────────────────────────────────────

/**
 * Given a classified failure, determine the recovery action.
 */
function determineRecovery(classification, attemptHistory) {
  const { category, retryable, retryAfterMs } = classification;
  const sameProviderAttempts = attemptHistory.filter(
    a => a.providerId === attemptHistory.at(-1)?.providerId
  ).length;

  switch (category) {
    case FAILURE_CATEGORY.TRANSIENT:
      // Retry same provider up to 2 times with backoff, then failover
      if (sameProviderAttempts < 2) {
        const backoff = Math.min(5000 * Math.pow(2, sameProviderAttempts), 30_000);
        return { action: RECOVERY_ACTION.RETRY_BACKOFF, delayMs: backoff };
      }
      return { action: RECOVERY_ACTION.DEGRADE_FAILOVER, delayMs: 0 };

    case FAILURE_CATEGORY.RATE_LIMITED:
      // If we have retry-after, wait once then failover if it fails again
      if (sameProviderAttempts < 1 && retryAfterMs && retryAfterMs < 120_000) {
        return { action: RECOVERY_ACTION.RETRY_AFTER, delayMs: retryAfterMs };
      }
      return { action: RECOVERY_ACTION.DEGRADE_FAILOVER, delayMs: 0 };

    case FAILURE_CATEGORY.PROVIDER_DOWN:
      // One retry with backoff, then quarantine and failover
      if (sameProviderAttempts < 1) {
        return { action: RECOVERY_ACTION.RETRY_BACKOFF, delayMs: retryAfterMs || 15_000 };
      }
      return { action: RECOVERY_ACTION.DEGRADE_FAILOVER, delayMs: 0 };

    case FAILURE_CATEGORY.AUTH:
      // Never retry same broken credential — quarantine immediately
      return { action: RECOVERY_ACTION.DEGRADE_FAILOVER, delayMs: 0 };

    case FAILURE_CATEGORY.RESOURCE:
      // Failover to a provider with lower resource requirements
      return { action: RECOVERY_ACTION.ADAPT_FAILOVER, delayMs: 0 };

    case FAILURE_CATEGORY.INVALID_REQUEST:
      // Try next provider (may support the option)
      return { action: RECOVERY_ACTION.ADAPT_FAILOVER, delayMs: 0 };

    case FAILURE_CATEGORY.PERMANENT:
    default:
      // Quarantine this provider but still try alternatives
      return { action: RECOVERY_ACTION.DEGRADE_FAILOVER, delayMs: 0 };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractStatusCode(error) {
  // Try to pull status code from axios-style errors, fetch responses, etc.
  if (error.response?.status) return error.response.status;
  if (error.status) return error.status;
  const match = (error.message || '').match(/"code"\s*:\s*(\d{3})/);
  if (match) return parseInt(match[1], 10);
  return null;
}

function extractRetryAfter(error) {
  // Try to extract Retry-After from response headers
  const headers = error.response?.headers;
  if (!headers) return null;
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (!retryAfter) return null;
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  // Could be a date string
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

module.exports = {
  FAILURE_CATEGORY,
  RECOVERY_ACTION,
  classifyFailure,
  determineRecovery,
};
