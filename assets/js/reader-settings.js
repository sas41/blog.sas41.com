/* Tiny, synchronous first-party bootstrap: restore preferences before paint. */
(() => {
  "use strict";
  const key = "sas41.reader.v1";
  const fonts = {
    "source-sans-3": "Source Sans 3",
    inter: "Inter",
    "source-serif-4": "Source Serif 4",
    atkinson: "Atkinson Hyperlegible",
    system: "System sans-serif",
    arial: "Arial",
    verdana: "Verdana",
    tahoma: "Tahoma",
    trebuchet: "Trebuchet MS",
    georgia: "Georgia",
    times: "Times New Roman",
    serif: "System serif",
    monospace: "System monospace",
    courier: "Courier New",
  };
  const defaults = { font: "source-sans-3", size: 18, theme: "dark", width: 700 };
  const clamp = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
  function validate(value) {
    value = value && typeof value === "object" ? value : {};
    return {
      font: Object.hasOwn(fonts, value.font) ? value.font : defaults.font,
      size: clamp(value.size, 14, 28, defaults.size),
      theme: value.theme === "light" ? "light" : "dark",
      width: clamp(value.width, 520, 1200, defaults.width),
    };
  }
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* Storage is optional. */ }
  let values = validate(saved);
  function apply() {
    const root = document.documentElement;
    root.dataset.theme = values.theme;
    root.dataset.readerFont = values.font;
    root.style.setProperty("--reader-font-size", `${values.size}px`);
    root.style.setProperty("--reader-width", `${values.width}px`);
  }
  apply();
  window.blogReader = {
    fonts: Object.freeze(fonts),
    defaults: Object.freeze(defaults),
    get values() { return { ...values }; },
    set(changes) {
      values = validate({ ...values, ...changes });
      apply();
      try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Private browsing/quota. */ }
      window.dispatchEvent(new CustomEvent("reader-settings-change", { detail: { ...values } }));
    },
  };
})();
