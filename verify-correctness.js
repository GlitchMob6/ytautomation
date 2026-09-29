const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3456;
const URL = `http://localhost:${PORT}`;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSrtTime(timeStr) {
    const [hours, minutes, seconds] = timeStr.split(':');
    const [sec, ms] = seconds.split(',');
    return (parseInt(hours) * 3600) + (parseInt(minutes) * 60) + parseInt(sec) + (parseInt(ms) / 1000);
}

function verifySrt(srtPath, maxDuration) {
    if (!fs.existsSync(srtPath)) return { valid: false, error: "File does not exist" };
    
    const content = fs.readFileSync(srtPath, 'utf8');
    const blocks = content.trim().split(/\n\s*\n/);
    
    let lastEndTime = 0;
    
    for (const block of blocks) {
        const lines = block.split('\n');
        if (lines.length < 3) continue; // Skip malformed blocks
        
        const timeLine = lines[1];
        const match = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/);
        if (!match) return { valid: false, error: `Invalid time format in block: ${lines[0]}` };
        
        const startTime = parseSrtTime(match[1]);
        const endTime = parseSrtTime(match[2]);
        
        if (startTime > endTime) return { valid: false, error: `Start time > end time in block ${lines[0]}` };
        if (startTime < lastEndTime) {
            // Allow a tiny margin of error (e.g. 0.001s) but generally should be strictly >=
            if ((lastEndTime - startTime) > 0.01) {
                 return { valid: false, error: `Overlapping timestamps in block ${lines[0]}: starts at ${startTime}, previous ended at ${lastEndTime}` };
            }
        }
        if (endTime > maxDuration + 1) return { valid: false, error: `Timestamp exceeds media duration (${endTime} > ${maxDuration})` };
        
        lastEndTime = endTime;
    }
    
    return { valid: true, blockCount: blocks.length };
}

