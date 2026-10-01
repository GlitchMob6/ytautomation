const crypto = require('crypto');

const CONFIDENCE_SCORES = Object.freeze({ unknown: 0, low: 0.35, medium: 0.65, high: 0.9 });

function asArray(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function stableId(prefix, value) {
  const digest = crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}

function normalizeConfidence(value) {
  if (typeof value === 'number') {
    if (value >= 0.8) return 'high';
    if (value >= 0.55) return 'medium';
    if (value > 0) return 'low';
    return 'unknown';
  }
  const normalized = String(value || 'unknown').toLowerCase();
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_SCORES, normalized) ? normalized : 'unknown';
}

function normalizeSource(source, index = 0) {
  if (typeof source === 'string') {
    return { id: `source_${index + 1}`, uri: source, title: null, type: 'reference', locator: null };
  }
  const value = source || {};
  return {
    id: value.id || value.sourceId || `source_${index + 1}`,
    uri: value.uri || value.url || value.path || null,
    title: value.title || value.name || null,
    type: value.type || value.sourceType || 'reference',
    locator: value.locator || value.timestamp || value.page || null,
    rights: value.rights || value.license || null,
    notes: value.notes || null
  };
}

function normalizeClaim(claim, index = 0, sources = []) {
  const value = typeof claim === 'string' ? { text: claim } : (claim || {});
  const sourceIds = asArray(value.sourceIds || value.sources || value.sourceLinks)
    .map(source => typeof source === 'string' ? source : source?.id || source?.sourceId)
    .filter(Boolean);
  const linkedSources = sourceIds.map(id => sources.find(source => source.id === id)).filter(Boolean);
  return {
    id: value.id || `claim_${index + 1}`,
    text: String(value.text || value.claim || value.statement || ''),
    confidence: normalizeConfidence(value.confidence),
    confidenceScore: typeof value.confidence === 'number' ? Math.max(0, Math.min(1, value.confidence)) : CONFIDENCE_SCORES[normalizeConfidence(value.confidence)],
    sourceIds,
    sourceLinkage: linkedSources.map(source => ({ id: source.id, uri: source.uri, locator: source.locator })),
    status: value.status || (sourceIds.length ? 'sourced' : 'needs_source'),
    notes: value.notes || null
  };
}

function normalizeContentBrief(input = {}) {
  const sources = asArray(input.sources || input.references).map(normalizeSource);
  const claims = asArray(input.claims || input.facts).map((claim, index) => normalizeClaim(claim, index, sources));
  const durationSeconds = Number(input.durationSeconds ?? input.duration ?? 0);
  const constraints = {
    ...(input.constraints && typeof input.constraints === 'object' ? input.constraints : {}),
    budget: input.budget ?? input.constraints?.budget ?? null,
    privacy: input.privacy ?? input.constraints?.privacy ?? null,
    localOnly: input.localOnly ?? input.constraints?.localOnly ?? false,
    license: input.license ?? input.constraints?.license ?? null,
    commercial: input.commercial ?? input.constraints?.commercial ?? null
  };
  return {
    id: input.id || stableId('brief', {
      topic: input.topic || input.title || '', audience: input.audience || '', format: input.format || input.contentType || ''
    }),
    topic: String(input.topic || input.title || '').trim(),
    title: input.title || null,
    objective: input.objective || input.goal || null,
    audience: input.audience || input.targetAudience || null,
    platform: input.platform || 'youtube',
    format: input.format || input.contentType || 'explainer',
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    tone: input.tone || 'clear',
    style: input.style || null,
    language: input.language || 'en',
    constraints,
    keywords: asArray(input.keywords).map(String),
    sources,
    claims,
    claimConfidence: claims.length
      ? claims.reduce((sum, claim) => sum + claim.confidenceScore, 0) / claims.length
      : 0,
    notes: asArray(input.notes).map(String)
  };
}

