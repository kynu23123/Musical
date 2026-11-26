import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.resolve(root, '../../work/extension-check');
await fs.mkdir(work, { recursive: true });
const fixture = path.join(work, 'musical-test.mp4');
const ffmpeg = path.join(process.env.LOCALAPPDATA, 'MusicalDownloader/ffmpeg.exe');
execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', fixture]);
const bytes = await fs.readFile(fixture);
const server = http.createServer((request, response) => {
  console.log('Fixture request', request.method, request.url);
  response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
  response.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/musical-test.mp4`;
const context = await chromium.launchPersistentContext(path.join(work, `profile-${Date.now()}`), {
  channel: 'chromium', headless: true, viewport: { width: 380, height: 950 },
  args: [`--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`],
});
const files = [];
try {
  context.setDefaultTimeout(20000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const panelUrl = `chrome-extension://${id}/index.html`;
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(panelUrl);
  await page.getByRole('button', { name: 'Download MP4', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.download-button').disabled);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.app-header, .stats-card, .file-icon, .lucide-check, .lucide-link, .format-option svg, [data-slot=card-footer]').count(), 0);
  await page.screenshot({ path: path.resolve(root, '../musical-preview.png'), fullPage: true });
  await page.setViewportSize({ width: 280, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 380, height: 950 });
  await page.getByRole('button', { name: 'Download MP4', exact: true }).click();
  await page.getByText('Paste a valid video link.', { exact: true }).waitFor();
  await page.getByLabel('Video link', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Download MP4', exact: true }).click();
  assert.equal(await page.locator('.lucide-download').count(), 0);
  await page.getByRole('button', { name: 'Cancel download', exact: true }).click();
  try {
    await page.getByText('Cancelled', { exact: true }).waitFor({ timeout: 20000 });
  } catch (error) {
    console.log(await worker.evaluate(async () => (await chrome.storage.local.get('state')).state));
    await page.screenshot({ path: path.join(work, 'cancel-failure.png'), fullPage: true });
    throw error;
  }
  console.log('Cancellation passed');
  let snapshot = await worker.evaluate(async () => (await chrome.storage.local.get('state')).state);
  assert.equal(snapshot.total, 0);
  for (const format of ['mp3', 'mp4']) {
    await page.getByRole('button', { name: format.toUpperCase() + (format === 'mp3' ? ' Audio' : ' Video'), exact: true }).click();
    await page.getByRole('button', { name: `Download ${format.toUpperCase()}`, exact: true }).click();
    await page.getByRole('button', { name: 'Confirm download?', exact: true }).waitFor({ timeout: 60000 });
    const prepared = await worker.evaluate(async () => (await chrome.storage.local.get('state')).state);
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.path, '');
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), files.length);
    assert.equal(await page.locator('.confirmation').count(), 0);
    await page.reload();
    await page.getByRole('button', { name: 'Confirm download?', exact: true }).click();
    try {
      await page.getByText('Saved', { exact: true }).waitFor({ timeout: 60000 });
    } catch (error) {
      console.log(await worker.evaluate(async () => (await chrome.storage.local.get('state')).state));
      await page.screenshot({ path: path.join(work, 'failure.png'), fullPage: true });
      throw error;
    }
    snapshot = await worker.evaluate(async () => (await chrome.storage.local.get('state')).state);
    if (!snapshot.path) console.log('Missing path', snapshot, await worker.evaluate(async () => chrome.downloads.search({})));
    assert.equal(path.extname(snapshot.path), `.${format}`);
    const browserItem = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], snapshot.downloadId);
    assert.equal(browserItem.state, 'complete');
    assert.equal(browserItem.byExtensionId, id);
    assert.equal(browserItem.filename, snapshot.path);
    await page.getByRole('button', { name: `Download ${format.toUpperCase()}`, exact: true }).waitFor();
    assert.equal(path.basename(path.dirname(snapshot.path)).toLowerCase(), 'downloads');
    assert.ok((await fs.stat(snapshot.path)).size > 1000);
    files.push(snapshot.path);
    execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', snapshot.path, '-f', 'null', '-']);
  }
  assert.equal(snapshot.total, 2);
  for (const format of ['mp3', 'mp4']) {
    const previousCount = files.length;
    await page.getByRole('button', { name: `Redownload musical-test as ${format.toUpperCase()}`, exact: true }).first().click();
    await page.waitForFunction(total => {
      return document.querySelectorAll('.history-section li').length === total
        && document.querySelector('.download-status')?.textContent === 'Saved';
    }, previousCount + 1, { timeout: 60000 });
    snapshot = await worker.evaluate(async () => (await chrome.storage.local.get('state')).state);
    assert.equal(snapshot.format, format);
    assert.equal(snapshot.url, url);
    assert.ok(!files.includes(snapshot.path));
    assert.equal(path.extname(snapshot.path), `.${format}`);
    assert.equal(await page.getByRole('button', { name: 'Confirm download?', exact: true }).count(), 0);
    assert.equal((await worker.evaluate(async () => chrome.downloads.search({}))).length, previousCount + 1);
    files.push(snapshot.path);
    execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', snapshot.path, '-f', 'null', '-']);
  }
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(panelUrl);
  await reopened.locator('.file-format', { hasText: 'MP3' }).first().waitFor();
  await reopened.locator('.file-format', { hasText: 'MP4' }).first().waitFor();
  assert.equal(await reopened.locator('.lucide-check, .file-icon, .stats-card').count(), 0);
  await reopened.screenshot({ path: path.resolve(root, '../musical-preview.png'), fullPage: true });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: MP3/MP4 confirmation, automatic history redownload, distinct output files, Chrome download history, decoding, reopened panel, 280px layout.');
} catch (error) {
  const worker = context.serviceWorkers()[0];
  if (worker) console.log('Browser failure state', await worker.evaluate(async () => (await chrome.storage.local.get('state')).state));
  throw error;
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
  for (const file of files) {
    if (path.basename(file).startsWith('musical-test [musical-test]')) await fs.unlink(file).catch(error => console.log('Temporary file cleanup', error.code));
  }
}
