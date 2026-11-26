import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.resolve(root, '../../work/youtube-check');
await fs.mkdir(work, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`],
});
try {
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html dark><head><style>body{background:#0f0f0f;color:white;padding:24px}#top-level-buttons-computed{display:flex;align-items:center}button{height:36px;background:#272727;color:white;border:0;border-radius:18px;padding:0 14px;font:500 14px Arial}</style></head>
    <body><ytd-watch-metadata><div id="actions"><div id="top-level-buttons-computed"><button>Like</button><button>Share</button></div></div></ytd-watch-metadata></body></html>` }));
  await page.goto('https://www.youtube.com/watch?v=igQVceb5D24&list=radio');
  const button = page.locator('#musical-youtube-download');
  await button.waitFor();
  assert.equal(await button.count(), 1);
  assert.equal(await button.locator('svg path').count(), 3);
  await button.click();
  await page.waitForFunction(() => !document.getElementById('musical-youtube-download').disabled);
  assert.equal(await button.getAttribute('title'), 'Open Musical for this video');
  const draft = await worker.evaluate(async () => (await chrome.storage.local.get('draft')).draft);
  assert.equal(draft.url, 'https://www.youtube.com/watch?v=igQVceb5D24');
  assert.equal((await worker.evaluate(async () => (await chrome.downloads.search({})).length)), 0);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/index.html`);
  await panel.getByLabel('Video link', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Video link', { exact: true }).inputValue(), draft.url);
  await panel.getByRole('button', { name: 'MP3 Audio', exact: true }).click();
  await page.evaluate(() => {
    history.pushState({}, '', '/watch?v=BaW_jenozKc');
    document.querySelector('#top-level-buttons-computed').innerHTML = '<button>Like</button><button>Share</button>';
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await button.waitFor();
  assert.equal(await button.count(), 1);
  await button.click();
  await panel.waitForFunction(() => document.getElementById('video-url').value === 'https://www.youtube.com/watch?v=BaW_jenozKc');
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('draft')).draft)).format, 'mp3');
  await page.evaluate(() => { history.pushState({}, '', '/'); document.dispatchEvent(new Event('yt-navigate-finish')); });
  await button.waitFor({ state: 'detached' });
  console.log('PASS: injected Lucide button, user-gesture panel opening, URL prefill, already-open panel updates, format preservation, navigation, one button per page, no automatic download.');

  if (process.env.LIVE_YOUTUBE === '1') {
    await page.unroute('https://www.youtube.com/**');
    await page.route('**/*', route => ['media', 'image'].includes(route.request().resourceType()) || route.request().url().includes('googlevideo.com') ? route.abort() : route.continue());
    await page.goto('https://www.youtube.com/watch?v=igQVceb5D24', { waitUntil: 'commit', timeout: 20000 });
    try {
      await button.waitFor({ timeout: 30000 });
    } catch (error) {
      console.log(await page.evaluate(() => ({ url: location.href, title: document.title,
        watchElements: [...new Set([...document.querySelectorAll('*')].map(element => element.localName).filter(name => name.includes('watch') || name.includes('metadata')))],
        actionIds: [...document.querySelectorAll('[id]')].map(element => element.id).filter(id => id.includes('action') || id.includes('top-level')),
      })));
      throw error;
    }
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.waitForFunction(() => !document.getElementById('musical-youtube-download').disabled);
    assert.equal(await button.getAttribute('title'), 'Open Musical for this video');
    assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('draft')).draft)).url, 'https://www.youtube.com/watch?v=igQVceb5D24');
    await page.screenshot({ path: path.resolve(root, '../../outputs/youtube-button-preview.png') });
    console.log('PASS: button placement, sidebar opening, and link prefill on live YouTube.');
  }
} finally {
  await context.close();
}
