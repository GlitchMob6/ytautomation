const { Logger } = require('../utils/logger');
const { SourceIngestionService } = require('../utils/source-ingestion-service');
const { MediaAnalysisService } = require('../utils/media-analysis-service');
const { TranscriptService } = require('../utils/transcript-service');
const { HighlightSelectionService } = require('../utils/highlight-selection-service');
const { RemixPlannerService } = require('../utils/remix-planner-service');
const { CommentaryService } = require('../utils/commentary-service');
const { LocalTTSService } = require('../utils/local-tts-service');
const { RemixRendererService } = require('../utils/remix-renderer-service');
const { DeepCleanService } = require('../utils/deep-clean-service');
const { TransformationQAService } = require('../utils/transformation-qa-service');
const { RemixRecoveryService } = require('../utils/remix-recovery-service');

class RemixPromotionAgent {
  constructor(db, aiTextService, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('RemixAgent');
    
    // Initialize Pipeline Services
    this.ingestionService = new SourceIngestionService(db, { logger: this.logger });
    this.analysisService = new MediaAnalysisService(db, { logger: this.logger });
    this.transcriptService = new TranscriptService(db, { logger: this.logger });
    
    this.highlightService = new HighlightSelectionService(db, aiTextService, { logger: this.logger });
    this.plannerService = new RemixPlannerService(db, { logger: this.logger });
    this.commentaryService = new CommentaryService(db, aiTextService, { logger: this.logger });
    
    this.ttsService = new LocalTTSService({ logger: this.logger });
    this.rendererService = new RemixRendererService(db, { logger: this.logger });
    
    this.deepCleanService = new DeepCleanService({ logger: this.logger });
    this.qaService = new TransformationQAService(db, { logger: this.logger });
    this.recoveryService = new RemixRecoveryService(db, { logger: this.logger });
  }

  /**
   * Run the end-to-end remix pipeline for a given job ID.
   */
  async runJob(jobId) {
    this.logger.info(`Starting execution for Remix Job: ${jobId}`);
    
    try {
      const canRecover = await this.recoveryService.canRecover(jobId);
      if (!canRecover) {
        throw new Error(`Job ${jobId} cannot be recovered (max retries reached or already completed).`);
      }

      await this.db.updateRemixJob(jobId, { status: 'processing' });
      
      const resumeStage = await this.recoveryService.getResumeStage(jobId);
      this.logger.info(`Resuming job ${jobId} at stage: ${resumeStage}`);

      // We use a cascading switch to fall through stages
      switch (resumeStage) {
        case 'init':
          await this._executeStage(jobId, 'init', async () => {
             // Basic validation
             const job = await this.db.getRow('SELECT * FROM remix_jobs WHERE id = ?', [jobId]);
             if (!job.source_id && !job.plan_id) throw new Error('Job has no source or plan');
             return { initialized: true };
          });
          // falls through
        case 'analysis':
          await this._executeStage(jobId, 'analysis', async (job) => {
             if (!job.source_id) return { skipped: true };
             const source = await this.db.getRemixSource(job.source_id);
             return await this.analysisService.analyzeSource(source.file_path);
          });
          // falls through
        case 'transcription':
          await this._executeStage(jobId, 'transcription', async (job) => {
             if (!job.source_id) return { skipped: true };
             return await this.transcriptService.generateTranscript(job.source_id);
          });
          // falls through
        case 'planning':
          await this._executeStage(jobId, 'planning', async (job) => {
             if (!job.source_id) return { skipped: true };
             
             // Step 1: Extract Highlights
             const transcript = await this.db.getRemixTranscript(job.source_id);
             const highlights = await this.highlightService.selectHighlights(job.source_id, transcript.id);
             
             // Step 2: Build Plan
             const highlightIds = highlights.map(h => h.id);
             const plan = await this.plannerService.createPlan(job.source_id, highlightIds, { commentaryStyle: 'reaction' });
             
             // Link plan to job
             await this.db.updateRemixJob(jobId, { planId: plan.id });
             return plan;
          });
          // falls through
        case 'commentary':
          await this._executeStage(jobId, 'commentary', async (job) => {
             const updatedJob = await this.db.getRow('SELECT * FROM remix_jobs WHERE id = ?', [jobId]);
             const commentary = await this.commentaryService.generateCommentary(updatedJob.plan_id);
             return commentary;
          });
          // falls through
        case 'rendering':
          await this._executeStage(jobId, 'rendering', async (job) => {
             const updatedJob = await this.db.getRow('SELECT * FROM remix_jobs WHERE id = ?', [jobId]);
             const renderResult = await this.rendererService.renderVideo(updatedJob.plan_id);
             await this.db.updateRemixJob(jobId, { outputPath: renderResult.outputPath });
             return renderResult;
          });
          // falls through
        case 'qa':
          await this._executeStage(jobId, 'qa', async () => {
             return await this.qaService.evaluateTransformation(jobId);
          });
          // falls through
        case 'finalize':
          await this._executeStage(jobId, 'finalize', async () => {
             await this.db.updateRemixJob(jobId, { status: 'completed', progress: 100 });
             return { complete: true };
          });
          break;
        case 'completed':
          this.logger.info(`Job ${jobId} is already completed.`);
          break;
        default:
          throw new Error(`Unknown stage: ${resumeStage}`);
      }

      this.logger.info(`Remix Job ${jobId} completed successfully.`);
      
    } catch (error) {
      this.logger.error(`Remix Job ${jobId} failed:`, error);
      await this.db.updateRemixJob(jobId, { status: 'failed', error: error.message });
      throw error;
    }
  }

  async _executeStage(jobId, stage, logicFn) {
    this.logger.info(`Executing stage: ${stage} for job: ${jobId}`);
    
    const job = await this.db.getRow('SELECT * FROM remix_jobs WHERE id = ?', [jobId]);
    await this.db.updateRemixJob(jobId, { stage });
    
    try {
      const result = await logicFn(job);
      await this.recoveryService.recordCheckpoint(jobId, stage, 'completed', result);
      return result;
    } catch (error) {
      await this.recoveryService.recordCheckpoint(jobId, stage, 'failed', null, error);
      throw error; // Rethrow to halt the pipeline
    }
  }
}

module.exports = { RemixPromotionAgent };
