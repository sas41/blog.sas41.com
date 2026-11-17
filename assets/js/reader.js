/* Reading tools, centered width rails, and a revision-aware H1/H2 outline. */
(() => {
  "use strict";
  const preferences = window.blogReader;
  if (!preferences) return;

  const root = document.documentElement;
  const topbar = document.querySelector("[data-topbar]");
  const layout = document.querySelector("[data-reading-layout]");
  const toolbar = document.querySelector("[data-reader-toolbar]");
  const slot = document.querySelector("[data-reader-slot]");
  const dock = document.querySelector("[data-reader-dock]");
  const content = document.querySelector("[data-article-content]");
  const map = document.querySelector("[data-document-map]");
  const mapDisclosure = document.querySelector("[data-document-map-disclosure]");
  const mapMedia = window.matchMedia("(min-width: 1024px)");
  const trail = document.querySelector("[data-heading-trail]");
  const resizeMedia = window.matchMedia("(min-width: 800px) and (hover: hover) and (pointer: fine)");
  const handles = [...document.querySelectorAll("[data-resize]")];
  const panels = [...document.querySelectorAll("[data-reader-panel]")];
  const font = document.querySelector("select[data-reader-font]");
  const dateFormat = document.querySelector("[data-reader-date-format]");
  const size = document.querySelector("[data-reader-size]");
  const sizeOutput = document.querySelector("[data-font-size]");
  const smaller = document.querySelector("[data-font-smaller]");
  const larger = document.querySelector("[data-font-larger]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const desktopMotion = window.matchMedia("(min-width: 800px) and (hover: hover) and (pointer: fine)");
  const panelAnimations = new WeakMap();
  const canAnimate = () => desktopMotion.matches && !reducedMotion.matches;
  if (mapDisclosure) {
    const summary = mapDisclosure.querySelector("summary");
    let mapAnimation;
    function setMapOpen(open, animate = false) {
      const height = mapDisclosure.getBoundingClientRect().height;
      mapAnimation?.cancel();
      mapAnimation = null;
      // Keep native details open until the closing animation completes, so its
      // contents shrink away instead of disappearing before the first frame.
      mapDisclosure.open = true;
      mapDisclosure.dataset.collapsed = String(!open);
      map.inert = !open;
      const target = open ? mapDisclosure.getBoundingClientRect().height : summary.getBoundingClientRect().height + 2;
      if (animate && !reducedMotion.matches && mapDisclosure.animate) {
        const animation = mapDisclosure.animate([
          { height: `${height}px` }, { height: `${target}px` },
        ], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
        mapAnimation = animation;
        animation.finished.then(() => {
          if (mapAnimation !== animation) return;
          mapDisclosure.open = open;
          animation.cancel();
          mapAnimation = null;
          syncHandles();
          schedule();
        }).catch(() => {});
      } else mapDisclosure.open = open;
    }
    mapDisclosure.open = mapMedia.matches;
    mapDisclosure.dataset.collapsed = String(!mapMedia.matches);
    map.inert = !mapMedia.matches;
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      setMapOpen(mapDisclosure.dataset.collapsed === "true", true);
    });
    mapMedia.addEventListener("change", () => { setMapOpen(mapMedia.matches); });
    mapDisclosure.addEventListener("toggle", () => { syncHandles(); schedule(); });
  }
  let headings = [];
  let mapLinks = [];
  let active = null;
  let frame = 0;
  let drag = null;
  let openPanel = null;
  let openTrigger = null;
  let dockAnimation;
  let scrollFrame = 0;

  function cancelNavigation() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  function scrollToSection(target) {
    cancelNavigation();
    if (!canAnimate()) {
      target.scrollIntoView({ block: "start", behavior: "auto" });
      document.dispatchEvent(new CustomEvent("reader-navigation-end"));
      return;
    }
    const start = window.scrollY;
    const limit = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const end = Math.max(0, Math.min(limit, start + target.getBoundingClientRect().top - headerHeight() - 24));
    const distance = end - start;
    const duration = Math.min(420, 220 + Math.abs(distance) * .06);
    let started;
    const step = (now) => {
      started ??= now;
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      // Each frame sets one point on our eased trajectory. Do not start a new
      // native smooth-scroll animation for every frame (or rely on WebViews
      // that may disable native smooth scrolling entirely).
      window.scrollTo({ top: start + distance * eased, behavior: "instant" });
      if (progress < 1) scrollFrame = requestAnimationFrame(step);
      else {
        scrollFrame = 0;
        document.dispatchEvent(new CustomEvent("reader-navigation-end"));
      }
    };
    scrollFrame = requestAnimationFrame(step);
  }

  function headerHeight() {
    return topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
  }

  function widthLimit() {
    const reserved = parseFloat(getComputedStyle(root).getPropertyValue("--reader-reserved")) || 96;
    return Math.max(520, Math.min(1200, Math.floor(window.innerWidth - reserved)));
  }

  function syncHandles() {
    if (!layout) return;
    const width = Math.round(layout.getBoundingClientRect().width);
    for (const handle of handles) {
      handle.hidden = !resizeMedia.matches;
      handle.disabled = !resizeMedia.matches;
      handle.setAttribute("aria-valuemax", String(widthLimit()));
      handle.setAttribute("aria-valuenow", String(width));
      handle.setAttribute("aria-valuetext", `${width} pixels wide`);
    }
  }

  function syncControls() {
    const values = preferences.values;
    if (toolbar) {
      font.value = values.font;
      if (dateFormat) dateFormat.value = values.dateFormat;
      size.value = values.size;
      sizeOutput.value = `${values.size}px`;
      smaller.disabled = values.size <= 14;
      larger.disabled = values.size >= 28;
      for (const mode of document.querySelectorAll("[data-reader-mode]")) mode.checked = mode.value === values.theme;
    }
    // The widget is optional and may not have been loaded by the reader yet.
    syncHandles();
    schedule();
  }

  function dockToolbar(shouldDock) {
    if (!toolbar || !dock || !slot) return;
    if ((toolbar.parentElement === dock) === shouldDock) return;
    const before = toolbar.getBoundingClientRect();
    // Measure the in-flight visual position before canceling, so reversing a
    // scroll mid-transition continues smoothly rather than snapping to an end.
    dockAnimation?.cancel();
    if (shouldDock && toolbar.parentElement !== dock) {
      slot.style.setProperty("--toolbar-height", `${Math.ceil(toolbar.getBoundingClientRect().height)}px`);
      dock.append(toolbar);
      topbar.classList.add("has-reader-controls");
    } else if (!shouldDock && toolbar.parentElement !== slot) {
      slot.append(toolbar);
      topbar.classList.remove("has-reader-controls");
    }
    const after = toolbar.getBoundingClientRect();
    if (canAnimate() && toolbar.animate) {
      dockAnimation = toolbar.animate([
        { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)`, opacity: .65 },
        { transform: "translate(0, 0)", opacity: 1 },
      ], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      dockAnimation.finished.then(schedule).catch(() => {});
    }
  }

  function closePanel(restoreFocus = false) {
    if (!openPanel) return;
    const closing = openPanel;
    panelAnimations.get(closing)?.cancel();
    if (canAnimate() && closing.animate) {
      const animation = closing.animate([
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(-4px)" },
      ], { duration: 130, easing: "ease-out", fill: "forwards" });
      panelAnimations.set(closing, animation);
      animation.finished.then(() => {
        if (openPanel !== closing) closing.hidden = true;
        animation.cancel();
      }).catch(() => {});
    } else closing.hidden = true;
    openTrigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) openTrigger.focus({ preventScroll: true });
    openPanel = null;
    openTrigger = null;
  }

  function positionPanel() {
    if (!openPanel) return;
    const anchor = openTrigger.getBoundingClientRect();
    const rect = openPanel.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.visualViewport?.height || window.innerHeight;
    const left = Math.max(12, Math.min(width - rect.width - 12, anchor.left + anchor.width / 2 - rect.width / 2));
    let top = anchor.bottom + 8;
    if (top + rect.height > height - 12) top = Math.max(12, anchor.top - rect.height - 8);
    openPanel.style.left = `${left}px`;
    openPanel.style.top = `${top}px`;
  }

  function togglePanel(trigger) {
    const panel = panels.find((item) => item.dataset.readerPanel === trigger.dataset.readerOpen);
    if (openPanel === panel) { closePanel(true); return; }
    closePanel();
    openPanel = panel;
    openTrigger = trigger;
    panelAnimations.get(panel)?.cancel();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    positionPanel();
    if (canAnimate() && panel.animate) {
      const animation = panel.animate([
        { opacity: 0, transform: "translateY(-4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], { duration: 160, easing: "ease-out" });
      panelAnimations.set(panel, animation);
    }
    panel.querySelector("input:checked, select, input, button")?.focus({ preventScroll: true });
  }

  function headingCrumb(heading) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `#${encodeURIComponent(heading.id)}`;
    link.textContent = heading.textContent.trim();
    link.title = link.textContent;
    item.append(link);
    return item;
  }

  function trackHeading() {
    if (!content) return;
    const boundary = headerHeight() + 32;
    let current = null;
    let parent = null;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > boundary) break;
      if (heading.tagName === "H1") parent = heading;
      current = heading;
    }
    const selected = current || content.querySelector(".article-heading h1");
    if (active === selected) return;
    active = selected;
    for (const [heading, link] of mapLinks) {
      if (heading === selected) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    if (trail) {
      const path = [];
      if (parent) path.push(headingCrumb(parent));
      if (current && current !== parent) path.push(headingCrumb(current));
      trail.replaceChildren(...path);
      trail.hidden = path.length === 0;
      trail.lastElementChild?.querySelector("a").setAttribute("aria-current", "location");
      if (path.length && canAnimate() && trail.animate) {
        trail.getAnimations().forEach((animation) => animation.cancel());
        trail.animate([{ opacity: .4, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 150, easing: "ease-out" });
      }
    }
  }

  function update() {
    frame = 0;
    if (topbar && slot) {
      // Start while half the toolbar is still visible, not after it has already
      // disappeared behind the sticky header.
      const origin = slot.getBoundingClientRect();
      dockToolbar(origin.top + origin.height / 2 <= topbar.getBoundingClientRect().bottom);
    }
    if (topbar) {
      const height = `${headerHeight()}px`;
      if (root.style.getPropertyValue("--topbar-height") !== height) root.style.setProperty("--topbar-height", height);
    }
    trackHeading();
    positionPanel();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function rebuildMap() {
    if (!content || !map) return;
    headings = [...content.querySelectorAll(".prose h1, .prose h2")];
    const title = content.querySelector(".article-heading h1");
    const allHeadings = title ? [title, ...headings] : headings;
    const used = new Set();
    mapLinks = [];
    const list = document.createElement("ul");
    for (const [index, heading] of allHeadings.entries()) {
      let id = heading.id || `section-${index + 1}`;
      const base = id;
      let suffix = 1;
      while (used.has(id) || (document.getElementById(id) && document.getElementById(id) !== heading)) id = `${base}-${++suffix}`;
      heading.id = id;
      used.add(id);
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${encodeURIComponent(id)}`;
      link.textContent = heading === title ? "Overview" : heading.textContent.trim();
      link.className = heading === title ? "map-overview" : `map-level-${heading.tagName.slice(1)}`;
      item.append(link);
      list.append(item);
      mapLinks.push([heading, link]);
    }
    map.replaceChildren(list);
    active = null;
    schedule();
  }

  if (toolbar) {
    for (const panel of panels) document.body.append(panel);
    for (const [value, label] of Object.entries(preferences.fonts)) font.add(new Option(label, value));
    font.addEventListener("change", () => preferences.set({ font: font.value }));
    if (dateFormat) dateFormat.addEventListener("change", () => preferences.set({ dateFormat: dateFormat.value }));
    size.addEventListener("input", () => preferences.set({ size: Number(size.value) }));
    smaller.addEventListener("click", () => preferences.set({ size: preferences.values.size - 1 }));
    larger.addEventListener("click", () => preferences.set({ size: preferences.values.size + 1 }));
    for (const mode of document.querySelectorAll("[data-reader-mode]")) mode.addEventListener("change", () => preferences.set({ theme: mode.value }));
    for (const reset of document.querySelectorAll("[data-reader-reset]")) reset.addEventListener("click", () => preferences.set(preferences.defaults));
    for (const trigger of toolbar.querySelectorAll("[data-reader-open]")) trigger.addEventListener("click", () => togglePanel(trigger));
    toolbar.hidden = false;
  }

  function finishDrag(commit) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    root.classList.remove("is-resizing");
    if (previous.handle.hasPointerCapture(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer);
    if (commit && previous.moved) preferences.set({ width: previous.width });
    else root.style.setProperty("--reader-width", `${preferences.values.width}px`);
    syncHandles();
  }

  for (const handle of handles) {
    const rail = handle.closest(".reader-rail");
    rail.addEventListener("pointerdown", (event) => {
      if (!resizeMedia.matches || event.button !== 0 || drag) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = { handle, pointer: event.pointerId, x: event.clientX, start: layout.getBoundingClientRect().width, width: 0, moved: false };
      handle.setPointerCapture(event.pointerId);
      root.classList.add("is-resizing");
    });
    rail.addEventListener("pointermove", (event) => {
      if (!drag || drag.handle !== handle || drag.pointer !== event.pointerId) return;
      const direction = handle.dataset.resize === "left" ? -1 : 1;
      drag.width = Math.max(520, Math.min(widthLimit(), Math.round(drag.start + direction * 2 * (event.clientX - drag.x))));
      drag.moved = true;
      root.style.setProperty("--reader-width", `${drag.width}px`);
      syncHandles();
      schedule();
    });
    rail.addEventListener("pointerup", () => finishDrag(true));
    rail.addEventListener("pointercancel", () => finishDrag(false));
    rail.addEventListener("lostpointercapture", () => finishDrag(false));
    rail.addEventListener("dblclick", () => preferences.set({ width: preferences.defaults.width }));
    handle.addEventListener("keydown", (event) => {
      let width = layout.getBoundingClientRect().width;
      const step = event.shiftKey ? 40 : 20;
      if (event.key === "ArrowLeft") width -= step;
      else if (event.key === "ArrowRight") width += step;
      else if (event.key === "Home") width = preferences.defaults.width;
      else if (event.key === "End") width = widthLimit();
      else return;
      event.preventDefault();
      preferences.set({ width: Math.max(520, Math.min(widthLimit(), width)) });
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { finishDrag(false); closePanel(true); }
  });
  window.addEventListener("blur", () => finishDrag(false));
  // User input always wins over a programmatic navigation. In particular,
  // never intercept wheel/touch scrolling or fight the browser's inertia.
  window.addEventListener("wheel", cancelNavigation, { passive: true });
  window.addEventListener("touchstart", cancelNavigation, { passive: true });
  window.addEventListener("pointerdown", cancelNavigation, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Escape"].includes(event.key)) cancelNavigation();
  });
  reducedMotion.addEventListener("change", cancelNavigation);
  desktopMotion.addEventListener("change", cancelNavigation);
  document.addEventListener("pointerdown", (event) => {
    if (openPanel && !openPanel.contains(event.target) && !toolbar.contains(event.target)) closePanel();
  });
  document.addEventListener("focusin", (event) => {
    if (openPanel && !openPanel.contains(event.target) && !toolbar.contains(event.target)) closePanel();
  });
  window.addEventListener("reader-settings-change", syncControls);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", () => { if (drag) finishDrag(false); syncHandles(); schedule(); });
  window.visualViewport?.addEventListener("resize", schedule);
  resizeMedia.addEventListener("change", () => { finishDrag(false); syncHandles(); });
  document.addEventListener("article-revision-change", rebuildMap);
  document.addEventListener("load", schedule, true); // Images may move headings.

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest("a[href]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
        || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const url = new URL(anchor.href, location.href);
    if (!url.hash || url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
    let target;
    try { target = document.getElementById(decodeURIComponent(url.hash.slice(1))); } catch { return; }
    if (!target) return;
    event.preventDefault();
    // The header's height is constant; let the toolbar dock naturally as the
    // page scrolls instead of teleporting it before an anchor navigation.
    root.style.setProperty("--topbar-height", `${headerHeight()}px`);
    history.pushState(null, "", url.hash);
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    scrollToSection(target);
    schedule();
  });

  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => { syncHandles(); schedule(); });
    if (topbar) observer.observe(topbar);
    if (layout) observer.observe(layout);
  }
  if (content) {
    // Also cover trusted custom components that replace article content.
    new MutationObserver(rebuildMap).observe(content, { childList: true, subtree: true });
    rebuildMap();
  }
  document.fonts?.ready.then(schedule);
  syncControls();
})();
