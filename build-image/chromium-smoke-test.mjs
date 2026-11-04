// Build-time only: confirms Chromium actually launches in this image.
// Not used at job run time: stage 6 starts Chromium through the harness, with
// --no-sandbox added by harness-no-sandbox.cjs.
import PCR from 'puppeteer-chromium-resolver';
import puppeteer from 'puppeteer-core';

const stats = await PCR({});
console.log(`Resolved Chromium: ${stats.executablePath} (revision ${stats.revision})`);

const browser = await puppeteer.launch({
  executablePath: stats.executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-setuid-sandbox',
    '--no-zygote',
    '--single-process',
  ],
});
const page = await browser.newPage();
await page.goto('about:blank');
await browser.close();

console.log('Chromium launched OK');
