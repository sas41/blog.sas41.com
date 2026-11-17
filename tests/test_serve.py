"""Preview watcher tests; do not require Hugo or Docker."""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_build import builder


SPEC = importlib.util.spec_from_file_location("blog_serve", Path(__file__).resolve().parents[1] / "scripts" / "serve.py")
preview = importlib.util.module_from_spec(SPEC)
with patch.dict(sys.modules, {"build": builder}):
    SPEC.loader.exec_module(preview)


class PreviewTest(unittest.TestCase):
    def test_preview_defaults_to_local_base_url(self):
        with patch.dict(os.environ, {}, clear=True):
            preview.configure_environment(9000)
            self.assertEqual(os.environ["HUGO_BASEURL"], "http://localhost:9000/")
            self.assertEqual(set(os.environ), {"HUGO_BASEURL"})

    def test_preview_preserves_explicit_base_url(self):
        with patch.dict(os.environ, {"HUGO_BASEURL": "https://preview.example.test/"}, clear=True):
            preview.configure_environment(9000)
            self.assertEqual(os.environ["HUGO_BASEURL"], "https://preview.example.test/")

    def test_watcher_tracks_source_additions_edits_and_deletions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "content").mkdir()
            initial = preview.fingerprint(root)
            post = root / "content" / "post.md"
            post.write_text("First")
            added = preview.fingerprint(root)
            self.assertNotEqual(initial, added)
            post.write_text("Changed content")
            self.assertNotEqual(added, preview.fingerprint(root))
            post.unlink()
            self.assertEqual(initial, preview.fingerprint(root))

    def test_failed_rebuild_preserves_last_good_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "public"

            def render(source, destination, *, preview):
                self.assertTrue(preview)
                (destination / "index.html").write_text("First build")

            with patch.object(preview, "build", side_effect=render):
                self.assertTrue(preview.rebuild(root, output))
            original = output.resolve()
            with patch.object(preview, "build", side_effect=builder.BuildError("Invalid edit")):
                self.assertFalse(preview.rebuild(root, output))
            self.assertEqual(output.resolve(), original)
            self.assertEqual((output / "index.html").read_text(), "First build")
            with patch.object(preview, "build", side_effect=render):
                self.assertTrue(preview.rebuild(root, output))
            self.assertNotEqual(output.resolve(), original)
            self.assertFalse(original.exists())
            self.assertEqual(len(list(root.iterdir())), 2)
