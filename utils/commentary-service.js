const { Logger } = require('./logger');
const { AITextService } = require('./ai-text-service');

class CommentaryService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('Commentary');
    this.aiTextService = options.aiTextService || new AITextService(options.credentials || {});
  }

  /**
   * Generates original commentary for a remix plan.
   * Crafts a cohesive script for the original segments defined in the plan.
   */
  async generateCommentary(planId, options = {}) {
    const plan = await this.db.getRemixPlan(planId);
    if (!plan) throw this.notFound('Plan not found');
    
    if (plan.status !== 'draft') {
      this.logger.warn(`Plan ${planId} is not in draft status (${plan.status})`);
    }

    this.logger.info(`Generating commentary for plan ${planId} (Style: ${plan.commentary_style})`);

    // Fetch the transcript for context
    const transcript = await this.db.getRemixTranscript(plan.source_id);
    const transcriptText = transcript ? transcript.full_text : '(No transcript available)';

    // Fetch the highlight texts
    const sourceContext = await this.buildSourceContext(plan.sourceSegments);

    let scriptText;
    if (this.aiTextService.isAvailable()) {
      scriptText = await this.generateWithAI(plan, sourceContext, transcriptText, options);
    } else {
      this.logger.warn('AI Text Service not available. Generating placeholder commentary.');
      scriptText = this.generatePlaceholder(plan);
    }

    const commentary = await this.db.createRemixCommentary({
      planId,
      scriptText: JSON.stringify(scriptText),
      style: plan.commentary_style,
      ttsProvider: options.ttsProvider || null,
      ttsModel: options.ttsModel || null,
      status: 'generated'
    });

    // Update plan status
    await this.db.updateRemixPlan(planId, { status: 'scripted' });

    this.logger.info(`Commentary generated: ${commentary.id}`);
    return commentary;
  }

  async buildSourceContext(sourceSegments) {
    let context = '';
    for (const seg of sourceSegments) {
      const highlight = await this.db.getRow('SELECT * FROM remix_highlights WHERE id = ?', [seg.highlightId]);
      if (highlight) {
        context += `\nClip [${seg.id}] (${highlight.duration}s): "${highlight.transcript_excerpt || 'Audio/Visual content'}"\n`;
      }
    }
    return context;
  }

  async generateWithAI(plan, sourceContext, _fullTranscript, _options) {
    const originalSegments = plan.originalSegments;
    
    const segmentsJson = originalSegments.map(s => ({
      id: s.id,
      type: s.type,
      estimatedDuration: s.estimatedDuration
    }));

    const prompt = `
You are an expert scriptwriter for short-form video (TikTok/Reels/Shorts).
You are writing original commentary for a remix video.
The overall style should be: ${plan.commentary_style}.

Here are the clips from the original video that will be shown:
${sourceContext}

We need original script for the following segments:
${JSON.stringify(segmentsJson, null, 2)}

Instructions:
1. Write engaging, natural-sounding dialogue.
2. Keep it concise. A 5-second segment should be about 10-15 words.
3. The hook (if present) must be incredibly catchy.
4. The transitions between the source clips should feel natural.

Respond ONLY with a JSON object mapping each segment ID to its spoken text.
Example response:
{
  "orig_hook": "You won't believe what happens at the end!",
  "orig_react_0": "Exactly, and that's why this is so important."
}
`;

    try {
      const responseText = await this.aiTextService.generateText(prompt, { temperature: 0.7 });
      
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in LLM response');
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Ensure all segments have text
      const scriptContent = {};
      for (const seg of originalSegments) {
        scriptContent[seg.id] = parsed[seg.id] || `[Missing commentary for ${seg.type}]`;
      }
      
      return scriptContent;
    } catch (error) {
      this.logger.error(`AI commentary generation failed: ${error.message}`);
      return this.generatePlaceholder(plan);
    }
  }

  generatePlaceholder(plan) {
    const scriptContent = {};
    for (const seg of plan.originalSegments) {
      scriptContent[seg.id] = `[Placeholder ${seg.type} text for ${plan.commentary_style} style]`;
    }
    return scriptContent;
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

module.exports = { CommentaryService };
