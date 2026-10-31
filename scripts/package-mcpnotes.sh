#!/usr/bin/env bash
# Builds plugin/release-assets/MeshCentral-MCPNotes.zip (the config.json downloadUrl) with every
# entry under mcpnotes/ and '/' separators, as the MeshCentral plugin installer expects.
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
src="$project/plugin/mcpnotes"
out="$project/plugin/release-assets"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/mcpnotes/lib" "$out"
cp "$src/mcpnotes.js" "$src/config.json" "$src/package.json" "$src/README.md" "$stage/mcpnotes/"
cp "$src/lib/notes.js" "$stage/mcpnotes/lib/"
archive="$out/MeshCentral-MCPNotes.zip"
rm -f "$archive"
# Directory entries are required: MeshCentral 1.3.0's installer only creates folders for explicit
# "dir/" entries and crashes (ENOENT, unhandled stream error) on a file in a missing folder.
(cd "$stage" && TZ=UTC find mcpnotes -exec touch -t 202601010000 {} + && find mcpnotes | sort | zip -X -q -9 "$archive" -@)
echo "$archive"
