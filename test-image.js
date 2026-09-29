const path = require('path');
const { FluxLocalImageProvider, FreeImageProvider } = require('./utils/providers/image-provider');

async function test() {
  console.log("Testing FluxLocalImageProvider...");
  const flux = new FluxLocalImageProvider();
  const fluxAvail = await flux.checkAvailability();
  console.log("Flux Available:", fluxAvail);

  console.log("Testing FreeImageProvider...");
  const free = new FreeImageProvider();
  const freeAvail = await free.checkAvailability();
  console.log("Free Available:", freeAvail);

  if (freeAvail) {
    try {
        console.log("Generating with FreeImageProvider...");
        const result = await free.generate({
            prompt: "A modern electric car charging at a futuristic charging station at sunset",
            outputPath: path.join(__dirname, 'test-image.jpg')
        });
        console.log("Success! Output:", result);
    } catch (e) {
        console.error("FreeImageProvider failed:", e.message);
    }
  }
}
test();
