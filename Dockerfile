# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM python:3.13-alpine AS tools
ARG BUILDARCH
ARG HUGO_VERSION=0.170.0
WORKDIR /src
RUN apk add --no-cache git ca-certificates \
    && case "$BUILDARCH" in amd64|arm64) ;; *) echo "Unsupported build architecture: $BUILDARCH"; exit 1 ;; esac \
    && wget -q "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_linux-${BUILDARCH}.tar.gz" -O /tmp/hugo.tar.gz \
    && wget -q "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_checksums.txt" -O /tmp/checksums.txt \
    && HUGO_ARCHIVE="hugo_${HUGO_VERSION}_linux-${BUILDARCH}.tar.gz" \
    && EXPECTED="$(grep "  ${HUGO_ARCHIVE}\$" /tmp/checksums.txt | cut -d ' ' -f 1)" \
    && test -n "$EXPECTED" \
    && echo "$EXPECTED  /tmp/hugo.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/hugo.tar.gz -C /usr/local/bin hugo \
    && rm /tmp/hugo.tar.gz /tmp/checksums.txt
COPY requirements-build.txt ./
RUN pip install --no-cache-dir -r requirements-build.txt
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN git config --global --add safe.directory /src

# Docker is only an optional local preview. GitHub Pages hosts the static build.
FROM tools AS development
COPY . .
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')" || exit 1
CMD ["python", "scripts/serve.py", "--bind", "0.0.0.0", "--port", "8080"]
