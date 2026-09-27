const { Logger } = require('./logger');

class TransformationQAService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('TransformationQA');
  }

  /**
   * Evaluates a completed remix against the original source to quantify the degree of transformation.
   * This is used for editorial transparency and fair use measurement.
   */
  async evaluateTransformation(jobId) {
    this.logger.info(`Starting transformation QA evaluation for job ${jobId}`);

    const job = await this.db.getRow('SELECT * FROM remix_jobs WHERE id = ?', [jobId]);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const plan = await this.db.getRemixPlan(job.plan_id);
    const source = await this.db.getRemixSource(job.source_id);

    if (!plan || !source) {
      throw new Error('Plan or Source missing for QA evaluation');
    }

    // 1. Calculate structural metrics
    const originalDuration = source.duration || 1;
    const targetDuration = plan.target_duration || 1;
    
    // Duration ratio: how much shorter is the remix compared to the original?
    const durationRatio = targetDuration / originalDuration;

    // Source overlap: how much of the final video is original source content?
    // We sum up the duration of all source clips used.
    let totalSourceUsed = 0;
    if (plan.sourceSegments && Array.isArray(plan.sourceSegments)) {
      totalSourceUsed = plan.sourceSegments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
    }
    const sourceOverlap = targetDuration > 0 ? totalSourceUsed / targetDuration : 0;
    const originalRatio = originalDuration > 0 ? totalSourceUsed / originalDuration : 0;

    // 2. Measure audio/visual fingerprint similarity
    // In a full implementation, this would use Chromaprint and pHash binaries
    // to compare the output video against the source video and compute a structural distance.
    const phashScore = await this._calculatePHashSimilarity(source.file_path, job.output_path);
    const chromaprintScore = await this._calculateAudioSimilarity(source.file_path, job.output_path);

    // 3. Compute overall structural score
    // Lower score means more transformation (0.0 = completely different, 1.0 = identical clone)
    const structuralScore = (sourceOverlap * 0.4) + (phashScore * 0.3) + (chromaprintScore * 0.3);

    const summary = this._generateSummary(structuralScore, durationRatio);

    this.logger.info(`QA Evaluation complete. Structural Score: ${structuralScore.toFixed(2)}`);

    // Store results
    const qaId = this.db.generateId('rqa');
    await this.db.executeQuery(
      `INSERT INTO remix_qa_results (
        id, job_id, source_overlap, audio_overlap, transcript_overlap,
        original_ratio, duration_ratio, phash_score, chromaprint_score,
        structural_score, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        qaId, jobId, sourceOverlap, 0, 0, originalRatio, durationRatio,
        phashScore, chromaprintScore, structuralScore, summary
      ]
    );

    return this.db.getRow('SELECT * FROM remix_qa_results WHERE id = ?', [qaId]);
  }

  async _calculatePHashSimilarity(_sourcePath, _outputPath) {
    // Stub: Simulate perceptual hash comparison
    // Real implementation would invoke ffmpeg/ffprobe or a native library to extract frames
    // and compute Hamming distance between hashes.
    return 0.45; // 45% visual similarity
  }

  async _calculateAudioSimilarity(_sourcePath, _outputPath) {
    // Stub: Simulate Chromaprint/fpcalc audio footprint comparison
    return 0.30; // 30% audio similarity
  }

  _generateSummary(score, _durationRatio) {
    if (score > 0.8) {
      return 'Warning: Highly similar to source. Low transformation degree.';
    } else if (score > 0.5) {
      return 'Moderate transformation. Contains significant original material but with new context.';
    }
    return 'High transformation. Output is substantially distinct from the source material.';
  }
}

module.exports = { TransformationQAService };
