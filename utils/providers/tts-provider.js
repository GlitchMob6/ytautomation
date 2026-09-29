const fs = require('fs').promises;
const path = require('path');
const { BaseProvider } = require('./base-provider');
const { runFFmpeg } = require('../ffmpeg');

class GeminiTTSProvider extends BaseProvider {
  constructor(apiKey, model) {
    super('gemini-tts', 'Google Gemini TTS', 'tts');
    this.apiKey = apiKey;
    this.model = model || 'gemini-3.1-flash-tts-preview';
    this.client = null;
  }

  async checkAvailability() {
    if (!this.apiKey) return false;
    try {
      if (!this.client) {
        const { GoogleGenAI } = require('@google/genai');
        this.client = new GoogleGenAI({ apiKey: this.apiKey });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async generate(options) {
    const { text, outputPath, voiceName = 'Kore' } = options;
    
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    return { path: outputPath, provider: this.id };
  }
}

// Local TTS Providers for Phase 4
const axios = require('axios');

class QwenLocalTTSProvider extends BaseProvider {
  constructor() {
    super('qwen-tts-local', 'Qwen3-TTS 0.6B Local', 'tts');
  }

  async checkAvailability() { return false; }
  async generate(options) { throw new Error('Not implemented yet'); }
}

class KokoroLocalTTSProvider extends BaseProvider {
  constructor(baseURL = 'http://127.0.0.1:8880') {
    super('kokoro-local', 'Kokoro-82M Local', 'tts');
    this.baseURL = baseURL; // Standard port for FastAPI Kokoro
  }

  async checkAvailability() {
    try {
      const res = await axios.get(`${this.baseURL}/health`, { timeout: 2000 });
      return res.status === 200;
    } catch (e) {
      return false;
    }
  }

  async generate(options) {
    const { text, outputPath, voiceName = 'af_bella' } = options;
    
    // Using standard OpenAI-compatible audio endpoint that Kokoro FastAPI wrappers implement
    const response = await axios({
      method: 'POST',
      url: `${this.baseURL}/v1/audio/speech`,
      data: {
        input: text,
        voice: voiceName,
        response_format: 'wav'
      },
      responseType: 'arraybuffer'
    });

    const wavPath = outputPath + '.wav';
    await fs.writeFile(wavPath, Buffer.from(response.data));
    
    // Encode to the requested container via FFmpeg
    await runFFmpeg(['-y', '-i', wavPath, outputPath]);
    await fs.unlink(wavPath).catch(() => {});

    return { path: outputPath, provider: this.id };
  }
}

class OpenAITTSProvider extends BaseProvider {
  constructor(apiKey) {
    super('openai-tts', 'OpenAI TTS', 'tts');
    this.apiKey = apiKey;
    this.model = 'gpt-4o-mini-tts'; // or tts-1
    this.client = new (require('openai'))({ apiKey });
  }

  async checkAvailability() { return !!this.apiKey; }

  async generate(options) {
    const { text, outputPath } = options;
    const response = await this.client.audio.speech.create({
      model: this.model,
      voice: "coral",
      input: text,
      speed: 1.0
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);
    return { path: outputPath, provider: this.id };
  }
}

class ElevenLabsTTSProvider extends BaseProvider {
  constructor(apiKey, voiceId, model = 'eleven_v3') {
    super('elevenlabs-tts', 'ElevenLabs TTS', 'tts');
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.model = model;
  }

  async checkAvailability() { return !!(this.apiKey && this.voiceId); }

  async generate(options) {
    const { text, outputPath } = options;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;
    const data = {
      text: text,
      model_id: this.model,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
    };

    const response = await axios({
      method: 'POST', url: url, data: data,
      headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': this.apiKey },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    return { path: outputPath, provider: this.id };
  }
}

module.exports = { GeminiTTSProvider, QwenLocalTTSProvider, KokoroLocalTTSProvider, OpenAITTSProvider, ElevenLabsTTSProvider };
