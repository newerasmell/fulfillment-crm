#!/usr/bin/env bash
# Re-downloads the vendor API specs, re-renders the markdown references and shows what changed.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=docs/integrations/raw
TMP=$(mktemp -d)
curl -fsS -m 60 https://api.fhb.sk/v3/openapi  -o "$TMP/v3.json"
curl -fsS -m 60 https://api.fhb.sk/joy/openapi -o "$TMP/joy.json"
curl -fsS -m 60 "https://documenter.gw.postman.com/api/collections/26992907/2s93Y2S2Q8?segregateAuth=true&versionTag=latest" -o "$TMP/eu.json"
python3 -c "import json,sys;json.dump(json.load(open(sys.argv[1])),open(sys.argv[2],'w'),indent=1,ensure_ascii=False)" "$TMP/v3.json"  "$RAW/fhb-kika-v3.openapi.json"
python3 -c "import json,sys;json.dump(json.load(open(sys.argv[1])),open(sys.argv[2],'w'),indent=1,ensure_ascii=False)" "$TMP/joy.json" "$RAW/fhb-joy.openapi.json"
python3 -c "import json,sys;json.dump(json.load(open(sys.argv[1])),open(sys.argv[2],'w'),indent=1,ensure_ascii=False)" "$TMP/eu.json"  "$RAW/eushipments.postman_collection.json"
python3 tools/render_docs.py
rm -rf "$TMP"
if command -v git >/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
  git --no-pager diff --stat -- docs/integrations
else
  echo "Not a git repo: commit docs/integrations to track changes."
fi
