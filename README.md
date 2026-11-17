# blog.sas41.com

A static personal blog built with Hugo and hosted on GitHub Pages. Production
contains only generated HTML, CSS, JavaScript, and assets—no backend, database,
container registry, or production Docker image.

## Local preview

```sh
docker compose up --build -d
```

Open <http://localhost:8081/>. Set `BLOG_PORT` in `.env` to use another port.
The preview rebuilds when source files change; refresh the browser to see updates.

Alternatively, with Hugo and the Python build dependencies installed:

```sh
python3 -m pip install -r requirements-build.txt
python3 scripts/serve.py --port 8081
```

Reading preferences, revision history, search/filtering, RSS, and click-to-load
external embeds remain available. Article text and revision archive pages can
also be read without JavaScript.

## GitHub Pages deployment

The GitHub-only workflow at `.github/workflows/pages.yaml`:

1. Checks out the full Git history, which is required for article revisions.
2. Installs the pinned Hugo version and Python build dependencies.
3. Runs the Python and JavaScript tests.
4. Builds the static site into `public/` using `scripts/build.py`.
5. Uploads a Pages artifact and deploys it on pushes to `main` or manual runs.

Pull requests build and test the site but do not deploy it. There are no Forgejo
workflows, registry credentials, deployment webhooks, or Docker publishing steps.

### One-time GitHub and DNS setup

In [the GitHub repository](https://github.com/sas41/blog.sas41.com):

1. Under **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
2. Set the custom domain to **blog.sas41.com**. `static/CNAME` and `hugo.toml`
   already use that domain. Verify the domain under your GitHub account settings
   if it is not already verified.
3. Point the DNS `CNAME` for `blog` at **sas41.github.io** (not the repository URL).
   Remove conflicting DNS records for that hostname. Use DNS-only mode initially
   if your DNS provider offers a proxy, until GitHub's domain/TLS checks succeed.
4. Enable **Enforce HTTPS** once GitHub has issued the certificate.

The root-relative routes and assets assume the custom domain; the default
`sas41.github.io/blog.sas41.com/` project URL is not the intended hosting path.
GitHub Pages controls response headers; the former nginx/proxy configuration
does not apply. If you need custom security or cache headers later, they must
be configured at an external proxy/CDN.

### Build locally without Docker

Install Hugo **0.170.0** and the dependencies in `requirements-build.txt`.
Commit content changes before a production build so published pages match
their Git-backed revision history:

```sh
python3 scripts/build.py --destination public
```

Use a new/empty output directory for each build. Local uncommitted content can
be rendered with `--preview`; the deployment workflow never uses that flag.

## Git remote

This checkout uses GitHub as its only remote:

```sh
git remote -v
# origin https://github.com/sas41/blog.sas41.com.git (fetch/push)

git push -u origin main
```

After the first successful push establishes the upstream, `git push` is enough.
Authenticate through your Git credential manager or GitHub CLI; no token should
be stored in a remote URL. Pushes are not mirrored to the former Forgejo remote.

## Tests

```sh
python3 -m unittest discover -s tests -v
node --test tests/*.test.cjs
```

Full rendering tests require Hugo; Python build dependencies are listed in
`requirements-build.txt`.
