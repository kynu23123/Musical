import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function event() {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.forEach(listener => listener(...args)) };
}

async function setup(saved) {
  const storage = { state: saved };
  const native = { onMessage: event(), onDisconnect: event(), sent: [], postMessage(message) { this.sent.push(message); } };
  const items = new Map();
  const options = [];
  const openedPanels = [];
  const chrome = {
    storage: { local: { get: async () => structuredClone(storage), set: async value => Object.assign(storage, structuredClone(value)) } },
    runtime: { id: 'test', onInstalled: event(), onMessage: event(), connectNative: () => native },
    sidePanel: { setPanelBehavior: async () => {}, open: value => { openedPanels.push(value); return Promise.resolve(); } },
    downloads: {
      onChanged: event(),
      download: async option => {
        options.push(option);
        const id = options.length;
        items.set(id, { id, filename: 'C:/Downloads/' + option.filename, state: 'in_progress' });
        return id;
      },
      search: async ({ id }) => items.has(id) ? [items.get(id)] : [],
      cancel: async id => {
        items.get(id).state = 'interrupted';
        items.get(id).error = 'USER_CANCELED';
        chrome.downloads.onChanged.emit({ id, state: { current: 'interrupted' } });
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/background.js', import.meta.url), 'utf8'), { chrome, console, URL });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const send = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, { id: 'test' }, resolve));
  await send({ action: 'state' });
  native.onMessage.emit({ type: 'ready', browserDownloads: true });
  await flush();
  return { chrome, native, storage, send, flush, items, options, openedPanels };
}

test('YouTube clicks open the panel synchronously and prefill only the video link', async () => {
  const app = await setup();
  app.storage.draft = { url: 'https://example.com/old', format: 'mp3' };
  const reply = new Promise(resolve => app.chrome.runtime.onMessage.emit({ action: 'open-youtube' }, {
    id: 'test', tab: { id: 23, url: 'https://www.youtube.com/watch?v=igQVceb5D24&list=radio&t=10' },
  }, resolve));
  assert.equal(app.openedPanels[0].tabId, 23);
  assert.equal((await reply).success, true);
  assert.equal(app.storage.draft.url, 'https://www.youtube.com/watch?v=igQVceb5D24');
  assert.equal(app.storage.draft.format, 'mp3');
  assert.equal(app.options.length, 0);
});

test('YouTube clicks preserve the draft during an existing job', async () => {
  const app = await setup();
  app.storage.draft = { url: 'https://example.com/active', format: 'mp4' };
  await app.send({ action: 'start', url: 'https://example.com/active', format: 'mp4' });
  const result = await new Promise(resolve => app.chrome.runtime.onMessage.emit({ action: 'open-youtube' }, {
    id: 'test', tab: { id: 23, url: 'https://www.youtube.com/watch?v=igQVceb5D24' },
  }, resolve));
  assert.equal(result.success, true);
  assert.equal(app.storage.draft.url, 'https://example.com/active');
});

test('the YouTube action rejects other origins and non-video pages', async () => {
  const app = await setup();
  for (const url of ['https://example.com/watch?v=igQVceb5D24', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=invalid']) {
    const result = await new Promise(resolve => app.chrome.runtime.onMessage.emit({ action: 'open-youtube' }, {
      id: 'test', tab: { id: 23, url },
    }, resolve));
    assert.ok(result.error);
  }
  assert.equal(app.openedPanels.length, 0);
});

test('Chrome owns the download and history increments only after Chrome completes', async () => {
  const app = await setup();
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp3' });
  app.native.onMessage.emit({ type: 'info', info: { title: 'Sample' } });
  app.native.onMessage.emit({ type: 'prepared', filename: 'Sample.mp3', url: 'http://127.0.0.1:12000/' + 'a'.repeat(43) });
  await app.flush();
  assert.equal(app.storage.state.phase, 'prepared');
  assert.equal(app.options.length, 0);
  await app.send({ action: 'confirm' });
  assert.equal(app.storage.state.phase, 'saving');
  assert.equal(app.storage.state.total, 0);
  assert.equal(app.options[0].saveAs, false);
  assert.equal(app.options[0].conflictAction, 'uniquify');
  const id = app.storage.state.downloadId;
  app.items.get(id).state = 'complete';
  app.chrome.downloads.onChanged.emit({ id, state: { current: 'complete' } });
  app.chrome.downloads.onChanged.emit({ id, state: { current: 'complete' } });
  await app.flush();
  assert.equal(app.storage.state.total, 1);
  assert.equal(app.storage.state.history[0].title, 'Sample');
  assert.equal(app.storage.state.phase, 'complete');
  assert.ok(app.native.sent.some(message => message.action === 'release'));
});

test('cancelling a Chrome save cancels the browser item and releases the temporary file', async () => {
  const app = await setup();
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp3' });
  app.native.onMessage.emit({ type: 'prepared', filename: 'Sample.mp3', url: 'http://127.0.0.1:12000/' + 'a'.repeat(43) });
  await app.flush();
  await app.send({ action: 'confirm' });
  await app.send({ action: 'cancel' });
  assert.equal(app.storage.state.phase, 'cancelled');
  assert.equal(app.storage.state.total, 0);
  assert.ok(app.native.sent.some(message => message.action === 'release'));
});

test('Chrome save failures leave an error and release the file', async () => {
  const app = await setup();
  app.chrome.downloads.download = async () => { throw new Error('Disk full'); };
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp3' });
  app.native.onMessage.emit({ type: 'prepared', filename: 'Sample.mp3', url: 'http://127.0.0.1:12000/' + 'a'.repeat(43) });
  await app.flush();
  await app.send({ action: 'confirm' });
  assert.equal(app.storage.state.phase, 'error');
  assert.match(app.storage.state.error, /Disk full/);
  assert.equal(app.storage.state.total, 0);
  assert.ok(app.native.sent.some(message => message.action === 'release'));
});

test('a prepared file can be cancelled without creating a Chrome download', async () => {
  const app = await setup();
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp3' });
  app.native.onMessage.emit({ type: 'prepared', filename: 'Sample.mp3', url: 'http://127.0.0.1:12000/' + 'a'.repeat(43) });
  await app.flush();
  await app.send({ action: 'cancel' });
  assert.equal(app.options.length, 0);
  assert.equal(app.storage.state.phase, 'cancelled');
  assert.ok(app.native.sent.some(message => message.action === 'release'));
  assert.ok((await app.send({ action: 'confirm' })).error);
});

test('confirming twice creates only one browser download', async () => {
  const app = await setup();
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp3' });
  app.native.onMessage.emit({ type: 'prepared', filename: 'Sample.mp3', url: 'http://127.0.0.1:12000/' + 'a'.repeat(43) });
  await app.flush();
  await app.send({ action: 'confirm' });
  assert.ok((await app.send({ action: 'confirm' })).error);
  assert.equal(app.options.length, 1);
});

test('busy state rejects a second start and cancellation does not add a download', async () => {
  const app = await setup();
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp4' });
  const rejected = await app.send({ action: 'start', url: 'https://example.com/other', format: 'mp3' });
  assert.match(rejected.error, /current download/);
  await app.send({ action: 'cancel' });
  app.native.onMessage.emit({ type: 'progress', percent: 50 });
  await app.flush();
  assert.equal(app.storage.state.phase, 'cancelling');
  app.native.onMessage.emit({ type: 'cancelled' });
  await app.flush();
  assert.equal(app.storage.state.total, 0);
  assert.equal(app.storage.state.phase, 'cancelled');
});

test('invalid input and helper disconnection are recoverable', async () => {
  const app = await setup();
  assert.ok((await app.send({ action: 'start', url: 'file:///test', format: 'mp3' })).error);
  await app.send({ action: 'start', url: 'https://example.com/video', format: 'mp3' });
  app.native.onDisconnect.emit();
  await app.flush();
  assert.equal(app.storage.state.connected, false);
  assert.equal(app.storage.state.phase, 'error');
  assert.equal(app.storage.state.total, 0);
});

test('restoring a stopped worker preserves the count and clears a stale job', async () => {
  const app = await setup({ total: 8, history: [], phase: 'downloading', connected: true });
  assert.equal(app.storage.state.total, 8);
  assert.equal(app.storage.state.phase, 'error');
});
