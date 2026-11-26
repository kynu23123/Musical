const HOST = "com.musical.downloader";
let port;
let preparedFile;
let serial = Promise.resolve();
let state = { phase: "idle", connected: false, total: 0, history: [], error: "" };
const loaded = chrome.storage.local.get("state").then(async ({ state: saved }) => {
  if (saved) state = { ...state, ...saved, connected: false };
  if (state.phase === "saving" && state.downloadId != null) {
    const [item] = await chrome.downloads.search({ id: state.downloadId });
    if (item?.state === "complete") {
      await finishBrowserDownload(item);
    } else {
      if (item?.state === "in_progress") await chrome.downloads.cancel(item.id).catch(() => {});
      state.phase = "error";
      state.error = "Download interrupted. Paste the link to try again.";
    }
  }
  if (["starting", "downloading", "converting", "prepared", "cancelling"].includes(state.phase)) {
    state.phase = "error";
    state.error = "Download interrupted. Paste the link to try again.";
  }
});
const busy = () => ["starting", "downloading", "converting", "prepared", "saving", "cancelling"].includes(state.phase);
const save = () => {
  state.revision = (state.revision || 0) + 1;
  return chrome.storage.local.set({ state });
};
function enqueue(work) {
  const task = serial.then(() => loaded).then(work);
  serial = task.catch(console.error);
  return task;
}
function releaseFile() {
  preparedFile = undefined;
  if (port && state.connected) port.postMessage({ action: "release" });
}
async function finishBrowserDownload(item) {
  if (!["saving", "cancelling"].includes(state.phase) || item.id !== state.downloadId) return;
  if (item.state === "complete") {
    state.phase = "complete";
    state.total += 1;
    state.path = item.filename;
    state.filename = item.filename.split(/[\\/]/).pop();
    state.percent = 100;
    state.error = "";
    state.history = [{ title: state.info?.title || state.filename, format: state.format,
      filename: state.filename, date: new Date().toISOString() }, ...state.history].slice(0, 20);
  } else if (item.state === "interrupted") {
    state.phase = item.error === "USER_CANCELED" ? "cancelled" : "error";
    state.error = state.phase === "error" ? `Chrome could not save the file (${item.error || "interrupted"}). Try again.` : "";
  } else {
    return;
  }
  releaseFile();
  await save();
}
chrome.downloads.onChanged.addListener(delta => enqueue(async () => {
  if (delta.id !== state.downloadId || !delta.state) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (item) await finishBrowserDownload(item);
}));
function connect() {
  if (port) return;
  const connection = chrome.runtime.connectNative(HOST);
  port = connection;
  connection.onMessage.addListener(message => enqueue(async () => {
    if (port !== connection) return;
    switch (message.type) {
      case "ready":
        state.connected = message.browserDownloads === true;
        if (!state.connected) state.error = "Run Setup.cmd to update the helper, then reload the extension.";
        else if (!busy()) state.error = "";
        break;
      case "info":
        state.info = message.info;
        break;
      case "progress":
        if (state.phase === "cancelling") break;
        state.phase = "downloading";
        state.percent = message.percent;
        state.speed = message.speed;
        state.eta = message.eta;
        break;
      case "converting":
        if (state.phase !== "cancelling") state.phase = "converting";
        break;
      case "prepared": {
        if (state.phase === "cancelling") {
          releaseFile();
          state.phase = "cancelled";
          break;
        }
        if (!busy() || state.downloadId != null) break;
        const downloadUrl = new URL(message.url);
        if (downloadUrl.protocol !== "http:" || downloadUrl.hostname !== "127.0.0.1"
          || !downloadUrl.port || !/^\/[A-Za-z0-9_-]{43}$/.test(downloadUrl.pathname)
          || typeof message.filename !== "string" || /[\\/]/.test(message.filename)) {
          releaseFile();
          state.phase = "error";
          state.error = "The helper returned an invalid file. Update it and try again.";
          break;
        }
        state.phase = "prepared";
        state.filename = message.filename;
        state.percent = 100;
        preparedFile = { url: downloadUrl.href, filename: message.filename };
        break;
      }
      case "cancelled":
        state.phase = "cancelled";
        break;
      case "error":
        state.phase = "error";
        state.error = message.error;
        break;
      case "notice":
        state.error = message.error;
        break;
      default: return;
    }
    await save();
  }));
  connection.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    enqueue(async () => {
      if (port !== connection) return;
      port = undefined;
      state.connected = false;
      if (busy() && state.phase !== "saving") state.phase = "error";
      state.error = reason?.includes("not found")
        ? "Run Setup.cmd, then reconnect."
        : "Helper disconnected. Run Setup.cmd or reconnect.";
      await save();
    });
  });
  connection.postMessage({ action: "ping" });
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.action === "open-youtube") {
    try {
      const video = new URL(sender.tab?.url || "");
      const short = video.pathname.match(/^\/shorts\/([\w-]{11})\/?$/);
      const videoId = short?.[1] || (video.pathname === "/watch" ? video.searchParams.get("v") : null);
      if (sender.tab?.id == null || video.origin !== "https://www.youtube.com"
        || !/^[\w-]{11}$/.test(videoId || "")) {
        throw new Error("Open a YouTube video first.");
      }
      // Chrome requires this call to stay inside the click's user gesture.
      const opening = chrome.sidePanel.open({ tabId: sender.tab.id });
      Promise.all([opening, enqueue(async () => {
        if (busy()) return;
        const { draft } = await chrome.storage.local.get("draft");
        await chrome.storage.local.set({ draft: {
          url: short ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
          format: draft?.format === "mp3" ? "mp3" : "mp4",
        } });
      })]).then(() => reply({ success: true })).catch(error => reply({ error: error.message }));
    } catch (error) {
      reply({ error: error.message });
    }
    return true;
  }
  enqueue(async () => {
    switch (message.action) {
      case "state":
        connect();
        break;
      case "start": {
        if (busy()) throw new Error("Wait for the current download.");
        const url = new URL(message.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          throw new Error("Paste a valid video link.");
        }
        if (!["mp3", "mp4"].includes(message.format)) throw new Error("Choose MP3 or MP4.");
        if (!port || !state.connected) throw new Error("Connect the helper first.");
        state = { ...state, phase: "starting", error: "", url: url.href, format: message.format,
          info: undefined, percent: null, speed: null, eta: null, path: "", filename: "", downloadId: null };
        await save();
        port.postMessage({ action: "download", url: url.href, format: message.format });
        break;
      }
      case "cancel":
        if (port && busy() && state.phase !== "cancelling") {
          if (state.phase === "prepared") {
            releaseFile();
            state.phase = "cancelled";
            await save();
            break;
          }
          state.phase = "cancelling";
          await save();
          if (state.downloadId != null) {
            await chrome.downloads.cancel(state.downloadId).catch(() => {});
            const [item] = await chrome.downloads.search({ id: state.downloadId });
            if (item) await finishBrowserDownload(item);
          } else {
            port.postMessage({ action: "cancel" });
          }
        }
        break;
      case "confirm":
        if (state.phase !== "prepared" || !preparedFile || !state.connected) {
          throw new Error("The file is not ready to save. Start the download again.");
        }
        state.phase = "saving";
        state.percent = null;
        await save();
        try {
          state.downloadId = await chrome.downloads.download({ ...preparedFile,
            saveAs: false, conflictAction: "uniquify" });
          const [item] = await chrome.downloads.search({ id: state.downloadId });
          if (item) await finishBrowserDownload(item);
        } catch (error) {
          releaseFile();
          state.phase = "error";
          state.error = `Chrome could not start the download. ${error.message}`;
        }
        await save();
        break;
      case "folder":
        await chrome.downloads.showDefaultFolder();
        break;
      default: throw new Error("Unknown action.");
    }
    reply({ state });
  }).catch(error => reply({ error: error.message }));
  return true;
});
