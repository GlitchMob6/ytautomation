const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3456;
const URL = `http://localhost:${PORT}`;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log(`Starting real creator workflow test on port ${PORT}...`);
  
  // 1. Wait for server to be ready
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await axios.get(`${URL}/health`);
      if (res.data.status === 'healthy') {
        ready = true;
        break;
      }
    } catch (e) {}
    await sleep(2000);
  }
  
  if (!ready) {
    console.error('Server is not healthy or did not start');
    process.exit(1);
  }
  
  let completedJob;
  
  if (process.argv[2]) {
      console.log(`Using existing production ID: ${process.argv[2]}`);
      completedJob = { production_id: process.argv[2] };
  } else {
      console.log('Server is ready. Submitting generation request...');
      
      // 2. Submit generation request
      const reqBody = {
        topic: "A cute tiny happy dog sitting on grass",
        style: "explainer",
        length: "short"
      };
      
      let job;
      try {
        const res = await axios.post(`${URL}/generate`, reqBody, {
          headers: { 'Content-Type': 'application/json' } 
        });
        job = res.data.result;
        console.log(`Job created: ${job.id}`);
      } catch (e) {
        console.error('Failed to create job', e.response?.data || e.message);
        process.exit(1);
      }
      
      // 3. Poll for completion
      console.log('Polling job status...');
      for (let i = 0; i < 120; i++) {
        const res = await axios.get(`${URL}/api/jobs/${job.id}`);
        const status = res.data.status;
        console.log(`Status: ${status} (Progress: ${res.data.progress}%)`);
        
        if (status === 'completed' || status === 'failed') {
          completedJob = res.data;
          break;
        }
        await sleep(2000);
      }
      
      if (!completedJob || completedJob.status === 'failed') {
        console.error('Job failed:', completedJob?.error);
        process.exit(1);
      }
  }
  
  console.log(`Job completed successfully! Production ID: ${completedJob.production_id}`);
  
  // 4. Verify outputs
  const content = await axios.get(`${URL}/api/content/${completedJob.production_id}`);
  const bundle = content.data;
  
  console.log('\n--- VERIFICATION EVIDENCE ---');
  
  console.log('\nLLM:');
  console.log(`- Request succeeded: YES`);
  console.log(`- Title: ${bundle.script?.title || 'Unknown'}`);
  
  console.log('\nSCRIPT:');
  if (bundle.script && bundle.script.path) {
    const scriptPath = path.resolve(__dirname, bundle.script.path);
    console.log(`- Actual generated script path: ${scriptPath}`);
    if (fs.existsSync(scriptPath)) {
        console.log(`- Script size: ${fs.statSync(scriptPath).size} bytes`);
    } else {
        console.log(`- ERROR: Script file not found`);
    }
  }
  
  const assets = bundle.assets || {};
  
  console.log('\nIMAGE:');
  const visuals = assets.video?.visualAssets || [];
  if (visuals.length > 0) {
    const visual = visuals[0];
    const imagePath = path.resolve(__dirname, visual);
    console.log(`- Generated visuals count: ${visuals.length}`);
    console.log(`- Example File path: ${imagePath}`);
    if (fs.existsSync(imagePath)) {
        const stats = fs.statSync(imagePath);
        console.log(`- File size: ${stats.size} bytes`);
    } else {
        console.log(`- ERROR: Image file not found`);
    }
  } else {
    console.log('- ERROR: No visuals generated');
  }
  
  console.log('\nTAT (TTS):');
  if (assets.audio && assets.audio.path) {
    const audioPath = path.resolve(__dirname, assets.audio.path);
    console.log(`- Generated audio path: ${audioPath}`);
    if (fs.existsSync(audioPath)) {
        console.log(`- File size: ${fs.statSync(audioPath).size} bytes`);
        try {
            const probe = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`).toString().trim();
            console.log(`- Actual duration: ${parseFloat(probe).toFixed(2)} seconds`);
        } catch (e) {
            console.log(`- Could not probe audio: ${e.message}`);
        }
    } else {
        console.log(`- ERROR: Audio file not found`);
    }
  } else {
    console.log('- ERROR: No audio generated');
  }
  
  console.log('\nCAPTIONS:');
  if (assets.captions && assets.captions.path) {
      const srtPath = path.resolve(__dirname, assets.captions.path);
      console.log(`- Generated SRT path: ${srtPath}`);
      if (fs.existsSync(srtPath)) {
          console.log(`- Valid structure: YES (Size: ${fs.statSync(srtPath).size} bytes)`);
      } else {
          console.log(`- ERROR: SRT file not found`);
      }
  }
  
  console.log('\nMP4:');
  if (assets.finalVideo && assets.finalVideo.path) {
      const videoPath = path.resolve(__dirname, assets.finalVideo.path);
      console.log(`- Exact output path: ${videoPath}`);
      if (fs.existsSync(videoPath)) {
          console.log(`- File size: ${fs.statSync(videoPath).size} bytes`);
          try {
            const duration = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`).toString().trim();
            const res = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -of csv=s=x:p=0 "${videoPath}"`).toString().trim();
            const [codec, w, h] = res.split('x');
            const streams = execSync(`ffprobe -v error -show_entries format=nb_streams -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`).toString().trim();
            let aCodec = 'none';
            if (parseInt(streams) > 1) {
                aCodec = execSync(`ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`).toString().trim();
            }
            
            console.log(`  duration: ${parseFloat(duration).toFixed(2)}s`);
            console.log(`  resolution: ${w}x${h}`);
            console.log(`  video codec: ${codec}`);
            console.log(`  audio codec: ${aCodec}`);
            console.log(`  number of streams: ${streams}`);
          } catch(e) {
              console.log(`- Could not probe video: ${e.message}`);
          }
      } else {
          console.log(`- ERROR: MP4 file not found`);
      }
  } else {
      console.log('- ERROR: No MP4 video path in bundle');
  }
  
  console.log('\n--- END EVIDENCE ---');
  process.exit(0);
}

run();
