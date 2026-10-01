const crypto = require('crypto');

/**
 * Canonical, provider-neutral capability records.
 *
 * The registry is deliberately metadata-only. It does not instantiate providers
 * or make network calls, which keeps route decisions deterministic and easy to
 * inspect before a generation request is submitted.
 */

const MODALITIES = Object.freeze(['llm', 'image', 'video', 'tts', 'transcribe', 'audio', 'embedding', 'browser']);
const CONFIDENCE = Object.freeze(['unknown', 'low', 'medium', 'high']);

const AUTHORITATIVE_PROVIDER_DICTIONARY = [
  // --- LLM ---
  {
    id: 'qwen-local', provider: 'QwenLocal', name: 'Qwen Local (Ollama)', modality: 'llm', local: true,
    capabilities: { text: true }, requirements: { runtime: 'ollama' }
  },
  {
    id: 'openai', provider: 'OpenAI', name: 'OpenAI', modality: 'llm', local: false,
    capabilities: { text: true }, requirements: { credentials: ['OPENAI_API_KEY'] }
  },
  {
    id: 'gemini', provider: 'Gemini', name: 'Gemini', modality: 'llm', local: false,
    capabilities: { text: true }, requirements: { credentials: ['GEMINI_API_KEY'] }
  },
  // --- IMAGE ---
  {
    id: 'pollinations', provider: 'Pollinations.ai', name: 'Pollinations Free Image', modality: 'image', local: false,
    capabilities: { image: true }, requirements: { credentials: [] }
  },
  {
    id: 'flux-local', provider: 'FluxLocal', name: 'FLUX.1-schnell Local', modality: 'image', local: true,
    capabilities: { image: true }, requirements: { runtime: 'comfyui' }
  },
  {
    id: 'openai-image', provider: 'OpenAI', name: 'OpenAI DALL-E', modality: 'image', local: false,
    capabilities: { image: true }, requirements: { credentials: ['OPENAI_API_KEY'] }
  },
  {
    id: 'gemini-image', provider: 'Gemini', name: 'Gemini Image', modality: 'image', local: false,
    capabilities: { image: true }, requirements: { credentials: ['GEMINI_API_KEY'] }
  },
  // --- TTS ---
  {
    id: 'free-tts', provider: 'FreeTTS', name: 'Free Unauthenticated TTS', modality: 'tts', local: false,
    capabilities: { tts: true }, requirements: { credentials: [] }
  },
  {
    id: 'openai-tts', provider: 'OpenAI', name: 'OpenAI TTS', modality: 'tts', local: false,
    capabilities: { tts: true }, requirements: { credentials: ['OPENAI_API_KEY'] }
  },
  {
    id: 'gemini-tts', provider: 'Gemini', name: 'Gemini TTS', modality: 'tts', local: false,
    capabilities: { tts: true }, requirements: { credentials: ['GEMINI_API_KEY'] }
  },
  // --- VIDEO ---
  {
    id: 'ffmpeg-slideshow', provider: 'FFmpeg', name: 'FFmpeg Slideshow', modality: 'video', local: true,
    capabilities: { video: true }, requirements: { runtime: 'ffmpeg' }
  },
  // --- TRANSCRIPTION ---
  {
    id: 'openai-whisper', provider: 'OpenAI', name: 'OpenAI Whisper', modality: 'transcribe', local: false,
    capabilities: { transcribe: true }, requirements: { credentials: ['OPENAI_API_KEY'] }
  },
  // --- BROWSER ---
  {
    id: 'system-browser', provider: 'SystemBrowser', name: 'System Chromium Browser', modality: 'browser', local: true,
    capabilities: { browser: true }, requirements: { runtime: 'browser' }
  }
];

class ReadinessState {
  constructor() {
    this.capabilities = {
      llm: { state: 'missing', options: [] },
      image: { state: 'missing', options: [] },
      tts: { state: 'missing', options: [] },
      video: { state: 'missing', options: [] },
      transcribe: { state: 'missing', options: [] },
      browser: { state: 'missing', options: [] }
    };
  }

