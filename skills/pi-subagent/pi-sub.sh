#!/usr/bin/env bash

set -euo pipefail

readonly PROGRAM_NAME="${0##*/}"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_PATH="$SCRIPT_DIR/${BASH_SOURCE[0]##*/}"
readonly DEFAULT_RUNTIME_ROOT="${TMPDIR:-/tmp}/pi-subagent-$UID"
readonly RUN_ROOT="${PI_SUB_RUN_DIR:-$DEFAULT_RUNTIME_ROOT}"
readonly AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME:?HOME is required}/.pi/agent}"
readonly LOCK_ROOT="$AGENT_DIR/processes/pi-subagent-locks"
readonly DEFAULT_MODEL="${PI_SUB_DEFAULT_MODEL:-deepseek-v4-flash}"

usage() {
	cat <<EOF
Usage:
  $PROGRAM_NAME <alias> [pi arguments...]  Start a subagent in the background
  $PROGRAM_NAME --status <run-id>          Show queued, running, complete, or lost
  $PROGRAM_NAME --result <run-id>          Return a completed result
  $PROGRAM_NAME --wait <run-id>            Wait and return the result

The alias maps deterministically to a project-local Pi session. Start returns
a run ID immediately; use --status, --result, or --wait to collect the result.
EOF
}

fail() {
	local code="$1"
	local message="$2"
	printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "$code" "$message" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "missing_command" "required command is unavailable: $1"
}

has_explicit_model() {
	local argument
	for argument in "$@"; do
		case "$argument" in
			--model) return 0 ;;
		esac
	done
	return 1
}

validate_alias() {
	[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
		fail "invalid_alias" "alias must match [A-Za-z0-9][A-Za-z0-9._-]*"
}

validate_run_id() {
	[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
		fail "invalid_run_id" "run ID contains unsupported characters"
}

validate_owner_session_id() {
	local session_id="$1"
	[[ -z "$session_id" || "$session_id" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]] ||
		fail "invalid_owner_session" "PI_SESSION_ID contains unsupported characters"
}

reject_nested_run() {
	[[ "${PI_SUB_DEPTH:-0}" == 0 ]] ||
		fail "nested_subagent" "nested pi-sub runs are disabled; compose subagents in the parent orchestration"
}

reject_owned_pi_arguments() {
	local argument
	for argument in "$@"; do
		case "$argument" in
			--)
				fail "unsupported_pi_argument" "pi does not support -- as an end-of-options marker"
				;;
			-p | --print | --mode | --mode=* | -c | --continue | -r | --resume | --session | --session=* | --session-id | --session-id=* | --session-dir | --session-dir=* | --fork | --fork=* | --no-session | -n | --name | --name=*)
				fail "reserved_pi_argument" "print, naming, and session selection are owned by pi-sub"
				;;
		esac
	done
}

session_id_for() {
	local alias_name="$1"
	local digest
	digest="$(printf '%s\0%s' "$(pwd -P)" "$alias_name" | shasum -a 256)"
	digest="${digest%% *}"
	# UUIDv8 marks this as an application-defined deterministic identifier.
	printf '%s-%s-8%s-8%s-%s\n' \
		"${digest:0:8}" "${digest:8:4}" "${digest:13:3}" "${digest:17:3}" "${digest:20:12}"
}

run_dir_for() {
	local run_id="$1"
	local run_dir
	validate_run_id "$run_id"
	run_dir="$RUN_ROOT/runs/$run_id"
	[[ -d "$run_dir" ]] || fail "run_not_found" "no run exists for the supplied run ID"
	printf '%s\n' "$run_dir"
}

mark_notification_claimed_by_owner() {
	local run_dir="$1"
	local owner_session_id
	[[ -f "$run_dir/owner-session-id" ]] || return
	owner_session_id="$(<"$run_dir/owner-session-id")"
	[[ -n "$owner_session_id" && "${PI_SESSION_ID:-}" == "$owner_session_id" ]] || return
	if ! (set -o noclobber; : > "$run_dir/notification-claimed") 2>/dev/null; then
		[[ -e "$run_dir/notification-claimed" ]] ||
			fail "notification_claim_failed" "owner collected the run but its notification claim could not be recorded"
	fi
}

