(() => {
  const button = document.createElement("button");
  button.id = "musical-youtube-download";
  button.type = "button";
  button.title = "Open Musical for this video";
  // Download icon from Lucide, ISC license.
  button.innerHTML = `<span class="musical-download-icon"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg></span><span>Download</span>`;

  let scheduled = false;
  function syncButton() {
    scheduled = false;
    const url = new URL(location.href);
    const short = url.pathname.match(/^\/shorts\/([\w-]{11})\/?$/);
    if (!short && (url.pathname !== "/watch" || !/^[\w-]{11}$/.test(url.searchParams.get("v") || ""))) {
      button.remove();
      return;
    }
    button.classList.toggle("musical-shorts-download", Boolean(short));
    const actions = short
      ? document.querySelector("ytd-shorts reel-action-bar-view-model, ytd-reel-video-renderer[is-active] #actions")
      : document.querySelector("ytd-watch-metadata #top-level-buttons-computed, ytd-video-primary-info-renderer #top-level-buttons-computed");
    if (!actions) {
      button.remove();
      return;
    }
    if (button.parentElement !== actions) {
      let share = short ? actions.querySelector('#share-button, button[aria-label="Share"]') : null;
      while (share && share.parentElement !== actions) share = share.parentElement;
      actions.insertBefore(button, share?.nextSibling || null);
    }
  }
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(syncButton);
  }

  button.addEventListener("click", async event => {
    if (!event.isTrusted || button.disabled) return;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: "open-youtube" });
      if (response?.error) throw new Error(response.error);
      button.title = "Open Musical for this video";
    } catch (error) {
      button.title = error.message || "Reload this YouTube page and try again";
    } finally {
      button.disabled = false;
    }
  });

  new MutationObserver(scheduleSync).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["is-active"],
  });
  document.addEventListener("yt-navigate-finish", scheduleSync);
  document.addEventListener("yt-page-data-updated", scheduleSync);
  syncButton();
})();
