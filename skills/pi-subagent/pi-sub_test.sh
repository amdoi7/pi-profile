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
	all)
		test_missing_run_is_machine_readable
		test_async_lifecycle
		;;
	*)
		fail_test "unknown test selection: $1"
		;;
esac

printf 'PASS\n'
