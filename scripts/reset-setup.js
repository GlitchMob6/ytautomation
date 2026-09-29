const fs = require('fs').promises;
const path = require('path');
const { Database } = require('../database/db');
const chalk = require('chalk');

async function resetSetup() {
  console.log(chalk.cyan('Resetting first-run setup state...'));
  try {
    const db = new Database();
    await db.initialize();
    
    // Clear setup_completed setting
    await db.executeQuery('DELETE FROM settings WHERE key = ?', ['setup_completed']);
    
    // Clear channel_profiles
    await db.executeQuery("DELETE FROM channel_profiles WHERE id = 'default'");
    
    console.log(chalk.green('✓ Cleared setup state in database.'));

    // Clear credentials.json
    const credsPath = path.join(__dirname, '..', 'config', 'credentials.json');
    try {
      await fs.unlink(credsPath);
      console.log(chalk.green('✓ Deleted config/credentials.json.'));
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log(chalk.gray('- config/credentials.json already deleted.'));
      } else {
        throw e;
      }
    }

    console.log(chalk.green.bold('\nFactory reset complete!'));
    console.log('Run ' + chalk.cyan('npm run start') + ' to experience the first-run walkthrough again.');
  } catch (error) {
    console.error(chalk.red('Failed to reset setup state:'), error);
  }
}

if (require.main === module) {
  resetSetup().then(() => process.exit(0));
}
