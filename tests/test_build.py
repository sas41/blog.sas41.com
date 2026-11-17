"""Standard-library tests, including a real Hugo build when Hugo is available."""

from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("blog_build", PROJECT / "scripts" / "build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
NOW = datetime(2026, 11, 17, tzinfo=timezone.utc)


class HistoryRenderingTest(unittest.TestCase):
    def test_history_emits_slider_fragments_and_scriptless_fallback_pages(self):
        with tempfile.TemporaryDirectory(prefix="blog-history-test-") as temp:
            output = Path(temp)
            (output / "index.html").write_text('<link rel="stylesheet" href="/css/site.abc.css"><section data-history-manifest="/__history_manifest__/test-post/"></section>')
            render = output / "__render" / "test-post" / "0"
            render.mkdir(parents=True)
            (render / "index.html").write_text('<h1>Test post</h1>')
            metadata = {"url": "/test-post/", "title": "Test post"}
            current = {"test-post": {"metadata": metadata}}
            histories = {"test-post": [{"metadata": metadata, "date": "2026-11-17T12:34:56Z"}]}
            builder.finalize_history(output, current, histories, "https://example.test/")
            archive = output / "history" / "test-post"
            self.assertTrue((archive / "index.html").exists())
            self.assertEqual(len(list(archive.glob("*.page.html"))), 1)
            manifest = json.loads(next(archive.glob("*.json")).read_text())
            self.assertEqual(manifest["revisions"][0]["date"], "2026-11-17T12:34:56Z")
            full = output / manifest["revisions"][0]["page"].lstrip("/")
            self.assertEqual(full.name.split(".")[0], hashlib.sha256(full.read_bytes()).hexdigest())
            for path in [archive / "index.html", full]:
                page = path.read_text()
                self.assertIn('<time class="mono" datetime="2026-11-17T12:34:56Z">2026-11-17 12:34:56 UTC</time>', page)
                self.assertIn('<link rel="stylesheet" href="/css/site.abc.css">', page)
                self.assertIn('<meta name="robots" content="noindex,follow">', page)
                self.assertIn('<base href="/test-post/">', page)
                self.assertIn('<body class="is-reading-page history-page">', page)
                self.assertIn('<div class="reading-layout"><article class="post">', page)
                self.assertIn('href="/index.xml"', page)
                self.assertNotIn('<script', page)
            self.assertIn(manifest["revisions"][0]["page"], (archive / "index.html").read_text())
            self.assertIn('<header class="article-heading">', (archive / "index.html").read_text())
            self.assertIn('<ol class="history-list">', (archive / "index.html").read_text())
            self.assertIn('<span class="history-current">Latest</span>', (archive / "index.html").read_text())
            self.assertIn('<h1>Test post</h1>', full.read_text())
            fragment = output / manifest["revisions"][0]["fragment"].lstrip("/")
            self.assertEqual(fragment.read_text(), '<h1>Test post</h1>')
            self.assertEqual(fragment.stem, hashlib.sha256(fragment.read_bytes()).hexdigest())
            self.assertNotIn("__history_manifest__", (output / "index.html").read_text())
            self.assertFalse((output / "__render").exists())


class RepositoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="blog-test-")
        self.root = Path(self.temporary.name)
        (self.root / "content" / "posts").mkdir(parents=True)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Private Author")
        self.git("config", "user.email", "private-author@example.invalid")
        self.counter = 0

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *args, env=None):
        return builder.run("git", *args, cwd=self.root, env=env)

    def commit(self, message="private commit message"):
        self.counter += 1
        self.git("add", ".")
        env = os.environ.copy()
        stamp = f"2026-01-{self.counter:02d}T12:00:00+00:00"
        env.update(GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
        self.git("commit", "-m", message, env=env)

    def post(self, body="Original content.", *, identifier="test-post", url="/test-post/", extra="", name="test.md", title="Test post"):
        path = self.root / "content" / "posts" / name
        path.write_text(f'---\nid: {identifier}\ncategory: Software\ntitle: "{title}"\nurl: {url}\n{extra}---\n\n{body}\n')
        return path

    def history(self):
        current = builder.read_current(self.root, NOW)
        return current, builder.collect_history(self.root, current, now=NOW)

    def test_revision_count_dates_and_unrelated_commits(self):
        self.post()
        self.commit()
        (self.root / "notes.txt").write_text("not a post")
        self.commit()
        self.post("Edited content.")
        self.commit()
        _, history = self.history()
        revisions = history["test-post"]
        self.assertEqual(len(revisions), 2)
        self.assertEqual(revisions[0]["date"], "2026-01-01T12:00:00Z")
        self.assertEqual(revisions[-1]["date"], "2026-01-03T12:00:00Z")

    def test_stable_id_survives_file_and_url_changes(self):
        original = self.post()
        self.commit()
        original.rename(original.with_name("renamed.md"))
        self.commit()
        self.post("Edited.", name="renamed.md", url="/new-url/")
        self.commit()
        current, history = self.history()
        self.assertEqual(current["test-post"]["metadata"]["url"], "/new-url/")
        self.assertEqual(len(history["test-post"]), 2)

    def test_drafts_do_not_leak_into_published_history(self):
        self.post("SECRET_DRAFT", extra="draft: true\n")
        self.commit()
        self.post("Public version.")
        self.commit()
        self.post("SECRET_LATER_DRAFT", extra="draft: true\n")
        self.commit()
        self.post("Public edited version.")
        self.commit()
        _, history = self.history()
        self.assertEqual(len(history["test-post"]), 2)
        self.assertNotIn("SECRET", repr(history))

    def test_private_side_branch_commits_are_not_exported(self):
        self.post()
        self.commit()
        self.git("checkout", "-b", "draft-work")
        self.post("PRIVATE_INTERMEDIATE")
        self.commit()
        self.post("Final merged version.")
        self.commit()
        self.git("checkout", "main")
        env = os.environ.copy()
        env.update(GIT_AUTHOR_DATE="2026-01-04T12:00:00+00:00", GIT_COMMITTER_DATE="2026-01-04T12:00:00+00:00")
        self.git("merge", "--no-ff", "draft-work", "-m", "publish", env=env)
        _, history = self.history()
        self.assertEqual(len(history["test-post"]), 2)
        self.assertNotIn("PRIVATE_INTERMEDIATE", repr(history))

    def test_correcting_invalid_historical_front_matter_unblocks_builds(self):
        path = self.post()
        path.write_text("MALFORMED_PRIVATE_OLD_SOURCE")
        self.commit()
        self.post("A valid published version.")
        self.commit()
        _, history = self.history()
        self.assertEqual(len(history["test-post"]), 1)
        self.assertNotIn("MALFORMED_PRIVATE_OLD_SOURCE", repr(history))

    def test_future_and_unpublished_posts_are_excluded(self):
        self.post("Not yet.", extra="publishDate: 2099-01-01\n")
        self.assertEqual(builder.read_current(self.root, NOW), {})

    def test_scheduled_post_can_be_built_when_due_without_another_commit(self):
        self.post("PRIVATE_BEFORE_PUBLICATION", extra="publishDate: 2026-03-01\n")
        self.commit()
        self.post("Scheduled final version.", extra="publishDate: 2026-03-01\n")
        self.commit()
        _, history = self.history()
        self.assertEqual(len(history["test-post"]), 1)
        self.assertEqual(history["test-post"][0]["date"], "2026-03-01T00:00:00Z")
        self.assertNotIn("PRIVATE_BEFORE_PUBLICATION", repr(history))

    def test_duplicate_ids_and_urls_are_rejected(self):
        self.post()
        self.post(name="another.md", url="/different/")
        with self.assertRaisesRegex(builder.BuildError, "Duplicate page id"):
            builder.read_current(self.root, NOW)
        self.post(name="another.md", identifier="another")
        with self.assertRaisesRegex(builder.BuildError, "Duplicate URL"):
            builder.read_current(self.root, NOW)

    def test_published_posts_require_one_category(self):
        path = self.post()
        path.write_text(path.read_text().replace("category: Software\n", ""))
        with self.assertRaisesRegex(builder.BuildError, "one category is required"):
            builder.read_current(self.root, NOW)
        path.write_text(path.read_text().replace("id: test-post", "id: test-post\ndraft: true"))
        self.assertEqual(builder.read_current(self.root, NOW), {})

    def test_dirty_production_content_is_rejected(self):
        self.post()
        self.commit()
        self.post("Uncommitted edits.")
        with self.assertRaisesRegex(builder.BuildError, "Commit content changes"):
            self.history()
        pages = builder.read_current(self.root, NOW)
        history = builder.collect_history(self.root, pages, preview=True, now=NOW)
        self.assertEqual(len(history["test-post"]), 2)

    def test_shallow_checkout_is_rejected(self):
        self.post()
        self.commit()
        self.post("Second version.")
        self.commit()
        with tempfile.TemporaryDirectory(prefix="blog-shallow-") as temp:
            clone = Path(temp) / "clone"
            builder.run("git", "clone", "--depth", "1", self.root.as_uri(), str(clone), cwd=self.root)
            current = builder.read_current(clone, NOW)
            with self.assertRaisesRegex(builder.BuildError, "Full Git history"):
                builder.collect_history(clone, current, now=NOW)

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_complete_static_build(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        shutil.copyfile(PROJECT / "content" / "_index.md", self.root / "content" / "_index.md")
        self.post("TOP_SECRET_DRAFT", extra="draft: true\n")
        self.commit()
        self.post("First **published** version.", extra="social:\n  title: Share title\n  description: Share description\n")
        self.commit()
        self.post('Second version.\n\n{{< callout title="Note" >}}A rich component.{{< /callout >}}', url="/new-url/", extra="aliases:\n  - /test-post/\n")
        self.commit()
        output = self.root / "output"
        builder.build(self.root, output)
        page = (output / "new-url" / "index.html").read_text()
        self.assertIn("Posted", page)
        self.assertIn("2026-01-02", page)
        self.assertIn("Last Edited", page)
        self.assertIn("2026-01-03", page)
        self.assertNotIn('data-comments-', page)
        self.assertIn("A rich component.", page)
        self.assertIn('rel="canonical" href="https://blog.sas41.com/new-url/"', page)
        self.assertIn('data-reader-toolbar', page)
        self.assertIn('data-reader-dock', page)
        self.assertIn('aria-label="SAS41 home"', page)
        self.assertIn('class="wordmark-logo" aria-hidden="true"', page)
        self.assertTrue((output / "logo.svg").is_file())
        self.assertEqual((output / "CNAME").read_text().strip(), "blog.sas41.com")
        self.assertTrue((output / ".nojekyll").is_file())
        self.assertEqual(page.count('class="reader-icon"'), 3)
        self.assertIn('data-reader-panel="font"', page)
        self.assertIn('data-reader-panel="size"', page)
        self.assertIn('data-reader-panel="theme"', page)
        for panel in ("font", "size", "theme"):
            markup = re.search(rf'<section[^>]*data-reader-panel="{panel}"[^>]*>(.*?)</section>', page, re.DOTALL)
            self.assertIsNotNone(markup)
            self.assertIn('data-reader-reset>Reset reading preferences</button>', markup.group(1))
        self.assertNotIn('Questions, corrections', page)
        self.assertNotIn('Words, versioned', page)
        self.assertIn('Powered by Hugo</span>', page)
        self.assertNotIn('Powered by Hugo, NGINX', page)
        self.assertNotIn('document-map-hint', page)
        self.assertIn('data-document-map', page)
        self.assertIn('<details class="document-map-inner" data-document-map-disclosure>', page)
        self.assertIn('id="document-map-heading" aria-label="On this post"', page)
        self.assertIn('class="document-map-logo"', page)
        self.assertLess(page.index('data-document-map-disclosure'), page.index('<article class="post"'))
        self.assertIn('data-heading-trail', page)
        self.assertIn('href="/categories/software/"', page)
        self.assertIn('aria-label="Breadcrumb"', page)
        self.assertIn('reader-settings.', page)
        self.assertTrue((output / "categories" / "software" / "index.html").exists())
        category = (output / "categories" / "software" / "index.html").read_text()
        self.assertIn('href="/new-url/"', category)
        self.assertNotIn('__render', category)
        css_path = re.search(r'<link rel="stylesheet" href="([^"]+)"', page).group(1)
        css = (output / css_path.lstrip('/')).read_text()
        self.assertNotIn('.has-reader-controls .site-header > .wordmark', css)
        self.assertNotIn('.has-reader-controls .site-header > nav', css)
        self.assertIn("mask:url('/logo.svg')", css)
        self.assertIn('--brand-red:#8b1e24', css)
        self.assertRegex(css, r'\.wordmark-logo\{[^}]*background-color:var\(--brand-red\)')
        self.assertIn('@media (min-width: 1024px)', css)
        self.assertIn('--reader-reserved: 448px', css)
        self.assertIn('@media (min-width: 1280px)', css)
        self.assertIn("--reader-reserved: 240px", css)
        self.assertNotIn('.document-map { display: none;', css)
        for font_path in re.findall(r'url\((/fonts/[^)]+)\)', css):
            font = output / font_path.lstrip('/')
            self.assertTrue(font.exists(), font_path)
            self.assertEqual(font.read_bytes()[:4], b'wOF2')
        manifest_path = re.search(r'data-history-manifest="([^"]+)"', page).group(1)
        self.assertNotIn("__history_manifest__", manifest_path)
        manifest_text = (output / manifest_path.lstrip("/")).read_text()
        self.assertEqual(Path(manifest_path).stem, hashlib.sha256(manifest_text.encode()).hexdigest())
        manifest = json.loads(manifest_text)
        self.assertEqual(len(manifest["revisions"]), 2)
        for item in manifest["revisions"]:
            fragment = (output / item["fragment"].lstrip("/")).read_bytes()
            self.assertEqual(Path(item["fragment"]).stem, hashlib.sha256(fragment).hexdigest())
            full = (output / item["page"].lstrip("/")).read_bytes()
            self.assertEqual(Path(item["page"]).name.split(".")[0], hashlib.sha256(full).hexdigest())
        self.assertTrue((output / "history" / "test-post" / "index.html").exists())
        self.assertTrue((output / "p" / "test-post" / "index.html").exists())
        self.assertTrue((output / "test-post" / "index.html").exists())
        self.assertFalse((output / "__render").exists())
        self.assertFalse((output / ".git").exists())
        sitemap = (output / "sitemap.xml").read_text()
        feed = (output / "index.xml").read_text()
        self.assertNotIn("__render", sitemap + feed)
        self.assertNotIn("/history/", sitemap + feed)
        for path in output.rglob("*"):
            if path.is_file() and path.suffix in {".html", ".json", ".xml"}:
                text = path.read_text()
                self.assertNotIn("TOP_SECRET_DRAFT", text)
                self.assertNotIn("private-author@example.invalid", text)
                self.assertNotIn("private commit message", text)

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_static_reading_and_noscript_fallbacks(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        body = ('## A readable section\n\nOrdinary article text.\n\n'
                '{{< embed src="https://example.com/content" title="External example" >}}\n\n'
                '{{< youtube id="dQw4w9WgXcQ" >}}')
        self.post(body, extra="tags: software\n")
        self.commit()
        self.post(body + "\n\nAn edited paragraph.", extra="tags: software\n")
        self.commit()
        output = self.root / "output"
        builder.build(self.root, output)
        page = (output / "test-post" / "index.html").read_text()
        self.assertIn('id="a-readable-section"', page)
        self.assertIn('href="#a-readable-section"', page)
        self.assertIn("Ordinary article text.", page)
        self.assertIn('href="/history/test-post/" data-history-toggle>Last Edited', page)
        self.assertNotIn('history-fallback', page)
        self.assertNotIn('disabled>Last Edited', page)
        self.assertIn('href="/tags/software/"', page)
        self.assertNotIn('data-load-comments', page)
        self.assertEqual(page.count('data-load-embed hidden'), 2)
        self.assertIn('<noscript><a href="https://example.com/content">Open external content</a></noscript>', page)
        self.assertIn('<noscript><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Watch on YouTube</a></noscript>', page)
        home = (output / "index.html").read_text()
        self.assertIn('<noscript><p class="filter-help"><a href="/tags/">', home)
        archive = (output / "history" / "test-post" / "index.html").read_text()
        self.assertNotIn('<script', archive)
        manifest_path = re.search(r'data-history-manifest="([^"]+)"', page).group(1)
        manifest = json.loads((output / manifest_path.lstrip("/")).read_text())
        self.assertEqual(len(manifest["revisions"]), 2)
        for revision in manifest["revisions"]:
            historical = (output / revision["fragment"].lstrip("/")).read_text()
            self.assertIn("Ordinary article text.", historical)
            self.assertNotIn("<!doctype", historical.lower())
            fallback = (output / revision["page"].lstrip("/")).read_text()
            self.assertIn(revision["page"], archive)
            self.assertIn("Ordinary article text.", fallback)
            self.assertIn('href="/test-post/"', fallback)
            self.assertNotIn('<script', fallback)

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_local_preview_urls_and_uncommitted_content(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        self.post("Committed version")
        self.commit()
        self.post("Local uncommitted version")
        output = self.root / "output"
        with patch.dict(os.environ, HUGO_BASEURL="http://localhost:9000/"):
            builder.build(self.root, output, preview=True)
        page = (output / "test-post" / "index.html").read_text()
        self.assertIn("Local uncommitted version", page)
        self.assertIn('rel="canonical" href="http://localhost:9000/test-post/"', page)
        archive = (output / "history" / "test-post" / "index.html").read_text()
        self.assertIn('rel="canonical" href="http://localhost:9000/test-post/"', archive)
        self.assertNotIn("https://blog.sas41.com/", archive)
        manifest_path = re.search(r'data-history-manifest="([^"]+)"', page).group(1)
        manifest = json.loads((output / manifest_path.lstrip("/")).read_text())
        self.assertEqual(len(manifest["revisions"]), 2)
        for revision in manifest["revisions"]:
            self.assertTrue(revision["fragment"].startswith("/history/test-post/"))

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_static_blog_has_no_comment_integration(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        self.post("A static article")
        self.commit()
        output = self.root / "output"
        builder.build(self.root, output, preview=True)
        page = (output / "test-post" / "index.html").read_text()
        self.assertNotIn('data-comments-', page)
        self.assertNotIn('data-load-comments', page)
        self.assertNotIn('The conversation', page)
        self.assertFalse((output / 'css/comments.css').exists())
        for path in output.rglob('*'):
            if path.is_file() and path.suffix in {'.html', '.js', '.css'}:
                text = path.read_text()
                for dependency in ('Artalk', 'comentario', 'remark42', 'challenges.cloudflare.com'):
                    self.assertNotIn(dependency, text, str(path))

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_tags_build_current_post_archives_only(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        self.post(extra="tags: obsolete-tag\n")
        self.commit()
        self.post(extra="tags: Software, systems, software,  \n")
        self.post(identifier="another", url="/another/", name="another.md", extra="tags: [systems, 'long tag']\n")
        self.post(identifier="draft", url="/draft/", name="draft.md", extra="draft: true\ntags: secret-draft-tag\n")
        pages = self.root / "content" / "pages"
        pages.mkdir()
        (pages / "info.md").write_text('---\nid: info\ntitle: Info\nurl: /info/\ntags: page-only-tag\n---\nInfo')
        self.commit()
        output = self.root / "output"
        builder.build(self.root, output)
        home = (output / "index.html").read_text()
        post = (output / "test-post" / "index.html").read_text()
        self.assertIn('data-post-tags="[&#34;Software&#34;,&#34;systems&#34;]"', home)
        self.assertIn('data-filter-form hidden', home)
        self.assertIn('data-filter-search', home)
        self.assertIn('data-filter-tags', home)
        self.assertIn('href="/tags/software/"', post)
        self.assertIn('href="/tags/long-tag/"', home)
        archive = (output / "tags" / "systems" / "index.html").read_text()
        self.assertIn('href="/test-post/"', archive)
        self.assertIn('href="/another/"', archive)
        self.assertNotIn('/__render/', archive)
        self.assertNotIn('/history/', archive)
        self.assertTrue((output / "tags" / "index.html").is_file())
        for tag in ("obsolete-tag", "secret-draft-tag", "page-only-tag"):
            self.assertFalse((output / "tags" / tag).exists())

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_licenses_page_and_footer(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        pages = self.root / "content" / "pages"
        pages.mkdir()
        shutil.copyfile(PROJECT / "content" / "pages" / "licenses.md", pages / "licenses.md")
        self.post()
        self.commit()
        output = self.root / "output"
        builder.build(self.root, output)
        page = (output / "licenses" / "index.html").read_text()
        self.assertIn('href="/licenses/">Licenses</a>', page)
        post = (output / "test-post" / "index.html").read_text()
        self.assertIn('href="/licenses/">Licenses</a>', post)
        self.assertNotIn('data-comments-widget', page)
        for name in ("Source Sans 3", "Inter", "Source Serif 4", "Atkinson Hyperlegible", "Lucide"):
            self.assertIn(name, page)
        notices = re.findall(r'href="(/(?:fonts|licenses)/[^"#]+\.txt)"', page)
        self.assertEqual(len(notices), 5)
        for notice in notices:
            self.assertTrue((output / notice.lstrip("/")).is_file(), notice)

    @unittest.skipUnless(shutil.which("hugo"), "Hugo not installed")
    def test_first_revision_has_no_slider(self):
        for directory in ("layouts", "assets", "static"):
            shutil.copytree(PROJECT / directory, self.root / directory)
        shutil.copyfile(PROJECT / "hugo.toml", self.root / "hugo.toml")
        self.post()
        self.commit()
        output = self.root / "output"
        builder.build(self.root, output)
        text = (output / "test-post" / "index.html").read_text()
        self.assertNotIn("Last Edited", text)
        self.assertNotIn("revision-panel", text)
        self.assertNotIn('data-comments-widget', text)


class FrontMatterTest(unittest.TestCase):
    def test_hugo_configuration_is_valid_toml(self):
        import tomllib

        config = tomllib.loads((PROJECT / "hugo.toml").read_text())
        self.assertIsInstance(config["title"], str)
        self.assertTrue(config["title"].strip())

    def test_markdown_supports_superscript_and_trusted_html(self):
        import tomllib

        config = tomllib.loads((PROJECT / "hugo.toml").read_text())
        goldmark = config["markup"]["goldmark"]
        self.assertTrue(goldmark["extensions"]["extras"]["superscript"]["enable"])
        self.assertTrue(goldmark["renderer"]["unsafe"])

    def test_comma_separated_and_list_tags(self):
        self.assertEqual(builder.normalize_tags(" Software, systems, software, , long tag ", "test"),
                         ["Software", "systems", "long tag"])
        self.assertEqual(builder.normalize_tags(["Software", "systems, Software"], "test"),
                         ["Software", "systems"])
        self.assertEqual(builder.normalize_tags(None, "test"), [])
        for value in (42, {"tag": "value"}, ["valid", 42], "a/b", "a\\b", "a\nb", "x" * 81):
            with self.subTest(value=value), self.assertRaises(builder.BuildError):
                builder.normalize_tags(value, "test")
        metadata, _ = builder.parse_document('---\ntags: Software, systems\n---\n', "test")
        self.assertEqual(metadata["tags"], ["Software", "systems"])

    def test_dangerous_or_reserved_urls(self):
        for value in ("//evil.example/", "https://evil.example/", "/../test/", "/test/?x=1", "/history/test/", "/assets/test/", "/tags/", "/tags/software/", "/p/another/", "/%2e%2e/", "/no-trailing-slash", "/"):
            with self.subTest(value=value), self.assertRaises(builder.BuildError):
                builder.validate_url(value, "test", stable_id="test")
        self.assertEqual(builder.validate_url("/writing/test/", "test"), "/writing/test/")

    def test_front_matter_and_date_validation(self):
        with self.assertRaises(builder.BuildError):
            builder.parse_document("No front matter", "test")
        with self.assertRaises(builder.BuildError):
            builder.instant("not-a-date")
        self.assertEqual(builder.iso(builder.instant("2026-01-02T03:00:00+03:00")), "2026-01-02T00:00:00Z")
        with self.assertRaises(builder.BuildError):
            builder.published({"draft": "false"}, NOW)


if __name__ == "__main__":
    unittest.main()
