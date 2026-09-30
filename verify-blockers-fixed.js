const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

const PORT = process.env.PORT || 3456;
const BASE = `http://localhost:${PORT}`;
const TOPIC = "Create a short video explaining why sleep is essential for brain health.";
const ARTIFACT_DIR = 'C:\\Users\\pushk\\.gemini\\antigravity-ide\\brain\\ce3a1746-309d-411a-a696-139d7695de57';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseSrtTime(t) {
  const [hms, ms] = t.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + parseInt(ms) / 1000;
}

function verifySrt(srtPath, maxDuration) {
  if (!fs.existsSync(srtPath)) return { valid: false, error: 'SRT file missing' };
  const blocks = fs.readFileSync(srtPath, 'utf8').trim().split(/\n\s*\n/);
  let lastEnd = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/);
    if (!m) return { valid: false, error: `Bad timestamp in block ${lines[0]}` };
    const start = parseSrtTime(m[1]), end = parseSrtTime(m[2]);
    if (start > end) return { valid: false, error: `start > end in block ${lines[0]}` };
    if (start < lastEnd - 0.01) return { valid: false, error: `Overlap at block ${lines[0]}` };
    if (end > maxDuration + 1) return { valid: false, error: `Timestamp exceeds duration` };
    lastEnd = end;
  }
  return { valid: true, blockCount: blocks.length };
}

