const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3456;
const URL = `http://localhost:${PORT}`;

const objectives = [
  "Create a short vertical video explaining why electric vehicles are becoming more affordable.",
  "Create a short video explaining what open-source AI models are.",
  "Create a short promotional video for a small local dairy business."
];

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
  console.log(`Starting Multi-Objective Verification on port ${PORT}...`);
  
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await axios.get(`${URL}/health`);
      if (res.data.status === 'healthy') { ready = true; break; }
    } catch (e) {}
    await sleep(2000);
  }
  if (!ready) { console.error('Server not healthy'); process.exit(1); }
  
  for (let i = 0; i < objectives.length; i++) {
    const topic = objectives[i];
    console.log(`\n\n======================================================`);
    console.log(`RUN ${i+1}: ${topic}`);
    console.log(`======================================================`);
    
    const reqBody = { topic: topic, style: "explainer", length: "short" };
    let job;
    try {
      const res = await axios.post(`${URL}/generate`, reqBody, { headers: { 'Content-Type': 'application/json' } });
      job = res.data.result;
      console.log(`Job created: ${job.id}`);
    } catch (e) {
      console.error('Failed to create job', e.response?.data || e.message);
      continue;
    }
    
    console.log('Polling job status...');
    let completedJob;
    for (let j = 0; j < 300; j++) {
      const res = await axios.get(`${URL}/api/jobs/${job.id}`);
      const status = res.data.status;
      process.stdout.write(`\rStatus: ${status} (Progress: ${res.data.progress}%)`);
      if (status === 'completed' || status === 'failed') {
        console.log();
        completedJob = res.data;
        break;
      }
      await sleep(3000);
    }
    
    if (!completedJob || completedJob.status === 'failed') {
      console.error('Job failed:', completedJob?.error);
      continue;
    }
    
    console.log(`Job completed successfully! Production ID: ${completedJob.production_id}`);
    
    const content = await axios.get(`${URL}/api/content/${completedJob.production_id}`);
    const bundle = content.data;
    const assets = bundle.assets || {};
    const scriptObj = bundle.script || {};
    
    console.log('\n--- VERIFICATION REPORT ---');
    
    // 1. LLM
    console.log(`\n[LLM]`);
    console.log(`- Exact Provider: ${assets.script?.provider || bundle.scenes?.[0]?.provider || 'unknown'}`);
    console.log(`- Exact Model Identifier: ${assets.script?.model || bundle.scenes?.[0]?.model || 'unknown'}`);
    
    // 2. IMAGE
    console.log(`\n[IMAGE]`);
    const imgProvider = bundle.scenes?.[0]?.provider || 'unknown';
    const imgModel = bundle.scenes?.[0]?.model || 'unknown';
    console.log(`- Exact Provider: ${imgProvider}`);
    console.log(`- Exact Model/Service: ${imgModel}`);
    
    // 3. TTS
    console.log(`\n[TTS]`);
    console.log(`- Exact Provider: ${assets.audio?.provider || 'unknown'}`);
    console.log(`- Exact Model/Service: ${assets.audio?.model || 'unknown'}`);
    
    // 4. MEDIA
    console.log(`\n[MEDIA]`);
    let audioDuration = 0;
    if (assets.audio && assets.audio.path) {
        try {
            const audioDurationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${assets.audio.path}"`).toString().trim();
            audioDuration = parseFloat(audioDurationStr);
            console.log(`- Audio Duration: ${audioDuration.toFixed(2)}s`);
        } catch(e) { console.log(`- Audio Duration: FAILED`); }
    } else {
        console.log(`- Audio Duration: N/A`);
    }
    
    if (assets.captions && assets.captions.path) {
        const srtResult = verifySrt(assets.captions.path, audioDuration);
        console.log(`- SRT Validity: ${srtResult.valid ? 'VALID' : 'INVALID (' + srtResult.error + ')'}`);
    } else {
        console.log(`- SRT Validity: MISSING`);
    }
    
    if (assets.finalVideo && assets.finalVideo.path) {
        const videoPath = path.resolve(__dirname, assets.finalVideo.path);
        try {
            const vDurationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`).toString().trim();
            console.log(`- MP4 Duration: ${parseFloat(vDurationStr).toFixed(2)}s`);
            
            const resFmt = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=s=x:p=0 "${videoPath}"`).toString().trim();
            console.log(`- Resolution & Codecs: ${resFmt}`);
            
            try {
                execSync(`ffmpeg -v error -i "${videoPath}" -f null -`);
                console.log(`- Decode Test Result: PASSED`);
            } catch (decErr) {
                console.log(`- Decode Test Result: FAILED`);
            }
        } catch(e) {
            console.log(`- FFprobe check failed: ${e.message}`);
        }
    } else {
        console.log(`- Final MP4: MISSING`);
    }
    
    // 5. CONTENT CONTRACT
    console.log(`\n[CONTENT CONTRACT]`);
    if (scriptObj.scenes && scriptObj.scenes.length > 0) {
        let separate = true;
        let visualIsNarration = false;
        let narrationTruncated = false;
        
        scriptObj.scenes.forEach((s, idx) => {
            if (!s.narration || !s.visual_prompt) separate = false;
            if (s.visual_prompt === s.narration) visualIsNarration = true;
            if (s.narration && s.narration.length < 5) narrationTruncated = true; // Very naive check
            
            console.log(`  Scene ${idx+1} Visual Prompt: ${s.visual_prompt?.substring(0, 80)}...`);
        });
        
        console.log(`- Narration and visual_prompt remain separate: ${separate}`);
        console.log(`- Narration is not silently truncated: ${!narrationTruncated}`);
        console.log(`- Visual prompts are not entire narration paragraphs: ${!visualIsNarration}`);
    } else {
        console.log(`- Script structure missing!`);
    }
    
  }
}

run();
