#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME:?HOME is required}/.pi/agent}"
readonly INSTALL_DIR="$AGENT_DIR/bin"
readonly BINARY_PATH="$INSTALL_DIR/pi-sub"

command -v install >/dev/null 2>&1 || {
	printf 'init.sh: required command is unavailable: install\n' >&2
	exit 1
}

mkdir -p "$INSTALL_DIR"
install -m 0755 "$SCRIPT_DIR/pi-sub" "$BINARY_PATH"
printf 'Installed %s\n' "$BINARY_PATH"
