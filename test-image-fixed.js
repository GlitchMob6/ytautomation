const path = require('path');
const { FreeImageProvider } = require('./utils/providers/image-provider');
const sharp = require('sharp');
const fs = require('fs');

async function test() {
  const provider = new FreeImageProvider();
  
  console.log('Checking availability...');
  const avail = await provider.checkAvailability();
  console.log('Available:', avail);
  
  if (!avail) {
    console.error('Provider not available — cannot continue test.');
    process.exit(1);
  }

  const prompt = 'A modern electric car charging at a futuristic charging station at sunset';
  const outPath = path.join(__dirname, 'test-image-fixed.jpg');

  console.log(`\nGenerating image for prompt:\n"${prompt}"\n`);
  
  try {
    const result = await provider.generate({ prompt, outputPath: outPath });
    
    const stat = fs.statSync(outPath);
    const meta = await sharp(outPath).metadata();
    
    console.log('SUCCESS:');
    console.log('  Provider:', result.provider);
    console.log('  Path:', result.path);
    console.log('  File size:', stat.size, 'bytes');
    console.log('  Dimensions:', meta.width + 'x' + meta.height);
    console.log('  Format:', meta.format);
    console.log('  Channels:', meta.channels);
    
    if (stat.size < 10000) {
      console.warn('  WARNING: File size is very small — possible empty/error image');
    } else {
      console.log('  File size check: PASS');
    }
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
}

test();
