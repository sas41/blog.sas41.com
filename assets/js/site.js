/* No framework, no network requests until a reader opens history or an embed. */
(() => {
  "use strict";

  const locales = typeof navigator === "undefined" ? undefined : navigator.languages;
  const dateFormat = new Intl.DateTimeFormat(locales);
  const timestampFormat = new Intl.DateTimeFormat(locales, {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
  const useISO = () => document.documentElement?.dataset.dateFormat === "iso";
  const pad = (value) => String(value).padStart(2, "0");
  function localDate(date) {
    return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    if (!useISO()) return timestampFormat.format(date);
    // ISO-style presentation in local time, not toISOString()'s UTC date.
    const offset = -date.getTimezoneOffset();
    const zone = `UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
  }
  function updateDates() {
    for (const time of document.querySelectorAll("time[data-local-time]")) {
      const fullTimestamp = formatTimestamp(time.dateTime);
      const date = new Date(time.dateTime);
      time.title = fullTimestamp;
      time.textContent = time.dataset?.localTime === "date" && !Number.isNaN(date.getTime())
        ? (useISO() ? localDate(date) : dateFormat.format(date)) : fullTimestamp;
    }
  }
  updateDates();
  window.addEventListener("reader-settings-change", updateDates);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-load-embed]");
    if (!button) return;
    const figure = button.closest("[data-embed-src]");
    const source = new URL(figure.dataset.embedSrc, location.origin);
    if (source.protocol !== "https:") return;
    const frame = document.createElement("iframe");
    frame.src = source.href;
    frame.title = figure.dataset.embedTitle || "External content";
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.allow = "fullscreen; picture-in-picture; encrypted-media";
    frame.allowFullscreen = true;
    // Embed scripts execute in their own origin, not in the blog's document.
    frame.sandbox = "allow-scripts allow-same-origin allow-presentation allow-popups";
    figure.querySelector(".embed-placeholder").replaceWith(frame);
  });
  function enableEmbeds() {
    for (const button of document.querySelectorAll("[data-load-embed]")) button.hidden = false;
  }
  enableEmbeds();
  document.addEventListener("article-revision-change", enableEmbeds);

  const panel = document.querySelector("[data-history-manifest]");
  const historyLink = document.querySelector("[data-history-toggle]");
  if (!panel || !historyLink) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = historyLink.className;
  toggle.innerHTML = historyLink.innerHTML;
  toggle.setAttribute("data-history-toggle", "");
  toggle.setAttribute("aria-controls", "revision-panel");
  toggle.setAttribute("aria-expanded", "false");

  const slider = panel.querySelector("input[type=range]");
  const status = panel.querySelector("[data-revision-status]");
  const error = panel.querySelector("[data-history-error]");
  const content = document.querySelector("[data-article-content]");
  const notice = document.querySelector("[data-old-revision]");
  const original = content.innerHTML;
  const cache = new Map();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let manifest;
  let loading;
  let generation = 0;
  let displayed = Number(slider.max);
  let animation;

  function localURL(path) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) throw new Error("Unexpected revision origin");
    return url;
  }

  async function get(url, json = false) {
    const response = await fetch(localURL(url), { credentials: "omit" });
    if (!response.ok) throw new Error(`Revision request failed (${response.status})`);
    const type = response.headers.get("content-type") || "";
    if (!type.includes(json ? "application/json" : "text/html")) {
      throw new Error("Unexpected revision response");
    }
    return json ? response.json() : response.text();
  }

  function describe(index) {
    const revision = manifest.revisions[index];
    const latest = index === manifest.revisions.length - 1;
    const label = `Revision ${index + 1} of ${manifest.revisions.length} · ${formatTimestamp(revision.date)}${latest ? " · Latest" : ""}`;
    status.textContent = label;
    slider.setAttribute("aria-valuetext", label);
  }
  window.addEventListener("reader-settings-change", () => {
    if (manifest) describe(displayed);
  });

  async function loadManifest() {
    if (manifest) return;
    if (!loading) {
      loading = get(panel.dataset.historyManifest, true).then((value) => {
        if (value.version !== 1 || !Array.isArray(value.revisions) || value.revisions.length < 2) {
          throw new Error("Invalid revision manifest");
        }
        value.revisions.forEach((revision) => {
          localURL(revision.fragment);
          if (typeof revision.date !== "string") throw new Error("Invalid revision date");
        });
        manifest = value;
        slider.max = String(value.revisions.length - 1);
        slider.value = slider.max;
        displayed = Number(slider.max);
        cache.set(displayed, original);
        slider.disabled = false;
        describe(displayed);
      }).catch((failure) => { loading = undefined; throw failure; });
    }
    return loading;
  }

  async function select(index) {
    if (!manifest || index < 0 || index >= manifest.revisions.length) return;
    const token = ++generation;
    animation?.cancel();
    content.style.opacity = "";
    content.style.transform = "";
    error.hidden = true;
    try {
      status.textContent = `Loading revision ${index + 1}…`;
      let html = cache.get(index);
      if (html === undefined) {
        html = await get(manifest.revisions[index].fragment);
        cache.set(index, html);
      }
      // Rapid scrubbing must never allow an older request to win a race.
      if (token !== generation) return;
      if (!reducedMotion.matches && content.animate) {
        animation = content.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(4px)" }], { duration: 90, fill: "forwards" });
        await animation.finished;
      }
      if (token !== generation) return;
      // These fragments are trusted, same-origin build artifacts.
      content.innerHTML = html;
      document.dispatchEvent(new CustomEvent("article-revision-change"));
      animation?.cancel();
      if (!reducedMotion.matches && content.animate) {
        animation = content.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 150 });
      }
      displayed = index;
      notice.hidden = index === manifest.revisions.length - 1;
      describe(index);
    } catch (failure) {
      if (token !== generation || failure.name === "AbortError") return;
      slider.value = String(displayed);
      describe(displayed);
      error.textContent = "This revision could not be loaded. Please retry or refresh if the site was just updated.";
      error.hidden = false;
    }
  }

  toggle.addEventListener("click", async (event) => {
    event.preventDefault();
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden) return;
    error.hidden = true;
    try {
      await loadManifest();
      slider.focus();
    } catch {
      status.textContent = "History unavailable";
      error.textContent = "Could not load history. Try opening it again or refresh the page.";
      error.hidden = false;
    }
  });
  panel.querySelector("[data-history-close]").addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  });
  panel.querySelector("[data-history-latest]").addEventListener("click", () => {
    if (!manifest) return;
    slider.value = slider.max;
    select(Number(slider.max));
  });
  slider.addEventListener("input", () => select(Number(slider.value)));
  // Keep the working archive link unless the inline history UI is ready.
  historyLink.replaceWith(toggle);
})();
