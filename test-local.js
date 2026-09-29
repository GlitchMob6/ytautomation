require('dotenv').config();
const { ContentGeneratorAgent } = require('./index');

async function run() {
  const agent = new ContentGeneratorAgent();
  await agent.initialize();
  
  // Create an idea
  const idea = await agent.db.createContentIdea({
    topic: "The future of AI and open source models",
    style: "Explainer",
    targetAudience: "Tech enthusiasts"
  });
  
  console.log("Triggering generation for:", idea.topic);
  try {
    const job = await agent.startGenerationJob({
      topic: idea.topic,
      style: "Explainer",
      length: "short",
      source: "idea"
    });
    console.log("Job started:", job.id);
    
    // Wait for it
    const finishedJob = await agent.waitForGenerationJob(job.id);
    console.log("Job finished with status:", finishedJob.status);
    console.log(JSON.stringify(finishedJob, null, 2));
    
  } catch (error) {
    console.error("Failed to run job:", error);
  }
  process.exit(0);
}

run();