  setOptionState(dictionaryEntry, state, reason = '') {
    const { modality, id, provider, name, local } = dictionaryEntry;
    if (!this.capabilities[modality]) return;
    
    let option = this.capabilities[modality].options.find(o => o.id === id);
    if (!option) {
      option = { id, provider, name, local };
      this.capabilities[modality].options.push(option);
    }
    
    option.status = state;
    option.reason = reason;
    option.lastChecked = new Date().toISOString();
    
    this._recalculateModalityState(modality);
  }

  updateFromProbe(dictionaryEntry, probeResult) {
    const status = probeResult.usable ? 'usable' : (probeResult.status || 'unavailable');
    this.setOptionState(dictionaryEntry, status, probeResult.reason);
    
    const option = this.capabilities[dictionaryEntry.modality]?.options.find(o => o.id === dictionaryEntry.id);
    if (option) {
      option.probeEvidence = probeResult;
    }
  }

  _recalculateModalityState(modality) {
    const options = this.capabilities[modality].options;
    if (options.length === 0) {
      this.capabilities[modality].state = 'missing';
      return;
    }
    
    if (options.some(o => o.status === 'usable')) {
      this.capabilities[modality].state = 'usable';
    } else if (options.some(o => o.status === 'degraded')) {
      this.capabilities[modality].state = 'degraded';
    } else if (options.some(o => o.status === 'probing')) {
      this.capabilities[modality].state = 'probing';
    } else if (options.some(o => o.status === 'configured')) {
      this.capabilities[modality].state = 'configured';
    } else if (options.every(o => o.status === 'missing')) {
      this.capabilities[modality].state = 'missing';
    } else {
      this.capabilities[modality].state = 'unavailable';
    }
  }

  getSummary() {
    return {
      LLM: this.capabilities.llm.state,
      IMAGE: this.capabilities.image.state,
      TTS: this.capabilities.tts.state,
      RENDERING: this.capabilities.video.state,
      TRANSCRIPTION: this.capabilities.transcribe.state,
      BROWSER: this.capabilities.browser.state
    };
  }
}

function asObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  return fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined);
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function asNumber(value, fallback = null) {
  if (value === Infinity) return Infinity;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boolOrNull(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === 'true';
}

function normalizeConfidence(value) {
  if (typeof value === 'number') {
    if (value >= 0.8) return 'high';
    if (value >= 0.55) return 'medium';
    if (value > 0) return 'low';
    return 'unknown';
  }
  const normalized = String(value || '').toLowerCase();
  return CONFIDENCE.includes(normalized) ? normalized : 'unknown';
}

function confidenceScore(value) {
  if (typeof value === 'number') return Math.max(0, Math.min(1, value));
  return { unknown: 0, low: 0.35, medium: 0.65, high: 0.9 }[normalizeConfidence(value)] || 0;
}

function stableId(record) {
  const value = `${record.provider || 'unknown'}:${record.model || 'unknown'}:${record.modality || 'unknown'}`;
  return `cap_${crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)}`;
}

function normalizeCapabilityRecord(input = {}) {
  const source = input.capabilityRecord || input.metadata || input;
  const modality = String(source.modality || source.type || 'llm').toLowerCase();
  const capabilities = asObject(source.capabilities);
  const duration = asObject(source.duration, {
    min: asNumber(source.minDuration, null),
    max: asNumber(source.maxDuration, null),
    default: asNumber(source.defaultDuration, null)
  });
  const resolution = asObject(source.resolution, {
    min: source.minResolution || null,
    max: source.maxResolution || null,
    default: source.defaultResolution || null,
    values: asArray(source.resolutions)
  });
  const inputData = asObject(source.input, {
    modalities: asArray(source.inputModalities || source.inputs),
    maxTokens: asNumber(source.maxInputTokens, null),
    maxPromptLength: asNumber(source.maxPromptLength, null),
    references: asObject(source.references)
  });
  const output = asObject(source.output, {
    modalities: asArray(source.outputModalities || source.outputs),
    formats: asArray(source.outputFormats)
  });
  const context = asObject(source.context, {
    window: asNumber(source.contextWindow || source.maxContextTokens, null),
    unit: source.contextUnit || 'tokens'
  });
  const api = source.api === false ? { enabled: false } : asObject(source.api, {
    enabled: source.api === true ? true : Boolean(source.endpoint || source.baseURL || source.baseUrl || source.apiKeyRequired),
    endpoint: source.endpoint || source.baseURL || source.baseUrl || null,
    keyRequired: boolOrNull(source.apiKeyRequired, null)
  });
  const cost = asObject(source.cost, {
    currency: source.currency || 'USD',
    perInputUnit: asNumber(source.inputCost ?? source.costPerInput, null),
    perOutputUnit: asNumber(source.outputCost ?? source.costPerOutput, null),
    perSecond: asNumber(source.costPerSecond, null),
    fixed: asNumber(typeof source.cost === 'number' ? source.cost : null, null),
    free: boolOrNull(source.free, null)
  });
  const latency = asObject(source.latency, {
    p50Ms: asNumber(source.p50LatencyMs, null),
    p95Ms: asNumber(source.p95LatencyMs, null),
    expectedMs: asNumber(source.expectedLatencyMs, null)
  });
  const hardware = asObject(source.hardware, {
    cpu: source.cpu || null,
    gpu: source.gpu || null,
    vramGb: asNumber(source.vramGb, null),
    ramGb: asNumber(source.ramGb, null)
  });
  const license = typeof source.license === 'string'
    ? { name: source.license, commercial: boolOrNull(source.commercial, null) }
    : asObject(source.license, { name: null, commercial: boolOrNull(source.commercial, null) });
  const reference = asObject(source.reference, {
    images: asNumber(source.referenceImages, null),
    videos: asNumber(source.referenceVideos, null),
    audio: asNumber(source.referenceAudios, null),
    firstFrame: boolOrNull(source.firstFrame, null),
    lastFrame: boolOrNull(source.lastFrame, null)
  });
  const consistency = asObject(source.consistency, {
    seed: boolOrNull(source.seed, null),
    character: boolOrNull(source.characterConsistency, null),
    temporal: boolOrNull(source.temporalConsistency, null),
    score: asNumber(source.consistencyScore, null)
  });
  const audio = asObject(source.audio, {
    input: boolOrNull(source.audioInput, null),
    output: boolOrNull(source.audioOutput ?? source.nativeAudio, null),
    native: boolOrNull(source.nativeAudio, null)
  });
  const structuredOutput = typeof source.structuredOutput === 'object'
    ? asObject(source.structuredOutput)
    : { supported: boolOrNull(source.structuredOutput, null), formats: asArray(source.structuredOutputFormats) };
  const reliability = typeof source.reliability === 'object'
    ? asObject(source.reliability)
    : { availability: asNumber(source.reliability, null), score: asNumber(source.reliabilityScore, null) };
  const notes = asArray(source.notes).map(String);
  const normalized = {
    id: source.id || stableId(source),
    provider: String(source.provider || source.name || 'unknown'),
    model: String(source.model || source.id || 'unknown'),
    modality,
    capabilities,
    input: inputData,
    output,
    context,
    duration,
    resolution,
    fps: asObject(source.fps, {
      min: asNumber(source.minFps, null),
      max: asNumber(source.maxFps, null),
      default: asNumber(source.defaultFps, null)
    }),
    local: boolOrNull(source.local, false),
    api,
    cost,
    latency,
    hardware,
    license,
    commercial: boolOrNull(source.commercial, license.commercial),
    reference,
    consistency,
    audio,
    structuredOutput,
    reliability,
    notes,
    adaptations: asArray(source.adaptations),
    unsupportedOptions: asArray(source.unsupportedOptions),
    available: boolOrNull(source.available, true),
    confidence: normalizeConfidence(source.confidence),
    source: source.source || null
  };
  return normalized;
}

function providerToCapabilityRecord(provider, metadata = {}) {
  if (!provider) return normalizeCapabilityRecord(metadata);
  return normalizeCapabilityRecord({
    ...metadata,
    id: metadata.id || provider.id,
    provider: metadata.provider || provider.id || provider.name,
    name: metadata.name || provider.name,
    model: metadata.model || provider.model,
    modality: metadata.modality || provider.type,
    capabilities: { ...(provider.capabilities || {}), ...(metadata.capabilities || {}) },
    local: metadata.local ?? provider.local,
    available: metadata.available ?? provider.isAvailable
  });
}

class ModelCapabilityRegistry {
  constructor(records = []) {
    this.records = new Map();
    records.forEach(record => this.register(record));
  }

  register(record) {
    const normalized = normalizeCapabilityRecord(record);
    this.records.set(normalized.id, normalized);
    return normalized;
  }

  registerProvider(provider, metadata = {}) {
    return this.register(providerToCapabilityRecord(provider, metadata));
  }

  get(id) { return this.records.get(id) || null; }
  list(filter = {}) {
    return Array.from(this.records.values())
      .filter(record => !filter.modality || record.modality === filter.modality)
      .sort((a, b) => `${a.provider}:${a.model}:${a.id}`.localeCompare(`${b.provider}:${b.model}:${b.id}`));
  }
  toJSON() { return this.list(); }
}

function numberOrInfinity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Infinity;
}

