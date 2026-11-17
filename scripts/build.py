#!/usr/bin/env python3
"""Build a static Hugo site and a public, rendered subset of private Git history.

Only Markdown snapshots of currently published pages leave the build stage.
Commit hashes, messages, author addresses, draft versions, and Git files do not.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date, datetime, timezone
from urllib.parse import urlsplit

import yaml


UTC = timezone.utc
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
RESERVED = {"history", "__render", "__history_manifest__", "assets", "p", "categories", "tags", "css", "js", "fonts"}


class BuildError(Exception):
    pass


def normalize_tags(value, label: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list) or any(not isinstance(tag, str) for tag in value):
        raise BuildError(f"{label}: tags must be comma-separated text or a list of strings")
    tags = []
    seen = set()
    for entry in value:
        for tag in entry.split(","):
            tag = tag.strip()
            if not tag:
                continue
            if len(tag) > 80 or re.search(r"[/\\\x00-\x1f]", tag):
                raise BuildError(f"{label}: tags must be at most 80 characters without slashes or control characters")
            if tag.lower() not in seen:
                tags.append(tag)
                seen.add(tag.lower())
    return tags


def run(*args: str, cwd: Path, env=None) -> str:
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise BuildError(f"{args[0]} failed: {result.stderr.strip()}")
    return result.stdout


def git(root: Path, *args: str) -> str:
    return run("git", *args, cwd=root)


def parse_document(source: str, label: str) -> tuple[dict, str]:
    """Use explicit YAML front matter; fail rather than guess at malformed input."""
    source = source.removeprefix("\ufeff")
    match = re.match(r"\A---\s*\n(.*?)\n---[ \t]*(?:\n|$)", source, re.DOTALL)
    if not match:
        raise BuildError(f"{label}: expected a YAML front matter block (---)")
    try:
        metadata = yaml.safe_load(match.group(1))
    except yaml.YAMLError as error:
        raise BuildError(f"{label}: invalid YAML front matter: {error}") from error
    if not isinstance(metadata, dict):
        raise BuildError(f"{label}: front matter must be a mapping")
    if "tags" in metadata:
        metadata["tags"] = normalize_tags(metadata["tags"], label)
    return metadata, source[match.end():]


def instant(value, label="date") -> datetime:
    try:
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, date):
            parsed = datetime.combine(value, datetime.min.time())
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed).astimezone(UTC)
    except (ValueError, TypeError) as error:
        raise BuildError(f"Invalid ISO date in {label}: {value!r}") from error


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def published(metadata: dict, at: datetime) -> bool:
    draft = metadata.get("draft", False)
    if not isinstance(draft, bool):
        raise BuildError("draft must be true or false, not a quoted string")
    if draft:
        return False
    publication = metadata.get("publishDate", metadata.get("date"))
    return publication is None or instant(publication, "publishDate/date") <= at


def validate_url(value, label: str, *, stable_id=None) -> str:
    if not isinstance(value, str):
        raise BuildError(f"{label}: url and aliases must be strings")
    parsed = urlsplit(value)
    parts = value.strip("/").split("/")
    if (parsed.scheme or parsed.netloc or parsed.query or parsed.fragment
            or not value.startswith("/") or value.startswith("//")
            or not value.endswith("/") or value == "/"
            or any(part in {"", ".", ".."} for part in parts)
            or re.search(r'[\s\\%<>"\x00-\x1f]', value)):
        raise BuildError(f"{label}: use an absolute site path with a trailing slash, e.g. /writing/my-post/")
    if parts[0] in RESERVED and value != f"/p/{stable_id}/":
        raise BuildError(f"{label}: {parts[0]!r} is reserved for generated files")
    if value in {"/posts/", "/pages/"}:
        raise BuildError(f"{label}: URL conflicts with a generated section")
    return value


def validate_page(metadata: dict, label: str, *, require_category=False) -> None:
    identifier = metadata.get("id", "")
    if not isinstance(identifier, str) or not ID_PATTERN.fullmatch(identifier):
        raise BuildError(f"{label}: id must be a permanent lowercase identifier, e.g. my-first-post")
    if not isinstance(metadata.get("title"), str) or not metadata["title"].strip():
        raise BuildError(f"{label}: title is required")
    if require_category:
        category = metadata.get("category")
        if (not isinstance(category, str) or not category.strip() or len(category) > 80
                or re.search(r"[/\\\x00-\x1f]", category)):
            raise BuildError(f"{label}: one category is required, e.g. category: Software")
    validate_url(metadata.get("url"), label, stable_id=identifier)
    aliases = metadata.get("aliases", [])
    if not isinstance(aliases, list):
        raise BuildError(f"{label}: aliases must be a list of URL paths")
    for alias in aliases:
        validate_url(alias, label, stable_id=identifier)


def read_current(root: Path, now: datetime) -> dict:
    pages = {}
    claimed_urls = {}
    for path in sorted((root / "content").rglob("*.md")):
        if path.name == "_index.md":
            continue
        if path.is_symlink():
            raise BuildError(f"Symlinked content is not supported: {path}")
        relative = path.relative_to(root).as_posix()
        source = path.read_text(encoding="utf-8")
        metadata, body = parse_document(source, relative)
        if not published(metadata, now):
            continue
        validate_page(metadata, relative, require_category=path.relative_to(root / "content").parts[0] == "posts")
        identifier = metadata["id"]
        if identifier in pages:
            raise BuildError(f"Duplicate page id: {identifier}")
        routes = set([metadata["url"], *metadata.get("aliases", []), f"/p/{identifier}/"])
        for route in routes:
            if route in claimed_urls:
                raise BuildError(f"Duplicate URL {route}: {relative} and {claimed_urls[route]}")
            claimed_urls[route] = relative
        pages[identifier] = {"metadata": metadata, "body": body, "source": source, "path": relative}
    return pages


def collect_history(root: Path, current: dict, *, preview=False, now=None) -> dict:
    """Inspect first-parent snapshots, tracking IDs instead of filenames or URLs.

    Merge commits publish one revision, rather than exposing every private edit on
    their side branches. Unrelated commits and file-only renames add no revision.
    """
    now = now or datetime.now(UTC)
    histories = {identifier: [] for identifier in current}
    try:
        git(root, "rev-parse", "--verify", "HEAD")
    except BuildError:
        if not preview:
            raise BuildError("A committed Git repository is required. Use --preview for an uncommitted local preview.")
        commits = []
    else:
        if git(root, "rev-parse", "--is-shallow-repository").strip() == "true":
            raise BuildError("Full Git history is required; run git fetch --unshallow or use fetch-depth: 0.")
        if not preview and git(root, "status", "--porcelain", "--untracked-files=all", "--", "content").strip():
            raise BuildError("Commit content changes first, or use --preview. Production history must match the published content.")
        commits = git(root, "log", "--first-parent", "--reverse", "--format=%H %cI", "HEAD").splitlines()

    blobs = {}
    previous_sources = {}
    observed_sources = {}
    source_changed_at = {}
    invalid_blobs = set()
    for entry in commits:
        commit, stamp = entry.split(" ", 1)
        at = instant(stamp)
        tree = git(root, "ls-tree", "-r", "-z", commit, "--", "content")
        seen_ids = set()
        for item in tree.split("\0"):
            if not item:
                continue
            info, path = item.split("\t", 1)
            mode, kind, oid = info.split()
            if kind != "blob" or mode == "120000" or not path.endswith(".md") or Path(path).name == "_index.md":
                continue
            if oid in invalid_blobs:
                continue
            if oid not in blobs:
                source = git(root, "cat-file", "blob", oid)
                try:
                    metadata, body = parse_document(source, f"historical {path}")
                    # Check historical publication metadata without trusting a
                    # malformed old draft/date field to mean "public".
                    published(metadata, at)
                except BuildError:
                    print(f"Warning: skipping malformed historical Markdown: {path}", file=sys.stderr)
                    invalid_blobs.add(oid)
                    continue
                blobs[oid] = (metadata, body, source)
            metadata, body, source = blobs[oid]
            identifier = metadata.get("id")
            if not isinstance(identifier, str) or identifier not in current:
                continue
            if observed_sources.get(identifier) != source:
                observed_sources[identifier] = source
                source_changed_at[identifier] = at
            if not published(metadata, at):
                continue
            if identifier in seen_ids:
                raise BuildError(f"Duplicate published id {identifier!r} in a historical snapshot")
            seen_ids.add(identifier)
            if previous_sources.get(identifier) == source:
                continue
            histories[identifier].append({"metadata": metadata, "body": body, "date": iso(at), "source": source})
            previous_sources[identifier] = source

    for identifier, page in current.items():
        revisions = histories[identifier]
        if not revisions or revisions[-1]["source"] != page["source"]:
            publication = page["metadata"].get("publishDate", page["metadata"].get("date"))
            # A manual build may publish a scheduled post after its due date,
            # without a new Git commit. Export only its final committed source,
            # never the pre-publication edits that were skipped above.
            scheduled = (publication is not None and identifier in source_changed_at
                         and instant(publication) > source_changed_at[identifier]
                         and instant(publication) <= now)
            if not preview and not scheduled:
                raise BuildError(f"No matching published history for {page['path']}. Check draft/date metadata and commit it on the publishing branch.")
            stamp = instant(publication) if scheduled else now
            revisions.append({"metadata": page["metadata"], "body": page["body"], "date": iso(stamp), "source": page["source"]})
    return histories


def json_default(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(f"Cannot serialize {type(value)}")


def write_page(path: Path, metadata: dict, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, ensure_ascii=False, default=json_default) + "\n" + body, encoding="utf-8")


def fallback_document(title: str, inner: str, *, css: str, canonical: str, base: str, settings: str, post_title: str, category="") -> str:
    e = html.escape
    category_crumb = f'<li><span>{e(category)}</span></li>' if category else ''
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,follow"><meta name="color-scheme" content="light dark">
<script src="{e(settings, quote=True)}" data-cfasync="false"></script>
<base href="{e(base, quote=True)}"><title>{e(title)} — Sas' Blog</title>
<link rel="canonical" href="{e(canonical, quote=True)}"><link rel="stylesheet" href="{e(css, quote=True)}"></head>
<body><a class="skip-link" href="#main">Skip to content</a>
<div class="site-topbar"><div class="site-topbar-inner"><header class="site-header"><a class="wordmark" href="/">Sas' Blog</a><nav aria-label="Main navigation"><a href="/">Writing</a><a href="/about/">About</a></nav></header>
<nav class="breadcrumbs" aria-label="Breadcrumb"><ol class="breadcrumb-pages"><li><a href="/">Home</a></li>{category_crumb}<li><a href="{e(canonical, quote=True)}">{e(post_title)}</a></li><li><span aria-current="page">Edit history</span></li></ol></nav></div></div>
<div class="site-shell"><main id="main" class="archive-page">{inner}</main><footer class="site-footer"><span>Powered by Hugo, Remark42</span><span class="copyright">© {datetime.now(UTC).year} SAS41</span></footer>
</div></body></html>'''


def finalize_history(output: Path, current: dict, histories: dict, base_url: str) -> None:
    home_html = (output / "index.html").read_text()
    css_match = re.search(r'<link rel="stylesheet" href="([^"]+)"', home_html)
    settings_match = re.search(r'<script src="([^"]*reader-settings\.[^"]+)"', home_html)
    if not css_match:
        raise BuildError("Could not find the generated stylesheet")
    if not settings_match:
        raise BuildError("Could not find the reading preferences bootstrap")
    css = css_match.group(1)
    replacements = {}
    for identifier, page in current.items():
        directory = output / "history" / identifier
        directory.mkdir(parents=True, exist_ok=True)
        revisions = []
        canonical = base_url.rstrip("/") + page["metadata"]["url"]
        e = html.escape
        for index, revision in enumerate(histories[identifier]):
            fragment = (output / "__render" / identifier / str(index) / "index.html").read_text(encoding="utf-8")
            digest = hashlib.sha256(fragment.encode()).hexdigest()
            fragment_url = f"/history/{identifier}/{digest}.html"
            full_inner = (f'<p><a href="{e(page["metadata"]["url"], quote=True)}">← Current article</a> · '
                          f'<a href="/history/{identifier}/">All revisions</a></p>'
                          f'<p class="old-revision-notice">Revision {index + 1} of {len(histories[identifier])} · {revision["date"][:10]} (UTC). '
                          'Historical content, rendered with current templates.</p>' + fragment)
            full_page = fallback_document(revision["metadata"].get("title", page["metadata"]["title"]), full_inner,
                                          css=css, canonical=canonical, base=canonical, settings=settings_match.group(1),
                                          post_title=page["metadata"]["title"], category=page["metadata"].get("category", ""))
            # Full pages include date/index and stylesheet; hash their actual bytes too.
            page_digest = hashlib.sha256(full_page.encode()).hexdigest()
            full_url = f"/history/{identifier}/{page_digest}.page.html"
            (directory / f"{digest}.html").write_text(fragment, encoding="utf-8")
            (directory / f"{page_digest}.page.html").write_text(full_page, encoding="utf-8")
            revisions.append({"date": revision["date"], "title": revision["metadata"].get("title", ""),
                              "fragment": fragment_url, "page": full_url})
        manifest = json.dumps({"version": 1, "id": identifier, "revisions": revisions}, ensure_ascii=False, separators=(",", ":"))
        manifest_digest = hashlib.sha256(manifest.encode()).hexdigest()
        (directory / f"{manifest_digest}.json").write_text(manifest, encoding="utf-8")
        replacements[f"/__history_manifest__/{identifier}/"] = f"/history/{identifier}/{manifest_digest}.json"
        links = "".join(f'<li><a href="{item["page"]}">Revision {index + 1} · {item["date"][:10]}</a>'
                        f'{" — latest" if index == len(revisions) - 1 else ""}</li>' for index, item in enumerate(revisions))
        inner = (f'<p><a href="{e(page["metadata"]["url"], quote=True)}">← Current article</a></p>'
                 f'<p class="eyebrow">PUBLIC EDIT HISTORY</p><h1>{e(page["metadata"]["title"])}</h1>'
                 f'<p>Published revisions, oldest first. Dates are UTC.</p><ol class="archive-list">{links}</ol>')
        (directory / "index.html").write_text(fallback_document("Edit history", inner, css=css, canonical=canonical, base=canonical,
                                                              settings=settings_match.group(1), post_title=page["metadata"]["title"],
                                                              category=page["metadata"].get("category", "")), encoding="utf-8")

    for path in output.rglob("*.html"):
        if "history" in path.relative_to(output).parts or "__render" in path.relative_to(output).parts:
            continue
        source = path.read_text(encoding="utf-8")
        if "/__history_manifest__/" not in source:
            continue
        for placeholder, manifest_url in replacements.items():
            source = source.replace(placeholder, manifest_url)
        if "/__history_manifest__/" in source:
            raise BuildError(f"Unresolved history placeholder in {path}")
        path.write_text(source, encoding="utf-8")
    shutil.rmtree(output / "__render", ignore_errors=True)


def build(root: Path, destination: Path, *, preview=False) -> None:
    root = root.resolve()
    destination = destination.resolve()
    if destination == root or destination in root.parents or (root / "content" == destination) or root / "content" in destination.parents:
        raise BuildError("Destination must not overwrite the project or its content")
    if destination.exists() and any(destination.iterdir()):
        raise BuildError(f"Destination is not empty: {destination}. Choose a new directory or explicitly remove the old generated output.")
    now = datetime.now(UTC)
    current = read_current(root, now)
    histories = collect_history(root, current, preview=preview, now=now)
    with tempfile.TemporaryDirectory(prefix="blog-build-") as temp:
        stage = Path(temp)
        for name in ("layouts", "assets", "static"):
            if (root / name).exists():
                shutil.copytree(root / name, stage / name)
        shutil.copyfile(root / "hugo.toml", stage / "hugo.toml")
        content = stage / "content"
        content.mkdir()
        if (root / "content" / "_index.md").exists():
            shutil.copyfile(root / "content" / "_index.md", content / "_index.md")
        for identifier, page in current.items():
            revisions = histories[identifier]
            metadata = copy.deepcopy(page["metadata"])
            # An optional explicit date backdates imported posts. Otherwise Git is authoritative.
            posted = iso(instant(metadata.get("date", revisions[0]["date"])))
            metadata["date"] = posted
            metadata["lastmod"] = revisions[-1]["date"]
            metadata["type"] = "post" if Path(page["path"]).parts[1] == "posts" else "page"
            if metadata["type"] == "post":
                metadata["category"] = metadata["category"].strip()
                metadata["categories"] = [metadata["category"]]
            else:
                metadata["tags"] = []
            metadata["history"] = {"count": len(revisions), "manifest": f"/__history_manifest__/{identifier}/"}
            stable_route = f"/p/{identifier}/"
            metadata["aliases"] = list(dict.fromkeys([*metadata.get("aliases", []), stable_route]))
            metadata["aliases"] = [alias for alias in metadata["aliases"] if alias != metadata["url"]]
            write_page(stage / page["path"], metadata, page["body"])
            for index, revision in enumerate(revisions):
                historical = copy.deepcopy(revision["metadata"])
                historical.update({"url": f"/__render/{identifier}/{index}/", "type": "revision", "layout": "single",
                                   "aliases": [], "draft": False, "date": "2000-01-01T00:00:00Z",
                                   "publishDate": "2000-01-01T00:00:00Z", "expiryDate": "2099-01-01T00:00:00Z",
                                   "outputs": ["HTML"], "build": {"list": "never", "render": "always"}})
                historical.pop("_build", None)
                historical.pop("history", None)
                historical["categories"] = []
                historical["tags"] = []
                write_page(content / "revisions" / identifier / f"{index}.md", historical, revision["body"])
        output = stage / "public"
        environment = os.environ.copy()
        environment["HUGO_CACHEDIR"] = str(stage / "cache")
        print(run("hugo", "--source", str(stage), "--destination", str(output), cwd=root, env=environment), end="")
        import tomllib
        config = tomllib.loads((root / "hugo.toml").read_text())
        finalize_history(output, current, histories, os.environ.get("HUGO_BASEURL", config["baseURL"]))
        (output / "healthz").write_text("ok\n")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(output, destination, dirs_exist_ok=True)
        print(f"Built {len(current)} pages and {sum(map(len, histories.values()))} public revisions → {destination}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--destination", type=Path, default=Path("public"))
    parser.add_argument("--preview", action="store_true", help="Allow local, uncommitted content; never used for image publishing")
    args = parser.parse_args()
    try:
        build(args.source, args.destination, preview=args.preview)
    except (BuildError, OSError) as error:
        print(f"Build error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
