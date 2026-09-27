const { Database } = require('./database/db');
const { SystemTest } = require('./test');
(async () => {
  const t = new SystemTest();
  try {
    await t.testRemixCommentaryService();
    console.log("SUCCESS");
  } catch(e) {
    console.error(e.stack);
  }
})();