publish_status() {
	local run_dir="$1"
	local state="$2"
	local value="${3:-}"
	local temporary
	temporary="$(mktemp "$run_dir/.status.XXXXXX")"
	printf '%s\t%s\n' "$state" "$value" > "$temporary"
	mv "$temporary" "$run_dir/status"
}

read_status() {
	local run_dir="$1"
	local state value
	[[ -f "$run_dir/status" ]] || fail "status_unavailable" "run status has not been published"
	IFS=$'\t' read -r state value < "$run_dir/status" ||
		fail "invalid_status" "run status is unreadable"
	case "$state" in
		queued | running)
			printf '%s\t%s\n' "$state" "$value"
			;;
		complete)
			if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value > 255 )); then
				fail "invalid_status" "completed run status contains an invalid exit code"
			fi
			printf '%s\t%s\n' "$state" "$value"
			;;
		*)
			fail "invalid_status" "run status contains an unknown state"
			;;
	esac
}

run_is_active() {
	local run_dir="$1"
	if lockf -t 0 -k "$run_dir/run.lock" true 2>/dev/null; then
		return 1
	fi
	return 0
}

show_status() {
	local run_id="$1"
	local run_dir state value
	run_dir="$(run_dir_for "$run_id")"
	IFS=$'\t' read -r state value <<< "$(read_status "$run_dir")"
	if [[ "$state" != "complete" ]] && ! run_is_active "$run_dir"; then
		printf '{"ok":false,"state":"lost","runId":"%s","error":{"code":"worker_lost","message":"worker exited before publishing completion"}}\n' "$run_id"
		return 1
	fi
	if [[ "$state" == "complete" ]]; then
		printf '{"ok":true,"state":"complete","runId":"%s","exitCode":%s}\n' "$run_id" "$value"
	else
		printf '{"ok":true,"state":"%s","runId":"%s"}\n' "$state" "$run_id"
	fi
}

return_result() {
	local run_id="$1"
	local wait_for_completion="$2"
	local run_dir state exit_code
	run_dir="$(run_dir_for "$run_id")"
	if [[ "$wait_for_completion" == true ]]; then
		lockf -k "$run_dir/run.lock" true
	fi
	IFS=$'\t' read -r state exit_code <<< "$(read_status "$run_dir")"
	if [[ "$state" != "complete" && "$wait_for_completion" == false ]] && run_is_active "$run_dir"; then
		IFS=$'\t' read -r state exit_code <<< "$(read_status "$run_dir")"
		[[ "$state" == "complete" ]] || fail "run_active" "run is not complete; use --status or --wait"
	fi
	if [[ "$state" != "complete" ]]; then
		IFS=$'\t' read -r state exit_code <<< "$(read_status "$run_dir")"
	fi
	if [[ "$state" != "complete" ]]; then
		[[ ! -s "$run_dir/worker.stderr" ]] || cat "$run_dir/worker.stderr" >&2
		fail "worker_lost" "worker exited before publishing completion"
	fi
	[[ -f "$run_dir/stdout" && -f "$run_dir/stderr" ]] ||
		fail "result_unavailable" "completed run has missing output files"
	mark_notification_claimed_by_owner "$run_dir"
	cat "$run_dir/stdout"
	cat "$run_dir/stderr" >&2
	return "$exit_code"
}

execute_run() {
	local run_dir="$1"
	local alias_name="$2"
	local session_id="$3"
	shift 3
	local exit_code
	publish_status "$run_dir" running
	unset PI_SESSION_ID PI_SESSION_FILE PI_PROVIDER PI_MODEL PI_REASONING_LEVEL
	export PI_SUB_DEPTH=1
	set +e
	pi -p --session-id "$session_id" --name "$alias_name" "$@" \
		< "$run_dir/stdin" > "$run_dir/stdout" 2> "$run_dir/stderr"
	exit_code=$?
	set -e
	publish_status "$run_dir" complete "$exit_code"
	return "$exit_code"
}

