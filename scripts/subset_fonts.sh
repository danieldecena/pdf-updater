#!/usr/bin/env bash
# Regenerate fonts/ (Latin subsets of Carlito and Liberation, all SIL OFL) used for redrawn text.
# Needs fonttools (pip install fonttools) and the fonts installed (fonts-crosextra-carlito, fonts-liberation).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p fonts
U="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2010-2027,U+2030-203A,U+20AC,U+2122,U+2190-2193,U+2022,U+2610-2612,U+25A1"
for f in /usr/share/fonts/truetype/crosextra/Carlito-{Regular,Bold}.ttf /usr/share/fonts/truetype/liberation/Liberation{Sans,Serif}-{Regular,Bold}.ttf; do
  pyftsubset "$f" --unicodes="$U" --layout-features='kern,liga' --output-file="fonts/$(basename "$f")"
done
