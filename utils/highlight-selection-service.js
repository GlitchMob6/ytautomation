const { Logger } = require('./logger');
const { AITextService } = require('./ai-text-service');

class HighlightSelectionService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('HighlightSelection');
    this.aiTextService = options.aiTextService || new AITextService(options.credentials || {});
    this.maxContextWords = 4000;
  }

  /**
   * Deterministically and semantically select the best candidate moments from a transcript.
   * Relies on the AI Text Service to evaluate "hook strength" and "context completeness".
   */
  async selectHighlights(sourceId, options = {}) {
    const source = await this.db.getRemixSource(sourceId);
    if (!source) throw this.notFound('Source not found');

    const transcript = await this.db.getRemixTranscript(sourceId);
    if (!transcript || transcript.status !== 'completed') {
      throw this.invalid('A completed transcript is required for highlight selection');
    }

    const segments = transcript.segments || [];
    if (!segments.length) {
      throw this.invalid('Transcript has no segments');
    }

    this.logger.info(`Selecting highlights for source ${sourceId} (${segments.length} segments)`);

    // 1. Group segments into potential candidate windows (e.g., 15-45s blocks)
    const candidates = this.generateCandidates(segments, options.minDuration || 15, options.maxDuration || 45);
    
    // 2. Pre-filter using heuristics (e.g. discard very short blocks with no words)
    const filtered = this.heuristicFilter(candidates);

    // 3. Score with LLM (if available and enough content)
    let selected;
    if (this.aiTextService.isAvailable() && filtered.length > 0) {
      selected = await this.scoreCandidatesWithAI(filtered, source, transcript.fullText, options);
    } else {
      this.logger.warn('AI Text Service not available or no valid candidates. Falling back to heuristic selection.');
      selected = this.fallbackSelection(filtered, options.limit || 5);
    }

    // 4. Save to DB
    const savedHighlights = [];
    for (const item of selected) {
      const saved = await this.db.createRemixHighlight({
        sourceId,
        transcriptId: transcript.id,
        startTime: item.startTime,
        endTime: item.endTime,
        duration: item.duration,
        reason: item.reason,
        hookStrength: item.hookStrength,
        contextCompleteness: item.contextCompleteness,
        recommendedDuration: item.duration, // Default to actual duration
        transcriptExcerpt: item.transcriptExcerpt,
        status: 'selected'
      });
      savedHighlights.push(saved);
    }

    this.logger.info(`Selected ${savedHighlights.length} highlights`);
    return savedHighlights;
  }

  generateCandidates(segments, minDuration, maxDuration) {
    const candidates = [];
    for (let i = 0; i < segments.length; i++) {
      let currentDuration = 0;
      let text = '';
      let j = i;
      while (j < segments.length) {
        currentDuration = segments[j].end - segments[i].start;
        text += (text ? ' ' : '') + segments[j].text;
        
        if (currentDuration >= minDuration && currentDuration <= maxDuration) {
          candidates.push({
            startIndex: i,
            endIndex: j,
            startTime: segments[i].start,
            endTime: segments[j].end,
            duration: currentDuration,
            transcriptExcerpt: text.trim()
          });
        }
        
        if (currentDuration > maxDuration) break;
        j++;
      }
    }
    return candidates;
  }

  heuristicFilter(candidates) {
    // Basic filter: ensure there is enough text density (words per second)
    return candidates.filter(c => {
      const wordCount = c.transcriptExcerpt.split(/\s+/).length;
      const wps = wordCount / c.duration;
      return wps >= 0.5 && wps <= 4.0; // Reasonable speech rate
    });
  }

  async scoreCandidatesWithAI(candidates, source, fullText, options) {
    const limit = options.limit || 5;
    
    // Select a diverse subset of candidates to send to the LLM to avoid token overflow
    // e.g. pick evenly spaced candidates across the video
    const sampleSize = Math.min(candidates.length, 20);
    const step = Math.max(1, Math.floor(candidates.length / sampleSize));
    const sampledCandidates = candidates.filter((_, i) => i % step === 0).slice(0, sampleSize).map((c, i) => ({ ...c, id: i }));

    const candidatesJson = sampledCandidates.map(c => ({
      id: c.id,
      start: c.startTime.toFixed(1),
      end: c.endTime.toFixed(1),
      duration: c.duration.toFixed(1),
      text: c.transcriptExcerpt
    }));

    const prompt = `
You are an expert video editor looking for the best short-form (TikTok/Reels/Shorts) highlights from a longer video.
The video is about ${source.duration} seconds long.

Here are ${sampledCandidates.length} candidate clips from the video.
Please select the best ${Math.min(limit, sampledCandidates.length)} clips based on:
1. Hook strength: Is the first sentence engaging?
2. Context completeness: Does the clip make sense on its own?
3. Emotional/Informational value: Is it funny, surprising, or highly informative?

Candidate Clips:
${JSON.stringify(candidatesJson, null, 2)}

Respond ONLY with a JSON array of objects representing the selected clips.
Each object must have:
- "id": the integer ID of the clip from the list above.
- "reason": a short string explaining why this clip is great.
- "hookStrength": a float between 0.0 and 1.0.
- "contextCompleteness": a float between 0.0 and 1.0.

Example response:
[
  { "id": 2, "reason": "Strong opening question with a clear answer", "hookStrength": 0.9, "contextCompleteness": 0.8 }
]
`;

    try {
      const responseText = await this.aiTextService.generateText(prompt, { temperature: 0.2 });
      
      // Parse JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array found in LLM response');
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      const selected = [];
      for (const item of parsed) {
        const candidate = sampledCandidates.find(c => c.id === item.id);
        if (candidate) {
          selected.push({
            ...candidate,
            reason: item.reason || 'AI Selected',
            hookStrength: Number(item.hookStrength) || 0.5,
            contextCompleteness: Number(item.contextCompleteness) || 0.5
          });
        }
      }
      
      // Sort by hook strength descending
      return selected.sort((a, b) => b.hookStrength - a.hookStrength).slice(0, limit);
      
    } catch (error) {
      this.logger.error(`AI scoring failed, falling back to heuristic: ${error.message}`);
      return this.fallbackSelection(candidates, limit);
    }
  }

  fallbackSelection(candidates, limit) {
    // Sort by duration (prefer longer within the bound) and text length
    const sorted = [...candidates].sort((a, b) => {
      const scoreA = a.duration * a.transcriptExcerpt.length;
      const scoreB = b.duration * b.transcriptExcerpt.length;
      return scoreB - scoreA;
    });
    
    return sorted.slice(0, limit).map(c => ({
      ...c,
      reason: 'Heuristic selection (highest text density * duration)',
      hookStrength: 0.5,
      contextCompleteness: 0.5
    }));
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

module.exports = { HighlightSelectionService };
