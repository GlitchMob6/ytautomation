const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { BaseProvider } = require('./base-provider');

class GeminiImageProvider extends BaseProvider {
  constructor(apiKey, model) {
    super('gemini-image', 'Google Gemini Image', 'image');
    this.apiKey = apiKey;
    this.model = model || 'gemini-3.1-flash-image';
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
    const { prompt, outputPath, aspectRatio = '16:9' } = options;
    
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio, imageSize: '1K' }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(outputPath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(outputPath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(outputPath);
    } else {
      await output.png().toFile(outputPath);
    }
    
    return { path: outputPath, provider: this.id };
  }
}

// Local Image Provider for Phase 4
const axios = require('axios');

class FluxLocalImageProvider extends BaseProvider {
  constructor(baseURL = 'http://127.0.0.1:8188') {
    super('flux-local', 'FLUX.1-schnell Local (ComfyUI API)', 'image');
    this.baseURL = baseURL; // Standard ComfyUI Port
  }

  async checkAvailability() {
    try {
      const res = await axios.get(`${this.baseURL}/system_stats`, { timeout: 2000 });
      return res.status === 200;
    } catch (e) {
      return false;
    }
  }

  async generate(options) {
    const { prompt, outputPath } = options;
    
    // Very simplified ComfyUI prompt workflow payload for FLUX
    // A real implementation would load a saved workflow JSON and inject the prompt
    const workflow = {
      "3": {
        "class_type": "KSampler",
        "inputs": {
          "seed": Math.floor(Math.random() * 1000000),
          "steps": 4, // Schnell is 4 steps
          "cfg": 1.0,
          "sampler_name": "euler",
          "scheduler": "normal",
          "denoise": 1,
          "model": ["4", 0],
          "positive": ["6", 0],
          "negative": ["7", 0],
          "latent_image": ["5", 0]
        }
      },
      "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "flux1-schnell.safetensors" } },
      "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
      "6": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["4", 1] } },
      "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
      "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
      "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "lumen_flux", "images": ["8", 0] } }
    };

    const response = await axios.post(`${this.baseURL}/prompt`, { prompt: workflow });
    const promptId = response.data.prompt_id;

    // Polling ComfyUI history for completion
    let completed = false;
    let imageFilename = null;
    
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const historyRes = await axios.get(`${this.baseURL}/history/${promptId}`);
      if (historyRes.data[promptId]) {
        const outputs = historyRes.data[promptId].outputs;
        // Find the SaveImage node output
        for (const nodeId in outputs) {
          if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
            imageFilename = outputs[nodeId].images[0].filename;
            completed = true;
            break;
          }
        }
        if (completed) break;
      }
    }

    if (!imageFilename) throw new Error('FLUX generation timed out');

    // Download the image
    const imageRes = await axios.get(`${this.baseURL}/view?filename=${imageFilename}`, { responseType: 'arraybuffer' });
    
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    
    // Process with sharp
    const extension = path.extname(outputPath).toLowerCase();
    const output = sharp(Buffer.from(imageRes.data), { failOn: 'error' });
    
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(outputPath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(outputPath);
    } else {
      await output.png().toFile(outputPath);
    }

    return { path: outputPath, provider: this.id };
  }
}

class OpenAIImageProvider extends BaseProvider {
  constructor(apiKey) {
    super('openai-image', 'OpenAI Image (DALL-E)', 'image');
    this.apiKey = apiKey;
    this.client = new (require('openai'))({ apiKey });
  }

  async checkAvailability() { return !!this.apiKey; }

  async generate(options) {
    const { prompt, outputPath } = options;
    const response = await this.client.images.generate({
      model: "dall-e-3", // default to modern dall-e-3
      prompt: prompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(outputPath, buffer);
    } else {
      const imgRes = await axios.get(response.data[0].url, { responseType: 'arraybuffer' });
      await fs.writeFile(outputPath, Buffer.from(imgRes.data));
    }

    return { path: outputPath, provider: this.id };
  }
}

class FreeImageProvider extends BaseProvider {
  constructor() {
    super('free-image', 'Pollinations.ai Free Image', 'image');
  }

  async checkAvailability() {
    // Do a lightweight HEAD check to confirm the API is reachable
    try {
      const res = await axios.head('https://image.pollinations.ai', { timeout: 5000 });
      return res.status < 500;
    } catch (e) {
      return false;
    }
  }

  async generate(options) {
    const { prompt, outputPath } = options;
    // Direct image API endpoint - returns raw image bytes, not a web page
    // Note: Pollinations free tier limits free direct queries to <= 1280x720 (1080p direct returns 402 Payment Required).
    // We request 1280x720 and upscale to full 1920x1080 via sharp.
    const seed = Math.floor(Math.random() * 1000000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=720&nologo=true&seed=${seed}`;
    
    let buffer;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: { 'Accept': 'image/jpeg,image/png,image/webp,image/*' }
        });

        // Validate the response is actually an image, not an HTML page
        const contentType = response.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Pollinations.ai returned non-image content-type: "${contentType}". The API may have returned an HTML error page.`);
        }

        buffer = Buffer.from(response.data);

        // Validate the image bytes are parseable and have real dimensions
        const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
        if (!metadata.width || !metadata.height || metadata.width < 100 || metadata.height < 100) {
          throw new Error(`Image validation failed: got ${metadata.width}x${metadata.height} — too small or invalid.`);
        }

        break; // success
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
    if (!buffer) throw new Error(`Pollinations.ai image generation failed after 3 attempts: ${lastError?.message}`);
    
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    
    const extension = path.extname(outputPath).toLowerCase();
    const output = sharp(buffer, { failOn: 'error' }).resize(1920, 1080, { fit: 'cover' });
    
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(outputPath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(outputPath);
    } else {
      await output.png().toFile(outputPath);
    }
    
    return { path: outputPath, provider: this.id };
  }
}

module.exports = { GeminiImageProvider, FluxLocalImageProvider, OpenAIImageProvider, FreeImageProvider };
