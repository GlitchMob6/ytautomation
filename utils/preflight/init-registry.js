const { registerRequirement } = require('./registry');
const { SEVERITY, CATEGORIES, CAPABILITIES } = require('./status');

function initializeRegistry() {
  registerRequirement({
    id: 'env:nodejs',
    name: 'Node.js',
    category: CATEGORIES.ENVIRONMENT,
    description: 'JavaScript runtime built on Chrome\'s V8 JavaScript engine.',
    whyRequired: 'Required to run the application server and agents.',
    severity: SEVERITY.HARD_BLOCKER,
    bypassAllowed: false,
    affects: Object.values(CAPABILITIES) // Affects everything
  });

  registerRequirement({
    id: 'hw:ram',
    name: 'System RAM',
    category: CATEGORIES.HARDWARE,
    description: 'System memory available.',
    whyRequired: 'Sufficient memory is required to run local AI models efficiently.',
    severity: SEVERITY.SOFT_REQUIREMENT,
    bypassAllowed: true,
    affects: [CAPABILITIES.TEXT_GENERATION, CAPABILITIES.NARRATION, CAPABILITIES.IMAGE_GENERATION]
  });

  registerRequirement({
    id: 'hw:gpu',
    name: 'NVIDIA GPU',
    category: CATEGORIES.HARDWARE,
    description: 'Dedicated graphics processing unit.',
    whyRequired: 'Required for fast local AI model inference (CUDA).',
    severity: SEVERITY.OPTIONAL,
    bypassAllowed: true,
    affects: [CAPABILITIES.TEXT_GENERATION, CAPABILITIES.NARRATION, CAPABILITIES.IMAGE_GENERATION]
  });

  registerRequirement({
    id: 'dep:ffmpeg',
    name: 'FFmpeg',
    category: CATEGORIES.DEPENDENCY,
    description: 'Cross-platform solution to record, convert and stream audio and video.',
    whyRequired: 'Required to assemble images and audio into a final video file.',
    severity: SEVERITY.HARD_BLOCKER,
    bypassAllowed: false,
    affects: [CAPABILITIES.VIDEO_ASSEMBLY]
  });

  registerRequirement({
    id: 'dep:playwright',
    name: 'Playwright Chromium',
    category: CATEGORIES.DEPENDENCY,
    description: 'Headless browser automation.',
    whyRequired: 'Used by the slideshow renderer to generate HTML slides into video frames.',
    severity: SEVERITY.SOFT_REQUIREMENT,
    bypassAllowed: true,
    affects: [CAPABILITIES.VIDEO_ASSEMBLY]
  });
  registerRequirement({
    id: 'model:qwen',
    name: 'Qwen 2.5 Local LLM',
    category: CATEGORIES.DEPENDENCY,
    description: 'Local language model for text generation.',
    whyRequired: 'Required for writing scripts and planning content locally.',
    severity: SEVERITY.SOFT_REQUIREMENT,
    bypassAllowed: true,
    affects: [CAPABILITIES.TEXT_GENERATION]
  });

  registerRequirement({
    id: 'model:kokoro',
    name: 'Kokoro-82M TTS',
    category: CATEGORIES.DEPENDENCY,
    description: 'Local text-to-speech engine.',
    whyRequired: 'Required for offline, natural voice narration.',
    severity: SEVERITY.SOFT_REQUIREMENT,
    bypassAllowed: true,
    affects: [CAPABILITIES.NARRATION]
  });

  registerRequirement({
    id: 'model:flux',
    name: 'FLUX.1-schnell',
    category: CATEGORIES.DEPENDENCY,
    description: 'Local image generation model.',
    whyRequired: 'Required to create visual assets and thumbnails offline.',
    severity: SEVERITY.SOFT_REQUIREMENT,
    bypassAllowed: true,
    affects: [CAPABILITIES.IMAGE_GENERATION]
  });
}

module.exports = { initializeRegistry };
