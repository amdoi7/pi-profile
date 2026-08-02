#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT="$SCRIPT_DIR/pi-sub.sh"

fail_test() {
	printf 'FAIL: %s\n' "$1" >&2
	exit 1
}

json_value() {
	local key="$1"
	sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

assert_contains() {
	local value="$1"
	local expected="$2"
	[[ "$value" == *"$expected"* ]] || fail_test "expected [$value] to contain [$expected]"
}

test_double_dash_cannot_bypass_owned_arguments() {
	local root fake_bin stderr output exit_code run_id
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	stderr="$root/stderr"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
: > "$FAKE_PI_CALLED"
FAKE_PI
	chmod +x "$fake_bin/pi"

	set +e
	output="$(cd "$root/project" && PATH="$fake_bin:$PATH" FAKE_PI_CALLED="$root/called" \
		TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" \
		"$SCRIPT" bypass -- --session-id 00000000-0000-8000-8000-000000000000 prompt 2>"$stderr")"
	exit_code=$?
	set -e
	if [[ "$exit_code" -eq 0 ]]; then
		run_id="$(printf '%s' "$output" | json_value runId)"
		PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id" >/dev/null
	fi

	[[ "$exit_code" -eq 1 ]] || fail_test "double-dash bypass exit=$exit_code; want 1"
	assert_contains "$(<"$stderr")" '"code":"unsupported_pi_argument"'
	[[ ! -e "$root/called" ]] || fail_test "pi ran after an owned argument bypass"
	rm -rf "$root"
}

test_nested_run_is_rejected() {
	local root fake_bin stderr output exit_code run_id
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	stderr="$root/stderr"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
: > "$FAKE_PI_CALLED"
FAKE_PI
	chmod +x "$fake_bin/pi"

	set +e
	output="$(cd "$root/project" && PATH="$fake_bin:$PATH" FAKE_PI_CALLED="$root/called" \
		TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" PI_SUB_DEPTH=1 \
		"$SCRIPT" nested prompt 2>"$stderr")"
	exit_code=$?
	set -e
	if [[ "$exit_code" -eq 0 ]]; then
		run_id="$(printf '%s' "$output" | json_value runId)"
		PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id" >/dev/null
	fi

	[[ "$exit_code" -eq 1 ]] || fail_test "nested run exit=$exit_code; want 1"
	assert_contains "$(<"$stderr")" '"code":"nested_subagent"'
	[[ ! -e "$root/called" ]] || fail_test "pi ran for a nested subagent"
	rm -rf "$root"
}

test_owner_metadata_and_child_depth() {
	local root fake_bin owner start_json run_id run_dir result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	owner="019fc0d6-53f1-7b5b-b382-2ddee71c0353"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
printf 'depth:%s\n' "${PI_SUB_DEPTH:-unset}"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner" "$SCRIPT" owner-check prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner" \
		"$SCRIPT" --wait "$run_id")"

	assert_contains "$start_json" "\"ownerSessionId\":\"$owner\""
	[[ -f "$run_dir/owner-session-id" ]] || fail_test "run has no owner-session-id metadata"
	[[ "$(<"$run_dir/owner-session-id")" == "$owner" ]] || fail_test "run owner metadata does not match parent session"
	[[ -f "$run_dir/notification-claimed" ]] || fail_test "owner collection did not claim the completion notification"
	[[ "$result" == "depth:1" ]] || fail_test "child depth=$result; want depth:1"
	rm -rf "$root"
}

test_alias_lock_is_independent_of_run_root() {
	local root project fake_bin calls ready_a ready_b gate_a gate_b start_a start_b run_a run_b status_b call_count
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	calls="$root/calls"
	ready_a="$root/ready-a"
	ready_b="$root/ready-b"
	gate_a="$root/gate-a"
	gate_b="$root/gate-b"
	mkdir -p "$project" "$fake_bin" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	mkfifo "$ready_a" "$ready_b" "$gate_a" "$gate_b"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
prompt="${!#}"
printf '%s\n' "$prompt" >> "$FAKE_PI_CALLS"
case "$prompt" in
	first)
		printf 'ready\n' > "$FAKE_PI_READY_A"
		IFS= read -r _ < "$FAKE_PI_GATE_A"
		;;
	second)
		printf 'ready\n' > "$FAKE_PI_READY_B"
		IFS= read -r _ < "$FAKE_PI_GATE_B"
		;;
