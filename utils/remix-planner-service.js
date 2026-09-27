const { Logger } = require('./logger');

class RemixPlannerService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('RemixPlanner');
  }

  /**
   * Generates a structural plan for a remix based on selected highlights.
   * A plan combines original commentary/narration with selected source segments.
   */
  async createPlan(sourceId, highlightIds, options = {}) {
    const source = await this.db.getRemixSource(sourceId);
    if (!source) throw this.notFound('Source not found');

    if (!highlightIds || !highlightIds.length) {
      throw this.invalid('At least one highlight ID must be provided');
    }

    const highlights = [];
    for (const hid of highlightIds) {
      const h = await this.db.getRow('SELECT * FROM remix_highlights WHERE id = ?', [hid]);
      if (!h) throw this.notFound(`Highlight ${hid} not found`);
      highlights.push(h);
    }

    this.logger.info(`Creating remix plan for source ${sourceId} with ${highlights.length} highlights`);

    const commentaryStyle = options.commentaryStyle || 'reaction'; // reaction, analytical, summary
    const title = options.title || `Remix: ${source.original_url || source.file_path}`;

    // Structure the plan
    const structure = this.buildStructure(highlights, commentaryStyle);
    
    // Calculate estimated duration
    const sourceDuration = highlights.reduce((acc, h) => acc + h.duration, 0);
    const estimatedOriginalDuration = structure.originalSegments.reduce((acc, s) => acc + (s.estimatedDuration || 0), 0);
    const targetDuration = sourceDuration + estimatedOriginalDuration;

    const plan = await this.db.createRemixPlan({
      sourceId,
      title,
      structure,
      sourceSegments: structure.sourceSegments,
      originalSegments: structure.originalSegments,
      commentaryStyle,
      targetDuration,
      status: 'draft'
    });

    this.logger.info(`Remix plan created: ${plan.id} (Est. Duration: ${targetDuration}s)`);
    return plan;
  }

  buildStructure(highlights, style) {
    const sourceSegments = [];
    const originalSegments = [];
    const structureElements = [];

    // Simple structural templates based on style
    if (style === 'reaction') {
      // Hook -> Source 1 -> Reaction -> Source 2 -> Reaction -> Outro
      originalSegments.push({ id: 'orig_hook', type: 'hook', position: 0, estimatedDuration: 5 });
      structureElements.push({ type: 'original', segmentId: 'orig_hook' });

      highlights.forEach((h, index) => {
        const sourceId = `src_${index}`;
        const reactId = `orig_react_${index}`;

        sourceSegments.push({ id: sourceId, highlightId: h.id, position: structureElements.length, duration: h.duration });
        structureElements.push({ type: 'source', segmentId: sourceId });

        originalSegments.push({ id: reactId, type: 'reaction', position: structureElements.length, estimatedDuration: 5 });
        structureElements.push({ type: 'original', segmentId: reactId });
      });
      
      originalSegments.push({ id: 'orig_outro', type: 'outro', position: structureElements.length, estimatedDuration: 5 });
      structureElements.push({ type: 'original', segmentId: 'orig_outro' });

    } else if (style === 'summary') {
      // Intro -> All sources stitched -> Summary/CTA
      originalSegments.push({ id: 'orig_intro', type: 'intro', position: 0, estimatedDuration: 10 });
      structureElements.push({ type: 'original', segmentId: 'orig_intro' });

      highlights.forEach((h, index) => {
        const sourceId = `src_${index}`;
        sourceSegments.push({ id: sourceId, highlightId: h.id, position: structureElements.length, duration: h.duration });
        structureElements.push({ type: 'source', segmentId: sourceId });
      });

      originalSegments.push({ id: 'orig_summary', type: 'summary_cta', position: structureElements.length, estimatedDuration: 10 });
      structureElements.push({ type: 'original', segmentId: 'orig_summary' });

    } else {
      // Default / analytical
      // Interleaved: Intro -> Source -> Analysis -> Source -> Analysis ...
      originalSegments.push({ id: 'orig_intro', type: 'intro', position: 0, estimatedDuration: 5 });
      structureElements.push({ type: 'original', segmentId: 'orig_intro' });

      highlights.forEach((h, index) => {
        const sourceId = `src_${index}`;
        const analysisId = `orig_analysis_${index}`;

        sourceSegments.push({ id: sourceId, highlightId: h.id, position: structureElements.length, duration: h.duration });
        structureElements.push({ type: 'source', segmentId: sourceId });

        originalSegments.push({ id: analysisId, type: 'analysis', position: structureElements.length, estimatedDuration: 10 });
        structureElements.push({ type: 'original', segmentId: analysisId });
      });
    }

    return {
      sequence: structureElements,
      sourceSegments,
      originalSegments
    };
  }

  async getPlan(planId) {
    const plan = await this.db.getRemixPlan(planId);
    if (!plan) throw this.notFound('Plan not found');
    return plan;
  }

  invalid(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
  }

  notFound(message) {
    const error = new Error(message);
    error.status = 404;
    return error;
  }
}

module.exports = { RemixPlannerService };