async function run() {
  console.log(`Starting Creator-Correctness Verification on port ${PORT}...`);
  
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await axios.get(`${URL}/health`);
      if (res.data.status === 'healthy') { ready = true; break; }
    } catch (e) {}
    await sleep(2000);
  }
  if (!ready) { console.error('Server not healthy'); process.exit(1); }
  
  const reqBody = {
    topic: "Create a short vertical video explaining why electric vehicles are becoming more affordable.",
    style: "explainer",
    length: "short"
  };
  
  let job;
  try {
    const res = await axios.post(`${URL}/generate`, reqBody, { headers: { 'Content-Type': 'application/json' } });
    job = res.data.result;
    console.log(`Job created: ${job.id}`);
  } catch (e) {
    console.error('Failed to create job', e.response?.data || e.message);
    process.exit(1);
  }
  
  console.log('Polling job status...');
  let completedJob;
  for (let i = 0; i < 300; i++) {
    const res = await axios.get(`${URL}/api/jobs/${job.id}`);
    const status = res.data.status;
    console.log(`Status: ${status} (Progress: ${res.data.progress}%)`);
    if (status === 'completed' || status === 'failed') {
      completedJob = res.data;
      break;
    }
    await sleep(3000);
  }
  
  if (!completedJob || completedJob.status === 'failed') {
    console.error('Job failed:', completedJob?.error);
    process.exit(1);
  }
  
  console.log(`Job completed successfully! Production ID: ${completedJob.production_id}`);
  
  const content = await axios.get(`${URL}/api/content/${completedJob.production_id}`);
  const bundle = content.data;
  const assets = bundle.assets || {};
  
  console.log('\n--- CORRECTNESS VERIFICATION REPORT ---');
  
  // 1. LLM Provider & Script verification
  console.log('\n1. LLM / SCRIPT VERIFICATION');
  console.log(`- Request Succeeded: YES`);
  console.log(`- Exact Provider/Model stored in bundle: ${bundle.script?.provider || 'unknown'} / ${bundle.script?.model || 'unknown'}`);
  const scriptContentPath = assets.script?.originalPath || assets.script?.path;
  if (scriptContentPath && fs.existsSync(scriptContentPath)) {
      const s = fs.readFileSync(scriptContentPath, 'utf8');
      console.log(`- Actual generated script size: ${s.length} chars`);
      const isTemplate = s.includes("TEMPLATE:") || s.length < 50;
      console.log(`- Script seems to be actual LLM response (not template): ${!isTemplate}`);
  } else {
      console.log(`- Script file not found`);
  }
  
  // 2. Image Provider verification
  console.log('\n2. IMAGE VERIFICATION');
  console.log(`- Number of visuals generated: ${assets.video?.visualAssets?.length || 0}`);
  // We can't automatically verify image semantics, but we will print prompts and paths
  if (bundle.scenes && bundle.scenes.length > 0) {
      console.log(`- Image Provider stored in bundle: ${bundle.scenes[0].provider || 'unknown'}`);
      console.log(`- Image Model stored in bundle: ${bundle.scenes[0].model || 'unknown'}`);
      bundle.scenes.forEach((scene, i) => {
          if (scene.asset_type === 'image') {
              console.log(`  Scene ${i+1} Image Path: ${scene.assetPath}`);
              console.log(`  Scene ${i+1} Prompt Used: ${scene.prompt.substring(0,100)}...`);
          }
      });
  }
  
  // 3. TTS Provider verification
  console.log('\n3. TTS VERIFICATION');
  if (assets.audio && assets.audio.path) {
      console.log(`- TTS Provider stored in bundle: ${assets.audio.provider || 'unknown'}`);
      console.log(`- TTS Model stored in bundle: ${assets.audio.model || 'unknown'}`);
      const audioDurationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${assets.audio.path}"`).toString().trim();
      const audioDuration = parseFloat(audioDurationStr);
      console.log(`- Narrated Audio Duration: ${audioDuration.toFixed(2)}s`);
      
      // 6. SRT Verification
      console.log('\n6. SRT (CAPTIONS) VERIFICATION');
      if (assets.captions && assets.captions.path) {
          const srtResult = verifySrt(assets.captions.path, audioDuration);
          if (srtResult.valid) {
              console.log(`- SRT is valid! Blocks: ${srtResult.blockCount}`);
              console.log(`- Timestamps sequential: YES`);
              console.log(`- No overlaps: YES`);
              console.log(`- Within duration limits: YES`);
          } else {
              console.log(`- SRT INVALID: ${srtResult.error}`);
          }
      } else {
          console.log(`- No captions found`);
      }
      
      // 7 & 8 & 9. MP4 Verification
      console.log('\n7-9. FINAL MP4 VERIFICATION');
      if (assets.finalVideo && assets.finalVideo.path) {
          const videoPath = path.resolve(__dirname, assets.finalVideo.path);
          console.log(`- Video Path: ${videoPath}`);
          try {
              const vDurationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`).toString().trim();
              const vDuration = parseFloat(vDurationStr);
              console.log(`- Final MP4 Duration: ${vDuration.toFixed(2)}s`);
              
              const durationDiff = Math.abs(vDuration - audioDuration);
              if (durationDiff < 2.0) {
                  console.log(`- Video duration sensible relative to narration: YES (Diff: ${durationDiff.toFixed(2)}s)`);
              } else {
                  console.log(`- Video duration SENSIBLE: NO (Differs by ${durationDiff.toFixed(2)}s from audio)`);
              }
              
              const res = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=s=x:p=0 "${videoPath}"`).toString().trim();
              console.log(`- Video format: ${res}`);
              
              // 9. Frame-by-frame decode test
              console.log(`- Testing frame-by-frame decode (ffmpeg -f null)...`);
              try {
                  execSync(`ffmpeg -v error -i "${videoPath}" -f null -`);
                  console.log(`- Decoding test: PASSED (No errors)`);
              } catch (decErr) {
                  console.log(`- Decoding test: FAILED`);
              }
              
          } catch(e) {
              console.log(`- FFprobe check failed: ${e.message}`);
          }
      }
      
  } else {
      console.log(`- No audio generated`);
  }
  
  console.log('\n--- END REPORT ---');
  process.exit(0);
}

run();
