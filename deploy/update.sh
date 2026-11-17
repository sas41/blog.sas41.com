#!/bin/sh
# Run from anywhere. Intended for your existing deployment hook or scheduler.
# Only the immutable blog is updated; Remark42 updates remain deliberate.
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
docker compose -f compose.production.yaml pull blog
docker compose -f compose.production.yaml up -d --no-deps --wait blog
