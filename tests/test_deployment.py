"""GitHub Pages publishes static files; Docker is local preview only."""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


class DeploymentTest(unittest.TestCase):
    def test_pages_workflow_preserves_history_and_never_publishes_containers(self):
        path = ROOT / ".github/workflows/pages.yaml"
        text = path.read_text()
        workflow = yaml.load(text, Loader=yaml.BaseLoader)
        self.assertIn("push", workflow["on"])
        self.assertIn("pull_request", workflow["on"])
        self.assertEqual(workflow["on"]["push"]["branches"], ["main"])
        steps = workflow["jobs"]["build"]["steps"]
        checkout = next(step for step in steps if step.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual(checkout["with"]["fetch-depth"], "0")
        self.assertEqual(checkout["with"]["persist-credentials"], "false")
        commands = "\n".join(step.get("run", "") for step in steps)
        self.assertIn("python -m unittest discover -s tests -v", commands)
        self.assertIn("node --test tests/*.test.cjs", commands)
        self.assertIn("python scripts/build.py --destination public", commands)
        self.assertNotIn("--preview", commands)
        self.assertNotIn("docker ", commands)
        upload = next(step for step in steps if step.get("uses", "").startswith("actions/upload-pages-artifact@"))
        self.assertEqual(upload["with"]["path"], "public")
        deploy = workflow["jobs"]["deploy"]
        self.assertIn("github.event_name != 'pull_request'", deploy["if"])
        self.assertIn("github.ref == 'refs/heads/main'", deploy["if"])
        self.assertEqual(deploy["permissions"], {"pages": "write", "id-token": "write"})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertFalse(any((ROOT / ".forgejo/workflows").glob("*.y*ml")))

    def test_pages_domain_matches_hugo_and_jekyll_is_disabled(self):
        import tomllib

        domain = (ROOT / "static/CNAME").read_text().strip()
        config = tomllib.loads((ROOT / "hugo.toml").read_text())
        workflow = yaml.load((ROOT / ".github/workflows/pages.yaml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(domain, "blog.sas41.com")
        self.assertEqual(config["baseURL"], f"https://{domain}/")
        self.assertEqual(workflow["env"]["HUGO_BASEURL"], config["baseURL"])
        self.assertTrue((ROOT / "static/.nojekyll").is_file())

    def test_docker_remains_local_only(self):
        compose = yaml.safe_load((ROOT / "compose.yaml").read_text())
        self.assertEqual(set(compose["services"]), {"blog"})
        self.assertEqual(compose["services"]["blog"]["build"]["target"], "development")
        self.assertNotIn("AS production", (ROOT / "Dockerfile").read_text())
        self.assertFalse((ROOT / "compose.production.yaml").exists())
