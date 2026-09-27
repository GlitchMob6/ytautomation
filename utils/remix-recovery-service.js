const { Logger } = require('./logger');

class RemixRecoveryService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('RemixRecovery');
    this.maxRetries = options.maxRetries || 3;
  }

  /**
   * Records a checkpoint for a specific stage of a remix job.
   */
  async recordCheckpoint(jobId, stage, status, artifact = null, error = null) {
    this.logger.info(`Recording checkpoint for job ${jobId} at stage '${stage}' (Status: ${status})`);
    
    // Check if checkpoint exists
    const existing = await this.db.getRow(
      'SELECT * FROM remix_checkpoints WHERE job_id = ? AND stage = ?',
      [jobId, stage]
    );

    if (existing) {
      await this.db.executeQuery(
        `UPDATE remix_checkpoints SET
          status = ?, artifact = ?, error = ?, updated_at = datetime('now'),
          attempt_count = attempt_count + 1,
          completed_at = ?
        WHERE job_id = ? AND stage = ?`,
        [
          status,
          artifact ? JSON.stringify(artifact) : existing.artifact,
          error ? error.toString() : null,
          status === 'completed' || status === 'failed' ? new Date().toISOString() : null,
          jobId,
          stage
        ]
      );
      return this.db.getRow('SELECT * FROM remix_checkpoints WHERE job_id = ? AND stage = ?', [jobId, stage]);
    } else {
      await this.db.executeQuery(
        `INSERT INTO remix_checkpoints (
          job_id, stage, status, artifact, attempt_count, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
        [
          jobId,
          stage,
          status,
          artifact ? JSON.stringify(artifact) : null,
          1,
          error ? error.toString() : null,
          status === 'completed' || status === 'failed' ? new Date().toISOString() : null
        ]
      );
      return this.db.getRow('SELECT * FROM remix_checkpoints WHERE job_id = ? AND stage = ?', [jobId, stage]);
    }
  }

  /**
   * Evaluates if a failed job can be recovered/resumed.
   */
  async canRecover(jobId) {
    const job = await this.db.getRow('SELECT * FROM remix_jobs WHERE id = ?', [jobId]);
    if (!job) return false;
    if (job.status === 'completed') return false;

    const currentStage = job.stage;
    const checkpoint = await this.db.getRow(
      'SELECT * FROM remix_checkpoints WHERE job_id = ? AND stage = ?',
      [jobId, currentStage]
    );

    if (!checkpoint) return true; // Never attempted, can proceed
    
    return checkpoint.attempt_count < this.maxRetries;
  }

  /**
   * Gets the last successful stage for a job, to determine where to resume.
   */
  async getResumeStage(jobId) {
    const checkpoints = await this.db.getAllRows(
      'SELECT * FROM remix_checkpoints WHERE job_id = ? ORDER BY started_at ASC',
      [jobId]
    );

    if (!checkpoints || checkpoints.length === 0) {
      return 'init';
    }

    // Find the first stage that is not 'completed'
    const stages = ['init', 'analysis', 'transcription', 'planning', 'commentary', 'rendering', 'qa', 'finalize'];
    
    for (const stage of stages) {
      const cp = checkpoints.find(c => c.stage === stage);
      if (!cp || cp.status !== 'completed') {
        return stage;
      }
    }

    return 'completed';
  }
}

module.exports = { RemixRecoveryService };
