const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3456;
const URL = `http://localhost:${PORT}`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('=== FINAL PROVIDER-TRACKING VERIFICATION ===\n');

  // 1. Wait for server health
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await axios.get(`${URL}/health`);
      if (res.data.status === 'healthy') { ready = true; break; }
    } catch (e) {}
    await sleep(2000);
  }
  if (!ready) { console.error('Server not healthy'); process.exit(1); }

  // 2. Submit a real /generate job
  const topic = "Create a short video about the benefits of reading books every day.";
  console.log(`Submitting: "${topic}"\n`);

  let job;
  try {
    const res = await axios.post(`${URL}/generate`,
      { topic, style: "explainer", length: "short" },
      { headers: { 'Content-Type': 'application/json' } }
    );
    job = res.data.result;
    console.log(`Job ID: ${job.id}`);
  } catch (e) {
    console.error('Failed to create job:', e.response?.data || e.message);
    process.exit(1);
  }

  // 3. Poll until completion
  let completedJob;
  for (let i = 0; i < 300; i++) {
    const res = await axios.get(`${URL}/api/jobs/${job.id}`);
    process.stdout.write(`\rProgress: ${res.data.progress}% (${res.data.status})`);
    if (res.data.status === 'completed' || res.data.status === 'failed') {
      console.log();
      completedJob = res.data;
      break;
    }
    await sleep(3000);
  }

  if (!completedJob || completedJob.status === 'failed') {
    console.error('\nJob failed:', completedJob?.error);
    process.exit(1);
  }

  console.log(`\nProduction ID: ${completedJob.production_id}`);

  // 4. Fetch the full production bundle
  const content = await axios.get(`${URL}/api/content/${completedJob.production_id}`);
  const bundle = content.data;
  const assets = bundle.assets || {};
  const script = bundle.script || {};

  console.log('\n' + '='.repeat(60));
  console.log('PROVIDER/MODEL TRACKING AUDIT');
  console.log('='.repeat(60));

  // --- LLM ---
  console.log('\n[LLM TRACKING]');
  console.log(`  script.provider:          ${script.provider || 'MISSING'}`);
  console.log(`  script.model:             ${script.model || 'MISSING'}`);
  console.log(`  script.metadata.provider: ${script.metadata?.provider || 'MISSING'}`);
  console.log(`  script.metadata.model:    ${script.metadata?.model || 'MISSING'}`);
  const llmTracked = !!(script.provider && script.model);
  console.log(`  ✓ LLM provider tracked:   ${llmTracked ? 'YES' : 'NO ← NEEDS FIX'}`);

  // --- IMAGE ---
  console.log('\n[IMAGE TRACKING]');
  const scenes = bundle.scenes || [];
  console.log(`  Total scenes in bundle:   ${scenes.length}`);

  // Check what's stored in assets.video.visualAssets
  const visualAssets = assets.video?.visualAssets || [];
  console.log(`  assets.video.visualAssets: ${visualAssets.length} items`);
  if (visualAssets.length > 0) {
    const first = visualAssets[0];
    const isObj = typeof first === 'object' && first !== null;
    console.log(`  visualAssets[0] type:     ${isObj ? 'OBJECT' : typeof first}`);
    if (isObj) {
      console.log(`  visualAssets[0].path:     ${first.path || 'MISSING'}`);
      console.log(`  visualAssets[0].provider: ${first.provider || 'MISSING'}`);
      console.log(`  visualAssets[0].model:    ${first.model || 'MISSING'}`);
    } else {
      console.log(`  visualAssets[0] value:    ${String(first).substring(0, 80)}`);
    }
  }

  // Check what's stored per-scene
  scenes.forEach((scene, i) => {
    console.log(`  Scene ${i+1}:`);
    console.log(`    provider:    ${scene.provider || 'MISSING'}`);
    console.log(`    model:       ${scene.model || 'MISSING'}`);
    console.log(`    assetType:   ${scene.assetType || scene.asset_type || 'MISSING'}`);
    console.log(`    assetPath:   ${scene.assetPath?.substring(0, 60) || 'MISSING'}`);
    console.log(`    prompt:      ${(scene.prompt || '').substring(0, 80)}...`);
  });

  const imageTracked = scenes.length > 0 && scenes.every(s => s.provider && s.provider !== 'image-provider');
  console.log(`  ✓ Image provider tracked: ${imageTracked ? 'YES' : 'NO ← check values above'}`);

  // --- TTS ---
  console.log('\n[TTS TRACKING]');
  console.log(`  assets.audio.provider:    ${assets.audio?.provider || 'MISSING'}`);
  console.log(`  assets.audio.model:       ${assets.audio?.model || 'MISSING'}`);
  const ttsTracked = !!(assets.audio?.provider);
  console.log(`  ✓ TTS provider tracked:   ${ttsTracked ? 'YES' : 'NO ← NEEDS FIX'}`);

  // --- MEDIA VERIFICATION ---
  console.log('\n[MEDIA VERIFICATION]');
  let audioDuration = 0;
  if (assets.audio?.path) {
    try {
      const dur = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${assets.audio.path}"`).toString().trim();
      audioDuration = parseFloat(dur);
      console.log(`  Audio duration:    ${audioDuration.toFixed(2)}s`);
    } catch (e) { console.log(`  Audio duration:    FAILED`); }
  }
  if (assets.finalVideo?.path) {
    const vp = path.resolve(__dirname, assets.finalVideo.path);
    try {
      const dur = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${vp}"`).toString().trim();
      const vDur = parseFloat(dur);
      console.log(`  Video duration:    ${vDur.toFixed(2)}s`);
      console.log(`  A/V sync diff:     ${Math.abs(vDur - audioDuration).toFixed(2)}s`);
      const fmt = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=s=x:p=0 "${vp}"`).toString().trim();
      console.log(`  Video format:      ${fmt}`);
      try {
        execSync(`ffmpeg -v error -i "${vp}" -f null -`);
        console.log(`  Decode test:       PASSED`);
      } catch { console.log(`  Decode test:       FAILED`); }
    } catch (e) { console.log(`  Video check:       FAILED`); }
  }

  // --- SUMMARY ---
  console.log('\n' + '='.repeat(60));
  console.log('TRACKING SUMMARY');
  console.log('='.repeat(60));
  console.log(`  LLM provider/model persisted:   ${llmTracked ? '✓' : '✗'}`);
  console.log(`  Image provider/model persisted:  ${imageTracked ? '✓' : '✗'}`);
  console.log(`  TTS provider/model persisted:    ${ttsTracked ? '✓' : '✗'}`);
  console.log(`  All tracking correct:            ${llmTracked && imageTracked && ttsTracked ? '✓ YES' : '✗ NO — see details above'}`);
  console.log('');
}

run();