function requiredCapabilities(request) {
  return asArray(request.capabilities || request.requires).map(String);
}

function getCost(record, request = {}) {
  const cost = record.cost || {};
  if (Number.isFinite(cost.fixed)) return cost.fixed;
  const seconds = Number(request.duration || 0);
  if (Number.isFinite(cost.perSecond) && seconds) return cost.perSecond * seconds;
  const input = Number(request.inputUnits || request.inputTokens || 0);
  const output = Number(request.outputUnits || request.outputTokens || 0);
  return (Number(cost.perInputUnit) || 0) * input + (Number(cost.perOutputUnit) || 0) * output;
}

function getQuality(record) {
  const capability = record.capabilities || {};
  return Number(record.quality ?? capability.quality ?? capability.qualityScore ?? 0) || 0;
}

function checkConstraint(record, request = {}) {
  const reasons = [];
  if (request.modality && record.modality !== String(request.modality).toLowerCase()) reasons.push('modality mismatch');
  if (request.localOnly && record.local !== true) reasons.push('local-only constraint');
  if (request.privacy === 'local' && record.local !== true) reasons.push('privacy requires local execution');
  if (request.apiRequired && record.api?.enabled !== true) reasons.push('API required');
  if (request.commercial === true && record.commercial !== true && record.license?.commercial !== true) reasons.push('commercial-use license not confirmed');
  if (request.license && record.license?.name && record.license.name !== request.license) reasons.push('license mismatch');
  if (request.licenseAllowlist?.length && !request.licenseAllowlist.includes(record.license?.name)) reasons.push('license not allowed');
  if (request.maxCost !== undefined && getCost(record, request) > Number(request.maxCost)) reasons.push('budget exceeded');
  if (request.maxLatencyMs !== undefined && Number(record.latency?.expectedMs ?? record.latency?.p50Ms ?? Infinity) > Number(request.maxLatencyMs)) reasons.push('latency exceeded');
  if (request.hardware?.gpu && record.hardware?.gpu && !String(record.hardware.gpu).toLowerCase().includes(String(request.hardware.gpu).toLowerCase())) reasons.push('GPU requirement mismatch');
  if (request.hardware?.minVramGb && Number(record.hardware?.vramGb || 0) < Number(request.hardware.minVramGb)) reasons.push('VRAM requirement not met');
  if (request.duration !== undefined) {
    const duration = Number(request.duration);
    if (record.duration?.min !== null && record.duration?.min !== undefined && duration < Number(record.duration.min)) reasons.push('duration below minimum');
    if (record.duration?.max !== null && record.duration?.max !== undefined && duration > numberOrInfinity(record.duration.max)) reasons.push('duration above maximum');
  }
  if (request.resolution && record.resolution?.values?.length && !record.resolution.values.includes(request.resolution)) reasons.push('resolution unsupported');
  if (request.fps !== undefined && record.fps?.max !== null && Number(request.fps) > Number(record.fps.max)) reasons.push('FPS unsupported');
  for (const capability of requiredCapabilities(request)) {
    if (record.capabilities?.[capability] !== true && !record.capabilities?.[capability]) reasons.push(`missing capability: ${capability}`);
  }
  if (request.structuredOutput && record.structuredOutput?.supported !== true) reasons.push('structured output unsupported');
  if (request.audio && request.audio !== record.audio?.output && record.audio?.output !== true) reasons.push('audio output unsupported');
  if (request.references) {
    for (const [kind, amount] of Object.entries(request.references)) {
      const available = record.reference?.[kind] ?? 0;
      if (Number(amount) > Number(available)) reasons.push(`reference ${kind} unsupported`);
    }
  }
  if (record.available === false) reasons.push('provider unavailable');
  return reasons;
}