function buildContextPack(briefInput = {}, options = {}) {
  const brief = briefInput.topic !== undefined && briefInput.claims !== undefined && briefInput.id
    ? normalizeContentBrief(briefInput)
    : normalizeContentBrief(briefInput);
  const extraSources = asArray(options.sources).map(normalizeSource);
  const sourceMap = new Map([...brief.sources, ...extraSources].map(source => [source.id, source]));
  const sources = Array.from(sourceMap.values());
  const claims = brief.claims.map(claim => ({
    ...claim,
    sourceLinkage: claim.sourceIds.map(id => sourceMap.get(id)).filter(Boolean).map(source => ({ id: source.id, uri: source.uri, locator: source.locator }))
  }));
  const instructions = asArray(options.instructions || brief.instructions).map(String);
  return {
    id: options.id || stableId('context', { briefId: brief.id, sourceIds: sources.map(source => source.id), instructions }),
    briefId: brief.id,
    brief,
    summary: options.summary || brief.objective || brief.topic,
    objective: brief.objective,
    constraints: { ...brief.constraints },
    sources,
    claims,
    instructions,
    sourceIds: sources.map(source => source.id),
    claimConfidence: claims.length ? claims.reduce((sum, claim) => sum + claim.confidenceScore, 0) / claims.length : 0,
    confidence: claims.length ? (claims.every(claim => claim.confidence === 'high') ? 'high' : 'medium') : 'unknown'
  };
}

function splitDuration(total, count) {
  const duration = Number(total) || count * 8;
  const base = Math.floor((duration / count) * 100) / 100;
  const values = Array.from({ length: count }, () => base);
  values[values.length - 1] = Math.max(0.1, Number((duration - base * (count - 1)).toFixed(2)));
  return values;
}

function planScenes(briefOrContext, options = {}) {
  const brief = briefOrContext?.briefId
    ? normalizeContentBrief(briefOrContext.brief || options.brief || {})
    : normalizeContentBrief(briefOrContext);
  const context = options.contextPack || (briefOrContext?.briefId ? briefOrContext : buildContextPack(brief, options));
  const requested = Number(options.sceneCount || 0);
  const count = Math.max(1, requested || (brief.durationSeconds ? Math.min(12, Math.max(3, Math.ceil(brief.durationSeconds / 12))) : 5));
  const labels = options.labels || ['Hook', 'Context', 'Core idea', 'Demonstration', 'Takeaway', 'Call to action'];
  const durations = splitDuration(brief.durationSeconds || count * 8, count);
  return Array.from({ length: count }, (_, index) => {
    const label = labels[index] || `Section ${index + 1}`;
    const sourceIds = context.sourceIds || [];
    return {
      id: `scene_${index + 1}`,
      position: index,
      label,
      duration: durations[index],
      objective: index === 0 ? 'Earn attention and set the promise' : index === count - 1 ? 'Summarize and invite the next action' : `Advance the ${brief.format} narrative`,
      narration: index === 0 ? (brief.title || brief.topic || 'Today we will cover the practical essentials.') : '',
      visualPrompt: `${brief.style || 'clear'} ${brief.format} visual for ${label.toLowerCase()}`,
      sourceIds,
      claimIds: context.claims.map(claim => claim.id),
      confidence: context.confidence || 'unknown',
      sourceLinkage: context.claims.map(claim => ({ claimId: claim.id, sourceIds: claim.sourceIds }))
    };
  });
}

function planScript(briefInput = {}, options = {}) {
  const brief = normalizeContentBrief(briefInput);
  const context = options.contextPack || buildContextPack(brief, options);
  const scenes = options.scenes || planScenes(brief, { ...options, contextPack: context });
  return {
    id: options.id || stableId('script', { briefId: brief.id, sceneCount: scenes.length }),
    briefId: brief.id,
    title: brief.title || brief.topic || 'Untitled plan',
    hook: scenes[0]?.narration || '',
    sections: scenes.map(scene => ({
      id: scene.id,
      heading: scene.label,
      purpose: scene.objective,
      sourceIds: scene.sourceIds,
      claimIds: scene.claimIds,
      confidence: scene.confidence
    })),
    scenes,
    claims: context.claims,
    sources: context.sources,
    confidence: context.confidence,
    sourceLinkage: context.claims.map(claim => ({ claimId: claim.id, sourceIds: claim.sourceIds }))
  };
}

// Explicit aliases keep the foundation convenient for API consumers while the
// names above remain the canonical implementation.
const normalizeBrief = normalizeContentBrief;
const createContextPack = buildContextPack;
const buildScenePlan = planScenes;
const buildScriptPlan = planScript;

module.exports = {
  CONFIDENCE_SCORES,
  normalizeSource,
  normalizeClaim,
  normalizeContentBrief,
  normalizeBrief,
  buildContextPack,
  createContextPack,
  planScenes,
  buildScenePlan,
  planScript,
  buildScriptPlan
};