async function run() {
  console.log('=== FULL BLOCKER-FIX VERIFICATION ===\n');
  console.log(`Topic: "${TOPIC}"\n`);

  // Wait for server
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try { if ((await axios.get(`${BASE}/health`)).data.status === 'healthy') { ready = true; break; } } catch {}
    await sleep(2000);
  }
  if (!ready) { console.error('Server not healthy'); process.exit(1); }

  // Submit job
  let job;
  try {
    const res = await axios.post(`${BASE}/generate`, { topic: TOPIC, style: 'explainer', length: 'short' }, { headers: { 'Content-Type': 'application/json' } });
    job = res.data.result;
    console.log('Job ID:', job.id);
  } catch (e) { console.error('Submit failed:', e.response?.data || e.message); process.exit(1); }

  // Poll
  let done;
  for (let i = 0; i < 300; i++) {
    const res = await axios.get(`${BASE}/api/jobs/${job.id}`);
    process.stdout.write(`\rProgress: ${res.data.progress}% (${res.data.status})`);
    if (res.data.status === 'completed' || res.data.status === 'failed') { console.log(); done = res.data; break; }
    await sleep(3000);
  }
  if (!done || done.status === 'failed') { console.error('\nJob failed:', done?.error); process.exit(1); }
  console.log('Production ID:', done.production_id);

  const { data: bundle } = await axios.get(`${BASE}/api/content/${done.production_id}`);
  const assets = bundle.assets || {};
  const script = bundle.script || {};
  const scenes = bundle.scenes || [];

  console.log('\n' + '='.repeat(60));
  console.log('SCENE MANIFEST VERIFICATION');
  console.log('='.repeat(60));
  const scriptSceneCount = (script.scenes || []).length;
  const manifestSceneCount = scenes.length;
  console.log(`  script.scenes[] count:    ${scriptSceneCount}`);
  console.log(`  Persisted scene manifest: ${manifestSceneCount}`);
  console.log(`  Match: ${scriptSceneCount === manifestSceneCount ? '✓ YES' : `✗ NO — expected ${scriptSceneCount}, got ${manifestSceneCount}`}`);

  scenes.forEach((s, i) => {
    console.log(`\n  Scene ${i + 1} (${s.label || s.position}):`);
    console.log(`    narration:     ${(s.narration || s.scriptText || s.script_text || '').substring(0, 60)}...`);
    console.log(`    visual_prompt: ${(s.visual_prompt || s.prompt || '').substring(0, 60)}...`);
    console.log(`    duration:      ${s.duration}s (${s.startTime}s -> ${s.endTime}s)`);
    console.log(`    captions:      ${Array.isArray(s.captionMapping) ? s.captionMapping.length : 0} chunk(s)`);
    console.log(`    assetType:     ${s.assetType || s.asset_type}`);
    console.log(`    assetPath:     ${(s.assetPath || s.asset_path || 'MISSING').substring(0, 60)}`);
    console.log(`    audioPath:     ${(s.audioPath || s.audio_path || 'MISSING').substring(0, 50)}`);
    console.log(`    provider:      ${s.provider || 'MISSING'}`);
  });

  console.log('\n' + '='.repeat(60));
  console.log('IMAGE VERIFICATION');
  console.log('='.repeat(60));
  const visualAssets = assets.video?.visualAssets || [];
  console.log(`  Total visual assets: ${visualAssets.length}`);
  
  let realImages = 0;
  const md5s = new Set();
  for (let i = 0; i < visualAssets.length; i++) {
    const va = visualAssets[i];
    const imgPath = typeof va === 'object' ? va.path : va;
    const provider = typeof va === 'object' ? va.provider : 'unknown';
    process.stdout.write(`  Image ${i + 1} (${provider}): `);
    if (!imgPath || !fs.existsSync(imgPath)) { console.log('MISSING'); continue; }
    try {
      const stat = fs.statSync(imgPath);
      const meta = await sharp(imgPath).metadata();
      const buf = fs.readFileSync(imgPath);
      const md5 = require('crypto').createHash('md5').update(buf).digest('hex');
      md5s.add(md5);
      // Copy first 2 distinct images for visual inspection
      if (md5s.size <= 2) {
        const destName = `final_image_${i + 1}.jpg`;
        const destPath = path.join(ARTIFACT_DIR, destName);
        await sharp(imgPath).jpeg({ quality: 85 }).toFile(destPath);
      }
      console.log(`${stat.size} bytes, ${meta.width}x${meta.height} ${meta.format} — ${stat.size > 10000 ? 'REAL' : 'SUSPECT'}`);
      if (stat.size > 10000) realImages++;
    } catch (e) { console.log('ERROR:', e.message); }
  }
  console.log(`  Distinct images: ${md5s.size} / ${visualAssets.length}`);
  console.log(`  Real-size images: ${realImages} / ${visualAssets.length}`);

  console.log('\n' + '='.repeat(60));
  console.log('MEDIA VERIFICATION');
  console.log('='.repeat(60));
  let audioDuration = 0;
  if (assets.audio?.path && fs.existsSync(assets.audio.path)) {
    audioDuration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${assets.audio.path}"`).toString().trim());
    console.log(`  Audio duration:  ${audioDuration.toFixed(2)}s`);
    console.log(`  TTS provider:    ${assets.audio.provider}`);
  }
  if (assets.captions?.path) {
    const srt = verifySrt(assets.captions.path, audioDuration);
    console.log(`  SRT valid:       ${srt.valid ? `YES (${srt.blockCount} blocks)` : 'NO — ' + srt.error}`);
  }
  if (assets.finalVideo?.path && fs.existsSync(path.resolve(__dirname, assets.finalVideo.path))) {
    const vp = path.resolve(__dirname, assets.finalVideo.path);
    const vDur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${vp}"`).toString().trim());
    const fmt = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=s=x:p=0 "${vp}"`).toString().trim();
    let decodeOk = false;
    try { execSync(`ffmpeg -v error -i "${vp}" -f null -`); decodeOk = true; } catch {}
    console.log(`  MP4 duration:    ${vDur.toFixed(2)}s`);
    console.log(`  A/V sync diff:   ${Math.abs(vDur - audioDuration).toFixed(2)}s`);
    console.log(`  Format:          ${fmt}`);
    console.log(`  Decode test:     ${decodeOk ? 'PASSED' : 'FAILED'}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Scene manifest match:    ${scriptSceneCount === manifestSceneCount ? '✓' : '✗'} (${scriptSceneCount} script → ${manifestSceneCount} persisted)`);
  console.log(`  Real images generated:   ${realImages > 0 && md5s.size > 1 ? '✓' : '✗'} (${realImages} real, ${md5s.size} distinct)`);
  console.log(`  TTS:                     ${audioDuration > 0 ? '✓' : '✗'}`);
  console.log(`  MP4 produced:            ${assets.finalVideo?.path ? '✓' : '✗'}`);
  console.log('');
}
run();