/**
 * Select a route without depending on registration order or wall-clock state.
 * Hard constraints are applied first, then candidates are sorted quality-first.
 */
function selectDeterministicRoute(records = [], request = {}, options = {}) {
  const normalized = records.map(normalizeCapabilityRecord);
  const rejected = [];
  const eligible = [];
  for (const record of normalized) {
    const reasons = checkConstraint(record, request);
    if (reasons.length) rejected.push({ record, reasons });
    else eligible.push(record);
  }
  const reliability = record => Number(record.reliability?.score ?? record.reliability?.availability ?? 0) || 0;
  const quality = record => getQuality(record);
  eligible.sort((a, b) => (
    quality(b) - quality(a) ||
    reliability(b) - reliability(a) ||
    (b.local === true ? 1 : 0) - (a.local === true ? 1 : 0) ||
    getCost(a, request) - getCost(b, request) ||
    `${a.provider}:${a.model}:${a.id}`.localeCompare(`${b.provider}:${b.model}:${b.id}`)
  ));
  const selected = eligible[0] || null;
  const fallback = Boolean(selected && (options.preferredProvider || options.preferredModel) && (
    selected.provider !== options.preferredProvider && selected.model !== options.preferredModel
  ));
  const rationale = selected
    ? [
      `Selected ${selected.provider}/${selected.model} by quality-first ordering`,
      `quality=${quality(selected)}`,
      `reliability=${reliability(selected)}`,
      `estimatedCost=${getCost(selected, request)}`,
      ...(fallback ? ['preferred route unavailable or did not satisfy constraints'] : [])
    ]
    : ['No capability record satisfies the requested constraints'];
  const confidence = selected
    ? Math.max(0, Math.min(1, (confidenceScore(selected.confidence) + Math.min(1, reliability(selected) || 0)) / 2 || (quality(selected) ? 0.7 : 0.4)))
    : 0;
  return {
    selected,
    provider: selected?.provider || null,
    model: selected?.model || null,
    fallback,
    fallbackUsed: fallback,
    candidates: eligible,
    rejected,
    rationale,
    confidence,
    request: { ...request }
  };
}

module.exports = {
  MODALITIES,
  CONFIDENCE,
  confidenceScore,
  normalizeConfidence,
  normalizeCapabilityRecord,
  providerToCapabilityRecord,
  ModelCapabilityRegistry,
  selectDeterministicRoute,
  getCost,
  checkConstraint,
  AUTHORITATIVE_PROVIDER_DICTIONARY,
  ReadinessState
};