esac
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_a="$(cd "$project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-a" \
		FAKE_PI_CALLS="$calls" FAKE_PI_READY_A="$ready_a" FAKE_PI_READY_B="$ready_b" \
		FAKE_PI_GATE_A="$gate_a" FAKE_PI_GATE_B="$gate_b" "$SCRIPT" same first)"
	IFS= read -r _ < "$ready_a"
	start_b="$(cd "$project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-b" \
		FAKE_PI_CALLS="$calls" FAKE_PI_READY_A="$ready_a" FAKE_PI_READY_B="$ready_b" \
		FAKE_PI_GATE_A="$gate_a" FAKE_PI_GATE_B="$gate_b" "$SCRIPT" same second)"
	run_b="$(printf '%s' "$start_b" | json_value runId)"
	status_b="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-b" "$SCRIPT" --status "$run_b")"
	call_count="$(wc -l < "$calls" | tr -d ' ')"

	printf 'continue\n' > "$gate_a"
	run_a="$(printf '%s' "$start_a" | json_value runId)"
	PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-a" "$SCRIPT" --wait "$run_a" >/dev/null
	IFS= read -r _ < "$ready_b"
	printf 'continue\n' > "$gate_b"
	PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-b" "$SCRIPT" --wait "$run_b" >/dev/null

	assert_contains "$status_b" '"state":"queued"'
	[[ "$call_count" -eq 1 ]] || fail_test "same alias used different run roots concurrently; calls=$call_count"
	rm -rf "$root"
}

test_missing_run_is_machine_readable() {
	local root stderr exit_code
	root="$(mktemp -d)"
	stderr="$root/stderr"
	set +e
	PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --status missing > /dev/null 2>"$stderr"
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 1 ]] || fail_test "missing run exit=$exit_code; want 1"
	assert_contains "$(<"$stderr")" '"code":"run_not_found"'
	rm -rf "$root"
}

test_async_lifecycle() {
	local root project fake_bin calls ready gate start_json run_id second_run_id status result
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	calls="$root/calls"
	ready="$root/ready"
	gate="$root/gate"
	mkdir -p "$project" "$fake_bin"
	mkfifo "$ready" "$gate"

	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_PI_CALLS"
prompt="${!#}"
case "$prompt" in
	block)
		printf 'ready\n' > "$FAKE_PI_READY"
		IFS= read -r _ < "$FAKE_PI_GATE"
		;;
	fail)
		printf 'provider failed\n' >&2
		exit 7
		;;
esac
printf 'answer:%s\n' "$prompt"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	export FAKE_PI_CALLS="$calls"
	export FAKE_PI_READY="$ready"
	export FAKE_PI_GATE="$gate"
	cd "$project"

	start_json="$("$SCRIPT" reviewer block)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	[[ -n "$run_id" ]] || fail_test "start response has no runId: $start_json"
	IFS= read -r _ < "$ready"
	status="$("$SCRIPT" --status "$run_id")"
	assert_contains "$status" '"state":"running"'
	start_json="$("$SCRIPT" reviewer follow-up)"
	second_run_id="$(printf '%s' "$start_json" | json_value runId)"
	status="$("$SCRIPT" --status "$second_run_id")"
	assert_contains "$status" '"state":"queued"'
	[[ "$(wc -l < "$calls" | tr -d ' ')" -eq 1 ]] || fail_test "second run bypassed the session lock"

	printf 'continue\n' > "$gate"
	result="$("$SCRIPT" --wait "$run_id")"
	[[ "$result" == "answer:block" ]] || fail_test "unexpected result: $result"
	result="$("$SCRIPT" --wait "$second_run_id")"
	[[ "$result" == "answer:follow-up" ]] || fail_test "unexpected follow-up result: $result"
	status="$("$SCRIPT" --status "$run_id")"
	assert_contains "$status" '"state":"complete"'
	assert_contains "$status" '"exitCode":0'

	[[ "$(wc -l < "$calls" | tr -d ' ')" -eq 2 ]] || fail_test "expected two pi calls"
	[[ "$(sed -n '1p' "$calls")" == *"--name reviewer"* ]] || fail_test "first call is unnamed"
	[[ "$(sed -n '2p' "$calls")" == *"--name reviewer"* ]] || fail_test "follow-up call is unnamed"
	[[ "$(sed -n '1p' "$calls" | sed -n 's/.*--session-id \([^ ]*\).*/\1/p')" == "$(sed -n '2p' "$calls" | sed -n 's/.*--session-id \([^ ]*\).*/\1/p')" ]] ||
		fail_test "alias did not preserve its session ID"

	start_json="$("$SCRIPT" reviewer fail)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	set +e
	result="$("$SCRIPT" --wait "$run_id" 2>"$root/failure.stderr")"
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 7 ]] || fail_test "failed run exit=$exit_code; want 7"
	[[ -z "$result" ]] || fail_test "failed run produced stdout: $result"
	[[ "$(<"$root/failure.stderr")" == "provider failed" ]] || fail_test "failed run lost stderr"

	rm -rf "$root"
}

case "${1:-all}" in
	status)
		test_missing_run_is_machine_readable
		;;
	arguments)
		test_double_dash_cannot_bypass_owned_arguments
		;;
	nesting)
		test_nested_run_is_rejected
		;;
	owner)
		test_owner_metadata_and_child_depth
		;;
	locking)
		test_alias_lock_is_independent_of_run_root
		;;
	all)
		test_missing_run_is_machine_readable
		test_double_dash_cannot_bypass_owned_arguments
		test_nested_run_is_rejected
		test_owner_metadata_and_child_depth
		test_alias_lock_is_independent_of_run_root
		test_async_lifecycle
		;;
	*)
		fail_test "unknown test selection: $1"
		;;
esac

printf 'PASS\n'
