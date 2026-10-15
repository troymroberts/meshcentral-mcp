#!/bin/sh
# Install the chat restyle on a MeshCentral server: writes
# <meshcentral>/meshcentral-web/public/styles/messenger.css (stock stylesheet +
# contrib/messenger-chat.css), which MeshCentral serves in place of its own.
# MeshCentral only notices a new meshcentral-web/public folder at startup, so
# restart it the first time. Re-run after upgrading MeshCentral.
#
# Usage: scripts/install-chat-css.sh [meshcentral install dir]   (default /opt/meshcentral)
set -eu
root="${1:-/opt/meshcentral}"
stock="$root/node_modules/meshcentral/public/styles/messenger.css"
dest="$root/meshcentral-web/public/styles"
add="$(dirname "$0")/../contrib/messenger-chat.css"

[ -f "$stock" ] || { echo "MeshCentral stylesheet not found: $stock" >&2; exit 1; }
mkdir -p "$dest"
cat "$stock" "$add" > "$dest/messenger.css"
echo "Wrote $dest/messenger.css"
