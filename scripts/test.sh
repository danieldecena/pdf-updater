#!/usr/bin/env bash
# Build the single file, regenerate fixture PDFs, run the end-to-end suite (Playwright + Chromium).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 build.py
python3 -W ignore tests/fixtures.py >/dev/null
mkdir -p tests/out
python3 -W ignore tests/suite.py