run_worker() {
	local run_dir="$1"
	local alias_name="$2"
	local session_id="$3"
	shift 3
	local ready_sent=false
	notify_start_failure() {
		if [[ "$ready_sent" == false && -p "$run_dir/ready" ]]; then
			printf 'failed\n' > "$run_dir/ready" || true
		fi
	}
	trap notify_start_failure EXIT
	exec 8> "$run_dir/run.lock"
	lockf 8
	publish_status "$run_dir" queued
	printf 'ready\n' > "$run_dir/ready"
	ready_sent=true
	trap - EXIT
	lockf -k "$LOCK_ROOT/$session_id" \
		"$SCRIPT_PATH" --execute "$run_dir" "$alias_name" "$session_id" "$@"
}

start_run() {
	local alias_name="$1"
	shift
	local session_id run_dir run_id handshake owner_session_id
	reject_nested_run
	validate_alias "$alias_name"
	reject_owned_pi_arguments "$@"
	owner_session_id="${PI_SESSION_ID:-}"
	validate_owner_session_id "$owner_session_id"
	[[ -n "$DEFAULT_MODEL" ]] || fail "invalid_default_model" "PI_SUB_DEFAULT_MODEL must not be empty"
	if ! has_explicit_model "$@"; then
		set -- --model "$DEFAULT_MODEL" "$@"
	fi
	for command_name in pi shasum lockf mktemp mkfifo nohup; do
		require_command "$command_name"
	done
	mkdir -p "$RUN_ROOT/runs" "$LOCK_ROOT"
	session_id="$(session_id_for "$alias_name")"
	run_dir="$(mktemp -d "$RUN_ROOT/runs/$alias_name.XXXXXX")"
	run_id="${run_dir##*/}"
	if [[ -t 0 ]]; then
		: > "$run_dir/stdin"
	else
		cat > "$run_dir/stdin"
	fi
	printf '%s\n' "$owner_session_id" > "$run_dir/owner-session-id"
	mkfifo "$run_dir/ready"
	exec 7<> "$run_dir/ready"
	nohup "$SCRIPT_PATH" --worker "$run_dir" "$alias_name" "$session_id" "$@" \
		< /dev/null > /dev/null 2> "$run_dir/worker.stderr" &
	IFS= read -r handshake <&7
	exec 7>&-
	rm "$run_dir/ready"
	if [[ "$handshake" != "ready" ]]; then
		cat "$run_dir/worker.stderr" >&2
		fail "worker_start_failed" "background worker failed during startup"
	fi
	if [[ -n "$owner_session_id" ]]; then
		printf '{"ok":true,"state":"started","runId":"%s","sessionId":"%s","ownerSessionId":"%s"}\n' \
			"$run_id" "$session_id" "$owner_session_id"
	else
		printf '{"ok":true,"state":"started","runId":"%s","sessionId":"%s","ownerSessionId":null}\n' \
			"$run_id" "$session_id"
	fi
}

case "${1:-}" in
	-h | --help | "")
		usage
		;;
	--status)
		[[ "$#" -eq 2 ]] || fail "invalid_arguments" "--status requires exactly one run ID"
		require_command lockf
		show_status "$2"
		;;
	--result)
		[[ "$#" -eq 2 ]] || fail "invalid_arguments" "--result requires exactly one run ID"
		require_command lockf
		return_result "$2" false
		;;
	--wait)
		[[ "$#" -eq 2 ]] || fail "invalid_arguments" "--wait requires exactly one run ID"
		require_command lockf
		return_result "$2" true
		;;
	--worker)
		shift
		run_worker "$@"
		;;
	--execute)
		shift
		execute_run "$@"
		;;
	--*)
		fail "unknown_command" "unknown pi-sub command"
		;;
	*)
		start_run "$@"
		;;
esac
