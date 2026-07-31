#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly INSTALL_DIR="${HOME:?HOME is required}/.pi/agent/bin"
readonly BINARY_PATH="$INSTALL_DIR/apply_patch"
readonly OS_NAME="$(uname -s)"
readonly SHELL_PATH="${SHELL:-}"
readonly SHELL_NAME="${SHELL_PATH##*/}"

fail() {
	printf 'init.sh: %s\n' "$1" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

case "$OS_NAME" in
	Darwin | Linux)
		;;
	*)
		fail "unsupported operating system: $OS_NAME; supported systems are Darwin and Linux"
		;;
esac

require_command go
mkdir -p "$INSTALL_DIR"

cd "$SCRIPT_DIR"
go build -o "$BINARY_PATH" .

shell_rc=''
shell_kind='posix'
case "$SHELL_NAME" in
	fish)
		shell_kind='fish'
		shell_rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
		;;
	zsh)
		shell_rc="$HOME/.zshrc"
		;;
bash)
		if [[ "$OS_NAME" == 'Darwin' && ! -e "$HOME/.bashrc" && -e "$HOME/.bash_profile" ]]; then
			shell_rc="$HOME/.bash_profile"
		else
			shell_rc="$HOME/.bashrc"
		fi
		;;
	*)
		case "$OS_NAME" in
			Darwin) shell_rc="$HOME/.zshrc" ;;
			Linux) shell_rc="$HOME/.bashrc" ;;
		esac
		;;
esac

mkdir -p "$(dirname -- "$shell_rc")"

if [[ "$shell_kind" == 'fish' ]]; then
	start_marker='# >>> apply_patch init >>>'
	end_marker='# <<< apply_patch init <<<'
	path_config='fish_add_path --move "$HOME/.pi/agent/bin"'
else
	start_marker='# >>> apply_patch init >>>'
	end_marker='# <<< apply_patch init <<<'
	path_config='case ":${PATH:-}:" in
  *:"$HOME/.pi/agent/bin":*) ;;
  *) export PATH="$HOME/.pi/agent/bin${PATH:+:$PATH}" ;;
esac'
fi

if [[ ! -f "$shell_rc" ]] || ! grep -Fqx "$start_marker" "$shell_rc"; then
	{
		printf '\n%s\n' "$start_marker"
		printf '%s\n' "$path_config"
		printf '%s\n' "$end_marker"
	} >> "$shell_rc"
fi

printf 'Built %s\n' "$BINARY_PATH"
printf 'Registered %s in %s\n' "$INSTALL_DIR" "$shell_rc"
printf 'Run: source %s\n' "$shell_rc"
