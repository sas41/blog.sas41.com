/* Local-only, progressively enhanced search. Tag links work without JavaScript. */
(() => {
  "use strict";
  const section = document.querySelector("[data-post-filter]");
  if (!section) return;
  const form = section.querySelector("[data-filter-form]");
  const search = form.querySelector("[data-filter-search]");
  const tags = form.querySelector("[data-filter-tags]");
  const clear = form.querySelector("[data-filter-clear]");
  const status = form.querySelector("[data-filter-status]");
  const empty = section.querySelector("[data-filter-empty]");
  const fold = (value) => value.trim().toLowerCase();
  const posts = Array.from(section.querySelectorAll("[data-post-card]"), (card) => {
    const labels = JSON.parse(card.dataset.postTags).map(fold);
    return {
      card,
      tags: labels,
      text: fold(`${card.querySelector("h3").textContent} ${card.querySelector("[data-post-summary]").textContent} ${labels.join(" ")}`),
    };
  });

  function apply(updateURL = true) {
    const words = fold(search.value).split(/\s+/).filter(Boolean);
    const selected = tags.value.split(",").map(fold).filter(Boolean);
    let count = 0;
    for (const post of posts) {
      const visible = words.every((word) => post.text.includes(word))
        && selected.every((tag) => post.tags.includes(tag));
      post.card.hidden = !visible;
      if (visible) count += 1;
    }
    empty.hidden = count !== 0 || posts.length === 0;
    status.textContent = `${count} of ${posts.length} ${posts.length === 1 ? "post" : "posts"}`;
    clear.disabled = !search.value && !tags.value;
    if (updateURL) {
      const url = new URL(location.href);
      if (search.value.trim()) url.searchParams.set("q", search.value.trim());
      else url.searchParams.delete("q");
      if (selected.length) url.searchParams.set("tags", selected.join(","));
      else url.searchParams.delete("tags");
      if (url.href !== location.href) history.replaceState(null, "", url);
    }
  }

  function restore() {
    const params = new URL(location.href).searchParams;
    search.value = params.get("q") || "";
    tags.value = params.get("tags") || "";
    apply(false);
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); apply(); });
  search.addEventListener("input", () => apply());
  tags.addEventListener("input", () => apply());
  clear.addEventListener("click", () => {
    search.value = "";
    tags.value = "";
    apply();
    search.focus();
  });
  section.addEventListener("click", (event) => {
    const link = event.target.closest("[data-tag-filter-link]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    tags.value = link.dataset.tagFilterLink;
    apply();
    tags.focus();
  });
  window.addEventListener("popstate", restore);
  restore();
  form.hidden = false;
})();
