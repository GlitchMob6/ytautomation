const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { checkFFmpeg, getFFmpegPath } = require('./ffmpeg');

const execFileAsync = promisify(execFile);

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function commandProbe(command, args = [], options = {}) {
  try {
    const result = await (options.execFile || execFileAsync)(command, args, {
      timeout: options.timeoutMs || 2000,
      maxBuffer: 1024 * 1024
    });
    return { available: true, status: 'ready', command, version: String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null };
  } catch (error) {
    return { available: false, status: 'unavailable', command, error: String(error?.code || error?.message || 'command failed').slice(0, 180) };
  }
}

async function httpProbe(url, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { available: false, status: 'unavailable', url, error: 'fetch unavailable' };
  const timeoutMs = options.timeoutMs || 1500;
  const timeout = timeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: timeout.signal });
    return { available: response.ok, status: response.ok ? 'ready' : 'unavailable', url, httpStatus: response.status };
  } catch (error) {
    return { available: false, status: 'unavailable', url, error: String(error?.name === 'AbortError' ? 'timeout' : error?.message || 'request failed').slice(0, 180) };
  } finally {
    timeout.clear();
  }
}

async function probeHardware(options = {}) {
  const gpu = await commandProbe(options.gpuCommand || 'nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], options);
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || null,
    memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    freeMemoryGb: Number((os.freemem() / 1024 ** 3).toFixed(2)),
    gpu,
    source: 'node:os + nvidia-smi'
  };
}

/**
 * Probe optional local tooling. Every probe fails closed and reports evidence;
 * no tool is installed or started as part of discovery.
 */
async function collectCapabilityReport(options = {}) {
  const hardware = options.hardware || await probeHardware(options);
  const ffmpeg = options.ffmpeg || {
    available: await (options.checkFFmpeg || checkFFmpeg)(),
    status: 'unavailable',
    path: getFFmpegPath(),
    source: 'utils/ffmpeg.checkFFmpeg'
  };
  if (ffmpeg.available) ffmpeg.status = 'ready';

  const ollama = options.ollama || await httpProbe(options.ollamaUrl || 'http://127.0.0.1:11434/api/tags', options);
  const comfyui = options.comfyui || await httpProbe(options.comfyuiUrl || 'http://127.0.0.1:8188/system_stats', options);
  const piper = options.piper || await commandProbe(options.piperCommand || process.env.PIPER_PATH || 'piper', ['--version'], options);
  const whisper = options.whisper || await commandProbe(options.whisperCommand || process.env.WHISPER_PATH || 'whisper', ['--help'], options);
  const tools = {
    ffmpeg: { ...ffmpeg, source: ffmpeg.source || 'ffmpeg' },
    ollama: { ...ollama, source: ollama.source || 'ollama /api/tags' },
    comfyui: { ...comfyui, source: comfyui.source || 'ComfyUI /system_stats' },
    piper: { ...piper, source: piper.source || 'piper --version' },
    whisper: { ...whisper, source: whisper.source || 'whisper --help' }
  };
  const capabilities = {
    textGeneration: Boolean(tools.ollama.available),
    imageGeneration: Boolean(tools.comfyui.available),
    narration: Boolean(tools.piper.available),
    transcription: Boolean(tools.whisper.available),
    videoAssembly: Boolean(tools.ffmpeg.available)
  };
  const availableTools = Object.entries(tools).filter(([, value]) => value.available).map(([key]) => key);
  return {
    timestamp: options.timestamp || new Date().toISOString(),
    hardware,
    tools,
    capabilities,
    availableTools,
    overallReady: Boolean(tools.ffmpeg.available),
    source: 'local capability probes',
    confidence: availableTools.length ? 'medium' : 'low'
  };
}

class CapabilityReporter {
  constructor(options = {}) { this.options = options; }
  collect(options = {}) { return collectCapabilityReport({ ...this.options, ...options }); }
}

module.exports = {
  CapabilityReporter,
  collectCapabilityReport,
  probeHardware,
  commandProbe,
  httpProbe
};
