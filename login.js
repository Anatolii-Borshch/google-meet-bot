// One-time sign-in: opens Chrome with the bot profile, you log in by hand,
// then press Enter here. Also exports cookies to auth.json for use on another machine (Linux).
const { launchBrowser } = require('./meet-recorder');

(async () => {
  const profileDir = process.argv[2] || './chrome-profile';
  const context = await launchBrowser({ profileDir });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://accounts.google.com/');
  console.log('Sign in to the bot Google account in the browser, then press Enter here.');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await context.storageState({ path: 'auth.json' });
  await context.close();
  console.log(`Profile saved to ${profileDir}, cookies exported to auth.json`);
  process.exit(0);
})();
