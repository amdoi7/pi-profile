#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT="$SCRIPT_DIR/pi-sub"

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

assert_start_rejected() {
	local expected_code="$1"
	shift
	local root fake_bin stderr output exit_code run_id
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	stderr="$root/stderr"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
: > "$FAKE_PI_CALLED"
FAKE_PI
	chmod +x "$fake_bin/pi"

	set +e
	output="$(cd "$root/project" && PATH="$fake_bin:$PATH" FAKE_PI_CALLED="$root/called" \
		PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" \
		"$SCRIPT" "$@" 2>"$stderr")"
	exit_code=$?
	set -e
	if [[ "$exit_code" -eq 0 ]]; then
		run_id="$(printf '%s' "$output" | json_value runId)"
		PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" \
			PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id" >/dev/null
	fi

	[[ "$exit_code" -eq 1 ]] || fail_test "rejected start exit=$exit_code; want 1 for $expected_code"
	assert_contains "$(<"$stderr")" "\"code\":\"$expected_code\""
	[[ ! -e "$root/called" ]] || fail_test "pi ran after rejected start: $expected_code"
	rm -rf "$root"
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

test_capability_selection_is_required() {
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
		"$SCRIPT" reviewer prompt 2>"$stderr")"
	exit_code=$?
	set -e
	if [[ "$exit_code" -eq 0 ]]; then
		run_id="$(printf '%s' "$output" | json_value runId)"
		PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id" >/dev/null
	fi

	[[ "$exit_code" -eq 1 ]] || fail_test "missing capability selector exit=$exit_code; want 1"
	assert_contains "$(<"$stderr")" '"code":"capability_required"'
	[[ ! -e "$root/called" ]] || fail_test "pi ran without an explicit capability selector"
	rm -rf "$root"
}

test_mutation_requires_write_scope() {
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
		"$SCRIPT" implementer --tools read,bash prompt 2>"$stderr")"
	exit_code=$?
	set -e
	if [[ "$exit_code" -eq 0 ]]; then
		run_id="$(printf '%s' "$output" | json_value runId)"
		PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id" >/dev/null
	fi

	[[ "$exit_code" -eq 1 ]] || fail_test "unscoped mutation exit=$exit_code; want 1"
	assert_contains "$(<"$stderr")" '"code":"write_scope_required"'
	[[ ! -e "$root/called" ]] || fail_test "pi ran with unscoped mutation capability"
	rm -rf "$root"
}

test_capability_ceiling_and_metadata() {
	local root fake_bin start_json run_id run_dir result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf '%s' "$*")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		PI_SUB_RUN_DIR="$root/state" "$SCRIPT" reviewer --tools read,grep,find,ls prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"

	assert_contains "$result" '--no-extensions --no-skills'
	assert_contains "$result" '--tools read,grep,find,ls'
	[[ "$(<"$run_dir/alias")" == "reviewer" ]] || fail_test "run alias metadata is missing"
	[[ "$(<"$run_dir/task-mode")" == "read-only" ]] || fail_test "run task mode metadata is missing"
	[[ "$(<"$run_dir/tools")" == "read,grep,find,ls" ]] || fail_test "run tools metadata is missing"
	[[ -z "$(<"$run_dir/model")" ]] || fail_test "standalone run invented a model instead of using Pi settings"
	[[ "$result" != *"--model"* ]] || fail_test "standalone run injected a model without a configured default"
	[[ "$(<"$run_dir/project-cwd")" == "$(cd "$root/project" && pwd -P)" ]] || fail_test "run cwd metadata is missing"
	[[ ! -s "$run_dir/write-scopes" ]] || fail_test "read-only run has write scopes"
	rm -rf "$root"
}

test_parent_model_context_is_inherited() {
	local root fake_bin start_json run_id run_dir result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf '%s' "$*")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_PROVIDER="parent-provider" PI_MODEL="parent-model" \
		PI_REASONING_LEVEL="xhigh" PI_SUB_DEFAULT_MODEL="fallback-model" \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"

	assert_contains "$result" '--provider parent-provider --model parent-model --thinking xhigh'
	[[ "$result" != *"fallback-model"* ]] || fail_test "configured fallback overrode the parent model context"
	[[ "$(<"$run_dir/provider")" == "parent-provider" ]] || fail_test "inherited provider metadata is missing"
	[[ "$(<"$run_dir/model")" == "parent-model" ]] || fail_test "inherited model metadata is missing"
	[[ "$(<"$run_dir/thinking")" == "xhigh" ]] || fail_test "inherited thinking metadata is missing"
	rm -rf "$root"
}

test_explicit_model_does_not_mix_parent_provider() {
	local root fake_bin start_json run_id run_dir result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf '%s' "$*")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_PROVIDER="parent-provider" PI_MODEL="parent-model" \
		PI_REASONING_LEVEL="high" "$SCRIPT" reviewer --model child-model --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"

	assert_contains "$result" '--model child-model'
	assert_contains "$result" '--thinking high'
	[[ "$result" != *"--provider parent-provider"* ]] || fail_test "explicit child model inherited an incompatible provider"
	[[ -z "$(<"$run_dir/provider")" ]] || fail_test "explicit child model recorded the parent provider"
	rm -rf "$root"
}

test_model_thinking_suffix_precedes_parent_reasoning() {
	local root fake_bin start_json run_id result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf '%s' "$*")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_PROVIDER="parent-provider" PI_MODEL="parent-model" \
		PI_REASONING_LEVEL="high" "$SCRIPT" reviewer --model child-model:low --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"

	assert_contains "$result" '--model child-model:low'
	[[ "$result" != *"--thinking high"* ]] || fail_test "parent reasoning overrode the model thinking suffix"
	rm -rf "$root"
}

test_durable_session_transcript() {
	local root fake_bin start_json run_id run_dir result transcript session_file
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
session_file=""
while (( $# > 0 )); do
	if [[ "$1" == "--session" ]]; then
		session_file="$2"
		break
	fi
	shift
done
[[ -n "$session_file" ]] || exit 91
printf '%s\n' \
	'{"type":"session","version":3,"id":"child","cwd":"/workspace"}' \
	'{"type":"message","id":"done","parentId":null,"message":{"role":"assistant","content":[{"type":"text","text":"durable answer"}],"stopReason":"stop"}}' \
	> "$session_file"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}],"stopReason":"stop"}}\n'
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"
	transcript="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --transcript "$run_id")"
	session_file="$(<"$run_dir/session-file")"

	[[ "$result" == "final answer" ]] || fail_test "unexpected durable-session result: $result"
	[[ -f "$session_file" ]] || fail_test "durable session file is missing"
	assert_contains "$transcript" '"text":"durable answer"'
	rm -rf "$root"
}

test_mutation_metadata_and_wrapper_arguments() {
	local root fake_bin start_json run_id run_dir result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf '%s' "$*")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" "$SCRIPT" implementer \
		--write-scope src --tools read,bash,edit,write --write-scope tests prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"

	[[ "$(<"$run_dir/task-mode")" == "mutation" ]] || fail_test "mutation task mode metadata is missing"
	[[ "$(<"$run_dir/write-scopes")" == $'src\ntests' ]] || fail_test "write scope metadata is incomplete"
	[[ "$result" != *"--write-scope"* ]] || fail_test "wrapper write scopes leaked into pi arguments"
	rm -rf "$root"
}

test_explicit_model_precedes_environment_default() {
	local root fake_bin start_json run_id run_dir result
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	export PI_CODING_AGENT_DIR="$root/agent"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf '%s' "$*")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SUB_DEFAULT_MODEL="environment-model" \
		"$SCRIPT" reviewer --provider test-provider --thinking high --model=explicit-model --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	result="$(PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" "$SCRIPT" --wait "$run_id")"

	assert_contains "$result" '--model=explicit-model'
	assert_contains "$result" '--provider test-provider --thinking high'
	[[ "$result" != *"environment-model"* ]] || fail_test "default model overrode an explicit model"
	[[ "$(<"$run_dir/model")" == "explicit-model" ]] || fail_test "explicit model metadata is missing"
	rm -rf "$root"
}

test_install() {
	local root installed
	root="$(mktemp -d)"
	installed="$root/agent/bin/pi-sub"

	PI_CODING_AGENT_DIR="$root/agent" "$SCRIPT_DIR/init.sh" >/dev/null
	[[ -x "$installed" ]] || fail_test "init.sh did not install an executable runner"
	cmp -s "$SCRIPT" "$installed" || fail_test "installed runner differs from canonical source"
	rm -rf "$root"
}

test_pi_argument_boundaries() {
	assert_start_rejected invalid_arguments reviewer --system-prompt --tools read prompt
	assert_start_rejected capability_ceiling reviewer --no-tools -e=/tmp/child-extension.ts prompt
	assert_start_rejected unsupported_pi_argument reviewer --no-tools --future-flag value prompt
	assert_start_rejected invalid_arguments reviewer --no-tools --model --thinking high prompt
	assert_start_rejected invalid_arguments reviewer --no-tools --api-key "" prompt
	assert_start_rejected invalid_write_scope reviewer --tools read,bash --write-scope $'src\033[31m' prompt
	assert_start_rejected invalid_model reviewer --no-tools $'--model=unsafe\033[31m' prompt
	assert_start_rejected internal_command --execute /nonexistent/run alias 00000000-0000-8000-8000-000000000000
	PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= PI_SUB_DEFAULT_MODEL='' \
		assert_start_rejected invalid_model reviewer --no-tools prompt
}

test_owner_isolates_same_workspace_alias() {
	local root fake_bin owner_a owner_b start_a start_b follow_a run_a run_b follow_run_a session_a session_b follow_session_a result wrong_status wrong_status_exit wrong_result wrong_result_exit
	root="$(mktemp -d)"
	fake_bin="$root/bin"
	owner_a="019fc0d6-53f1-7b5b-b382-2ddee71c0353"
	owner_b="019fc0d6-53f1-7b5b-b382-2ddee71c0354"
	mkdir -p "$fake_bin" "$root/project" "$root/tmp"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf 'answer:%s' "${!#}")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_a="$(cd "$root/project" && PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" \
		TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_a" \
		"$SCRIPT" reviewer --no-tools first)"
	start_b="$(cd "$root/project" && PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" \
		TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_b" \
		"$SCRIPT" reviewer --no-tools second)"
	run_a="$(printf '%s' "$start_a" | json_value runId)"
	run_b="$(printf '%s' "$start_b" | json_value runId)"
	session_a="$(printf '%s' "$start_a" | json_value sessionId)"
	session_b="$(printf '%s' "$start_b" | json_value sessionId)"

	set +e
	wrong_status="$(PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_b" "$SCRIPT" --status "$run_a" 2>"$root/wrong.stderr")"
	wrong_status_exit=$?
	wrong_result="$(PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_b" "$SCRIPT" --result "$run_a" 2>"$root/wrong-result.stderr")"
	wrong_result_exit=$?
	set -e

	result="$(PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_a" "$SCRIPT" --wait "$run_a")"
	[[ "$result" == "answer:first" ]] || fail_test "owner A collected the wrong result: $result"
	result="$(PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_b" "$SCRIPT" --wait "$run_b")"
	[[ "$result" == "answer:second" ]] || fail_test "owner B collected the wrong result: $result"

	follow_a="$(cd "$root/project" && PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" \
		TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_a" \
		"$SCRIPT" reviewer --no-tools follow-up)"
	follow_run_a="$(printf '%s' "$follow_a" | json_value runId)"
	follow_session_a="$(printf '%s' "$follow_a" | json_value sessionId)"
	PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner_a" "$SCRIPT" --wait "$follow_run_a" >/dev/null

	[[ "$session_a" != "$session_b" ]] || fail_test "different owners shared child session $session_a"
	[[ "$session_a" == "$follow_session_a" ]] || fail_test "same owner alias did not preserve its child session"
	[[ "$wrong_status_exit" -eq 1 && -z "$wrong_status" ]] || fail_test "owner B read owner A status"
	assert_contains "$(<"$root/wrong.stderr")" '"code":"run_owner_mismatch"'
	[[ "$wrong_result_exit" -eq 1 && -z "$wrong_result" ]] || fail_test "owner B read owner A result"
	assert_contains "$(<"$root/wrong-result.stderr")" '"code":"run_owner_mismatch"'
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
answer="$(printf 'depth:%s' "${PI_SUB_DEPTH:-unset}")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$root/project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" \
		PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="$owner" "$SCRIPT" owner-check --no-tools prompt)"
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
	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
prompt="\${!#}"
printf '%s\n' "\$prompt" >> "$calls"
case "\$prompt" in
	first)
		printf 'ready\n' > "$ready_a"
		IFS= read -r _ < "$gate_a"
		;;
	second)
		printf 'ready\n' > "$ready_b"
		IFS= read -r _ < "$gate_b"
		;;
esac
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_a="$(cd "$project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-a" \
		"$SCRIPT" same --no-tools first)"
	IFS= read -r _ < "$ready_a"
	start_b="$(cd "$project" && PATH="$fake_bin:$PATH" TMPDIR="$root/tmp" PI_SUB_RUN_DIR="$root/state-b" \
		"$SCRIPT" same --no-tools second)"
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

test_session_file_is_alias_lock_carrier() {
	local root project fake_bin start_json run_id run_dir session_file transcript
	local probe_exit lock_root_created
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	mkfifo "$root/ready" "$root/gate"
	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
session_file=""
while (( \$# > 0 )); do
	if [[ "\$1" == "--session" ]]; then
		session_file="\$2"
		break
	fi
	shift
done
[[ -n "\$session_file" ]] || exit 91
printf '%s\n' \
	'{"type":"session","version":3,"id":"child","cwd":"/workspace"}' \
	'{"type":"message","id":"done","parentId":null,"message":{"role":"assistant","content":[{"type":"text","text":"durable answer"}],"stopReason":"stop"}}' \
	> "\$session_file"
printf 'ready\n' > "$root/ready"
IFS= read -r _ < "$root/gate"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}],"stopReason":"stop"}}'
FAKE_PI
	chmod +x "$fake_bin/pi"

	start_json="$(cd "$project" && PATH="$fake_bin:$PATH" PI_CODING_AGENT_DIR="$root/agent" \
		PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	IFS= read -r _ < "$root/ready"
	session_file="$(<"$run_dir/session-file")"

	set +e
	lockf -t 0 -k "$session_file" true 2>/dev/null
	probe_exit=$?
	set -e
	if [[ -d "$root/agent/processes/pi-subagent-locks" ]]; then
		lock_root_created=true
	else
		lock_root_created=false
	fi

	printf 'continue\n' > "$root/gate"
	PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id" >/dev/null
	transcript="$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --transcript "$run_id")"
	rm -rf "$root"

	[[ "$probe_exit" -eq 75 ]] ||
		fail_test "session file lock probe exit=$probe_exit; want EX_TEMPFAIL (75)"
	[[ "$lock_root_created" == false ]] || fail_test "start created the obsolete alias lock root"
	assert_contains "$transcript" '"text":"durable answer"'
}

test_cancel_run() {
	local root project fake_bin calls ready gate start_json run_id status result exit_code
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	calls="$root/calls"
	ready="$root/ready"
	gate="$root/gate"
	mkdir -p "$project" "$fake_bin"
	mkfifo "$ready" "$gate"

	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
printf 'ready\n' > "$ready"
IFS= read -r _ < "$gate"
printf 'answer\n'
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$("$SCRIPT" reviewer --no-tools block)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	IFS= read -r _ < "$ready"
	tmux list-panes -a -F '#{@name}' 2>/dev/null | grep -Fqx "pi-sub:$run_id" || fail_test "cancel target pane is missing"

	cancel_json="$("$SCRIPT" --cancel "$run_id")"
	assert_contains "$cancel_json" '"state":"cancelled"'

	set +e
	result="$("$SCRIPT" --wait "$run_id" 2>"$root/cancel.stderr")"
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 130 ]] || fail_test "cancelled run exit=$exit_code; want 130"
	[[ -z "$result" ]] || fail_test "cancelled run produced stdout: $result"
	status="$("$SCRIPT" --status "$run_id")"
	assert_contains "$status" '"state":"complete"'
	assert_contains "$status" '"exitCode":130'
	tmux list-panes -a -F '#{@name}' 2>/dev/null | grep -Fqx "pi-sub:$run_id" && fail_test "cancelled run pane survived"

	rm -rf "$root"
}

test_list_empty_runs_dir() {
	local root run_dir
	root="$(mktemp -d)"
	[[ "$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --list)" == "[]" ]] ||
		fail_test "empty runs dir did not list as []"
	mkdir -p "$root/state/runs"
	run_dir="$root/state/runs/other.owned"
	mkdir -p "$run_dir"
	printf 'other-owner\n' > "$run_dir/owner-session-id"
	printf 'running\t\n' > "$run_dir/status"
	[[ "$(PI_SUB_RUN_DIR="$root/state" PI_SESSION_ID="019fc0d6-53f1-7b5b-b382-2ddee71c0353" "$SCRIPT" --list)" == "[]" ]] ||
		fail_test "owner with no matching runs did not list as []"
	rm -rf "$root"
}

test_list_owner_scope_and_schema() {
	local root project fake_bin ready_1 gate_1 ready_3 gate_3 ready_4 gate_4
	local start_1 start_2 start_3 start_4 run_1 run_2 run_3 run_4 list_a list_b list_none ls_json ls_run
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	owner_a="019fc0d6-53f1-7b5b-b382-2ddee71c0353"
	owner_b="019fc0d6-53f1-7b5b-b382-2ddee71c0354"
	mkdir -p "$project" "$fake_bin"
	mkfifo "$root/ready-1" "$root/gate-1" "$root/ready-3" "$root/gate-3" "$root/ready-4" "$root/gate-4"
	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
prompt="\${!#}"
case "\$prompt" in
	block)
		printf 'ready\n' > "$root/ready-1"
		IFS= read -r _ < "$root/gate-1"
		;;
	block-b)
		printf 'ready\n' > "$root/ready-3"
		IFS= read -r _ < "$root/gate-3"
		;;
	block-c)
		printf 'ready\n' > "$root/ready-4"
		IFS= read -r _ < "$root/gate-4"
		;;
esac
answer="\$(printf 'answer:%s' "\$prompt")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "\$(printf '%s' "\$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_1="$(PI_SESSION_ID="$owner_a" PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" reviewer --no-tools block)"
	run_1="$(printf '%s' "$start_1" | json_value runId)"
	IFS= read -r _ < "$root/ready-1"
	start_2="$(PI_SESSION_ID="$owner_a" PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" reviewer --no-tools second)"
	run_2="$(printf '%s' "$start_2" | json_value runId)"
	start_3="$(PI_SESSION_ID="$owner_b" PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" impl --no-tools block-b)"
	run_3="$(printf '%s' "$start_3" | json_value runId)"
	IFS= read -r _ < "$root/ready-3"
	start_4="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" shell --no-tools block-c)"
	run_4="$(printf '%s' "$start_4" | json_value runId)"
	IFS= read -r _ < "$root/ready-4"

	list_a="$(PI_SESSION_ID="$owner_a" "$SCRIPT" --list)"
	printf '%s' "$list_a" | jq -e 'length == 2' >/dev/null || fail_test "owner A list length: $list_a"
	printf '%s' "$list_a" | jq -e 'all(.[]; (has("runId") and has("alias") and has("state") and has("exitCode") and has("model") and has("stateAgeSeconds")))' >/dev/null ||
		fail_test "list schema is incomplete: $list_a"
	printf '%s' "$list_a" | jq -e 'map(select(.runId == "'"$run_1"'")) | .[0] | .state == "running" and .exitCode == null and .alias == "reviewer" and .model == null' >/dev/null ||
		fail_test "owner A running entry: $list_a"
	printf '%s' "$list_a" | jq -e 'map(select(.runId == "'"$run_2"'")) | .[0].state == "queued"' >/dev/null ||
		fail_test "owner A queued entry: $list_a"
	printf '%s' "$list_a" | jq -e 'all(.[]; (.stateAgeSeconds | type == "number"))' >/dev/null ||
		fail_test "stateAgeSeconds is not numeric: $list_a"
	printf '%s' "$list_a" | jq -e 'all(.[]; (.runId == "'"$run_1"'" or .runId == "'"$run_2"'"))' >/dev/null ||
		fail_test "owner A list leaked foreign runs: $list_a"

	status_1="$(PI_SESSION_ID="$owner_a" "$SCRIPT" --status "$run_1")"
	printf '%s' "$status_1" | jq -e '.state == "running" and (.stateAgeSeconds | type == "number")' >/dev/null ||
		fail_test "--status lacks stateAgeSeconds: $status_1"

	list_b="$(PI_SESSION_ID="$owner_b" "$SCRIPT" --list)"
	printf '%s' "$list_b" | jq -e 'length == 1 and .[0].runId == "'"$run_3"'"' >/dev/null ||
		fail_test "owner B list: $list_b"

	list_none="$(env -u PI_SESSION_ID "$SCRIPT" --list)"
	printf '%s' "$list_none" | jq -e 'length == 1 and .[0].runId == "'"$run_4"'"' >/dev/null ||
		fail_test "unowned list: $list_none"

	ls_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" ls --no-tools ls-alias)"
	assert_contains "$ls_json" '"state":"started"'
	ls_run="$(printf '%s' "$ls_json" | json_value runId)"
	env -u PI_SESSION_ID "$SCRIPT" --wait "$ls_run" >/dev/null

	printf 'continue\n' > "$root/gate-1"
	PI_SESSION_ID="$owner_a" "$SCRIPT" --wait "$run_1" >/dev/null
	PI_SESSION_ID="$owner_a" "$SCRIPT" --wait "$run_2" >/dev/null
	printf 'continue\n' > "$root/gate-3"
	PI_SESSION_ID="$owner_b" "$SCRIPT" --wait "$run_3" >/dev/null
	printf 'continue\n' > "$root/gate-4"
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_4" >/dev/null

	list_a_final="$(PI_SESSION_ID="$owner_a" "$SCRIPT" --list)"
	printf '%s' "$list_a_final" | jq -e 'map(select(.runId == "'"$run_1"'")) | .[0] | .state == "complete" and .exitCode == 0' >/dev/null ||
		fail_test "owner A completed entry: $list_a_final"

	rm -rf "$root"
}

test_list_lost_detection() {
	local root project fake_bin ready gate start_json run_id run_dir status_json list_json wait_exit i
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	mkfifo "$root/ready" "$root/gate"
	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
printf 'ready\n' > "$root/ready"
IFS= read -r _ < "$root/gate"
printf 'answer\n'
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" reviewer --no-tools block)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	run_dir="$root/state/runs/$run_id"
	IFS= read -r _ < "$root/ready"

	LC_ALL=C pgrep -f "$root/agent/processes/pi-subagent-sessions/" | xargs kill -9 2>/dev/null || true

	status_json=""
	for (( i = 0; i < 10; i++ )); do
		set +e
		status_json="$(env -u PI_SESSION_ID "$SCRIPT" --status "$run_id" 2>/dev/null)"
		status_exit=$?
		set -e
		if [[ "$status_exit" -eq 1 ]] && printf '%s' "$status_json" | jq -e '.state == "lost"' >/dev/null 2>&1; then
			break
		fi
		sleep 0.2
	done
	printf '%s' "$status_json" | jq -e '.state == "lost" and (.stateAgeSeconds | type == "number")' >/dev/null ||
		fail_test "lost status missing: $status_json"

	list_json="$(env -u PI_SESSION_ID "$SCRIPT" --list)"
	printf '%s' "$list_json" | jq -e 'length == 1 and .[0].state == "lost" and .[0].exitCode == null and .[0].alias == "reviewer"' >/dev/null ||
		fail_test "lost list entry: $list_json"

	set +e
	"$SCRIPT" --wait "$run_id" >/dev/null 2>"$root/lost.stderr"
	wait_exit=$?
	set -e
	[[ "$wait_exit" -eq 1 ]] || fail_test "lost wait exit=$wait_exit; want 1"
	assert_contains "$(<"$root/lost.stderr")" '"code":"worker_lost"'

	rm -rf "$root"
}

test_cancel_queued_run() {
	local root project fake_bin ready gate start_a start_b run_a run_b cancel_json wait_exit status
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	mkfifo "$root/ready" "$root/gate"
	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
prompt="\${!#}"
case "\$prompt" in
	block)
		printf 'ready\n' > "$root/ready"
		IFS= read -r _ < "$root/gate"
		;;
esac
answer="\$(printf 'answer:%s' "\$prompt")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "\$(printf '%s' "\$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_a="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" same --no-tools block)"
	run_a="$(printf '%s' "$start_a" | json_value runId)"
	IFS= read -r _ < "$root/ready"
	start_b="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" same --no-tools second)"
	run_b="$(printf '%s' "$start_b" | json_value runId)"

	cancel_json="$(env -u PI_SESSION_ID "$SCRIPT" --cancel "$run_b")"
	assert_contains "$cancel_json" '"state":"cancelled"'
	set +e
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_b" >/dev/null 2>"$root/b.stderr"
	wait_exit=$?
	set -e
	[[ "$wait_exit" -eq 130 ]] || fail_test "cancelled queued run exit=$wait_exit; want 130"
	status="$(env -u PI_SESSION_ID "$SCRIPT" --status "$run_b")"
	assert_contains "$status" '"state":"complete"'
	assert_contains "$status" '"exitCode":130'

	printf 'continue\n' > "$root/gate"
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_a" >/dev/null
	rm -rf "$root"
}

test_cancel_completed_or_lost_run() {
	local root project fake_bin ready gate start_json run_id cancel_json cancel_exit i
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf 'answer:%s' "${!#}")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" quick --no-tools done)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id" >/dev/null

	set +e
	cancel_json="$(env -u PI_SESSION_ID "$SCRIPT" --cancel "$run_id" 2>/dev/null)"
	cancel_exit=$?
	set -e
	[[ "$cancel_exit" -eq 1 ]] || fail_test "cancel completed run exit=$cancel_exit; want 1"
	assert_contains "$cancel_json" '"code":"run_not_running"'
	assert_contains "$cancel_json" '"state":"complete"'

	mkfifo "$root/ready" "$root/gate"
	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
printf 'ready\n' > "$root/ready"
IFS= read -r _ < "$root/gate"
FAKE_PI
	chmod +x "$fake_bin/pi"
	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" blocker --no-tools block)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	IFS= read -r _ < "$root/ready"
	LC_ALL=C pgrep -f "$root/agent/processes/pi-subagent-sessions/" | xargs kill -9 2>/dev/null || true

	for (( i = 0; i < 10; i++ )); do
		set +e
		status_json="$(env -u PI_SESSION_ID "$SCRIPT" --status "$run_id" 2>/dev/null)"
		status_exit=$?
		set -e
		if [[ "$status_exit" -eq 1 ]] && printf '%s' "$status_json" | jq -e '.state == "lost"' >/dev/null 2>&1; then
			break
		fi
		sleep 0.2
	done
	set +e
	cancel_json="$(env -u PI_SESSION_ID "$SCRIPT" --cancel "$run_id" 2>/dev/null)"
	cancel_exit=$?
	set -e
	[[ "$cancel_exit" -eq 1 ]] || fail_test "cancel lost run exit=$cancel_exit; want 1"
	assert_contains "$cancel_json" '"code":"worker_lost"'
	assert_contains "$cancel_json" '"state":"lost"'
	rm -rf "$root"
}

test_list_escapes_json_strings() {
	local root project fake_bin start_json run_id list_json
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf 'answer:%s' "${!#}")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= \
		"$SCRIPT" reviewer --no-tools --model 'model"with space' prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id" >/dev/null
	list_json="$(env -u PI_SESSION_ID "$SCRIPT" --list)"
	printf '%s' "$list_json" | jq -e '.[0].model == "model\"with space"' >/dev/null ||
		fail_test "list did not escape model JSON: $list_json"
	rm -rf "$root"
}

	test_missing_status_classification() {
	local root run_dir holder_pid list_json status_json status_exit i
	root="$(mktemp -d)"
	mkdir -p "$root/state/runs/starting.aaa"
	run_dir="$root/state/runs/starting.aaa"
	: > "$run_dir/owner-session-id"
	# Lock held: a worker mid-startup holds the run lock before publishing queued.
	# The lock is flock-style on the open file description: the holder subshell
	# keeps fd 8, and children must not inherit it or the lock survives the kill.
	(
		exec 8> "$run_dir/run.lock"
		lockf 8
		sleep 20 8>&-
	) &
	holder_pid=$!

	list_json="$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --list)"
	printf '%s' "$list_json" | jq -e 'length == 1 and .[0].state == "queued"' >/dev/null ||
		fail_test "missing-status locked run not queued: $list_json"
	set +e
	status_json="$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --status starting.aaa 2>/dev/null)"
	status_exit=$?
	set -e
	[[ "$status_exit" -eq 0 ]] || fail_test "missing-status locked --status exit=$status_exit; want 0"
	printf '%s' "$status_json" | jq -e '.state == "queued"' >/dev/null ||
		fail_test "missing-status locked status: $status_json"

	kill -9 "$holder_pid" 2>/dev/null || true
	wait "$holder_pid" 2>/dev/null || true
	for (( i = 0; i < 10; i++ )); do
		set +e
		status_json="$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --status starting.aaa 2>/dev/null)"
		status_exit=$?
		set -e
		[[ "$status_exit" -eq 1 ]] && printf '%s' "$status_json" | jq -e '.state == "lost"' >/dev/null 2>&1 && break
		sleep 0.2
	done
	[[ "$status_exit" -eq 1 ]] || fail_test "missing-status unlocked --status exit=$status_exit; want 1"
	printf '%s' "$status_json" | jq -e '.state == "lost"' >/dev/null ||
		fail_test "missing-status unlocked status: $status_json"
	list_json="$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --list)"
	printf '%s' "$list_json" | jq -e 'length == 1 and .[0].state == "lost"' >/dev/null ||
		fail_test "missing-status unlocked run not lost: $list_json"
	rm -rf "$root"
}

test_leading_zero_exit_code_rejected() {
	local root list_json status_exit
	root="$(mktemp -d)"
	mkdir -p "$root/state/runs/evil.08"
	: > "$root/state/runs/evil.08/owner-session-id"
	printf 'complete\t08\n' > "$root/state/runs/evil.08/status"

	list_json="$(PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --list)"
	printf '%s' "$list_json" | jq -e 'length == 0' >/dev/null ||
		fail_test "leading-zero exit code leaked into list: $list_json"
	set +e
	PI_SUB_RUN_DIR="$root/state" env -u PI_SESSION_ID "$SCRIPT" --status evil.08 >/dev/null 2>"$root/e.stderr"
	status_exit=$?
	set -e
	[[ "$status_exit" -eq 1 ]] || fail_test "leading-zero status exit=$status_exit; want 1"
	assert_contains "$(<"$root/e.stderr")" '"code":"invalid_status"'
	rm -rf "$root"
}

test_worker_env_isolation() {
	local root project fake_bin start_json run_id result
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
answer="$(printf 'env-check:%s' "${PI_SUB_TEST_ENV:-unset}")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "$(printf '%s' "$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= PI_SUB_TEST_ENV=from-parent \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	result="$(env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id")"
	[[ "$result" == "env-check:from-parent" ]] || fail_test "worker env lost PI_SUB_TEST_ENV: $result"
	rm -rf "$root"
}

test_start_handshake_timeout() {
	local root project fake_bin start_pid run_dir stderr exit_code i
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
printf 'answer\n'
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	# Slow the worker's env restore so the kill lands before the ready handshake.
	for (( n = 0; n < 1500; n++ )); do
		export "PI_SUB_JUNK_$n=padding-value-$n"
	done
	cd "$project"

	PI_SUB_READY_TIMEOUT=2 "$SCRIPT" hang --no-tools prompt >"$root/start.out" 2>"$root/start.err" &
	start_pid=$!
	for (( i = 0; i < 50; i++ )); do
		set +e
		run_dir="$(find "$root/state/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
		set -e
		[[ -n "$run_dir" ]] && break
		sleep 0.1
	done
	[[ -n "$run_dir" ]] || fail_test "start never created a run dir"
	for (( i = 0; i < 40; i++ )); do
		LC_ALL=C pgrep -f "$run_dir" | xargs kill -9 2>/dev/null || true
		kill -0 "$start_pid" 2>/dev/null || break
		sleep 0.05
	done
	for (( n = 0; n < 1500; n++ )); do
		unset "PI_SUB_JUNK_$n"
	done
	set +e
	wait "$start_pid"
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 1 ]] || fail_test "handshake timeout exit=$exit_code; want 1"
	assert_contains "$(<"$root/start.err")" '"code":"worker_start_failed"'
	[[ ! -d "$run_dir" ]] || fail_test "failed start leaked its run dir: $run_dir"
	rm -rf "$root"
}

test_json_event_projection() {
	local root project fake_bin start_json run_id result exit_code
	root="$(mktemp -d)"
	project="$root/project"
	fake_bin="$root/bin"
	mkdir -p "$project" "$fake_bin"
	cat > "$fake_bin/pi" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
case "${FAKE_EVENT_MODE:-ok}" in
	ok)
		printf '%s\n' \
			'{"type":"session","version":3,"id":"x","cwd":"/workspace"}' \
			'{"type":"agent_start"}' \
			'{"type":"turn_start"}' \
			'{"type":"message_start","message":{"role":"assistant","content":[]}}' \
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer line one"},{"type":"text","text":"line two"}],"stopReason":"stop"}}' \
			'{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}' \
			'{"type":"agent_end","messages":[]}'
		;;
	error)
		printf '%s\n' \
			'{"type":"session","version":3,"id":"x","cwd":"/workspace"}' \
			'{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"provider auth failed"}}'
		;;
	aborted)
		printf '%s\n' \
			'{"type":"session","version":3,"id":"x","cwd":"/workspace"}' \
			'{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted"}}'
		;;
	empty)
		exit 1
		;;
esac
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= FAKE_EVENT_MODE=ok \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	result="$(env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id")"
	[[ "$result" == $'final answer line one\nline two' ]] ||
		fail_test "projected stdout mismatch: $result"
	[[ -f "$root/state/runs/$run_id/events" ]] || fail_test "events artifact missing"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= FAKE_EVENT_MODE=error \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	set +e
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id" >/dev/null 2>"$root/error.stderr"
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 1 ]] || fail_test "error projection exit=$exit_code; want 1"
	[[ "$(<"$root/error.stderr")" == "provider auth failed" ]] ||
		fail_test "error projection stderr: $(<"$root/error.stderr")"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= FAKE_EVENT_MODE=aborted \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	set +e
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id" >/dev/null 2>&1
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 1 ]] || fail_test "aborted projection exit=$exit_code; want 1"

	start_json="$(env -u PI_SESSION_ID PI_PROVIDER= PI_MODEL= PI_REASONING_LEVEL= FAKE_EVENT_MODE=empty \
		"$SCRIPT" reviewer --no-tools prompt)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	set +e
	env -u PI_SESSION_ID "$SCRIPT" --wait "$run_id" >/dev/null 2>&1
	exit_code=$?
	set -e
	[[ "$exit_code" -eq 1 ]] || fail_test "empty-event projection exit=$exit_code; want 1"

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

	cat > "$fake_bin/pi" <<FAKE_PI
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$calls"
prompt="\${!#}"
case "\$prompt" in
	block)
		printf 'ready\n' > "$ready"
		IFS= read -r _ < "$gate"
		;;
	fail)
		printf 'provider failed\n' >&2
		exit 7
		;;
esac
answer="\$(printf 'answer:%s' "\$prompt")"
printf '{"type":"session","version":3,"id":"x","cwd":"/w"}\n'
printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":%s}],"stopReason":"stop"}}\n' "\$(printf '%s' "\$answer" | jq -Rs .)"
FAKE_PI
	chmod +x "$fake_bin/pi"

	export PATH="$fake_bin:$PATH"
	export PI_CODING_AGENT_DIR="$root/agent"
	export PI_SUB_RUN_DIR="$root/state"
	cd "$project"

	start_json="$("$SCRIPT" reviewer --no-tools block)"
	run_id="$(printf '%s' "$start_json" | json_value runId)"
	[[ -n "$run_id" ]] || fail_test "start response has no runId: $start_json"
	IFS= read -r _ < "$ready"
	status="$("$SCRIPT" --status "$run_id")"
	assert_contains "$status" '"state":"running"'
	tmux list-panes -a -F '#{@name}' 2>/dev/null | grep -Fqx "pi-sub:$run_id" || fail_test "worker pane is not labeled in tmux"
	start_json="$("$SCRIPT" reviewer --no-tools follow-up)"
	second_run_id="$(printf '%s' "$start_json" | json_value runId)"
	status="$("$SCRIPT" --status "$second_run_id")"
	assert_contains "$status" '"state":"queued"'
	[[ "$(wc -l < "$calls" | tr -d ' ')" -eq 1 ]] || fail_test "second run bypassed the session lock"

	printf 'continue\n' > "$gate"
	result="$("$SCRIPT" --wait "$run_id")"
	[[ "$result" == "answer:block" ]] || fail_test "unexpected result: $result"
	tmux list-panes -a -F '#{@name}' 2>/dev/null | grep -Fqx "pi-sub:$run_id" && fail_test "worker tmux pane survived completion"
	result="$("$SCRIPT" --wait "$second_run_id")"
	[[ "$result" == "answer:follow-up" ]] || fail_test "unexpected follow-up result: $result"
	status="$("$SCRIPT" --status "$run_id")"
	assert_contains "$status" '"state":"complete"'
	assert_contains "$status" '"exitCode":0'

	[[ "$(wc -l < "$calls" | tr -d ' ')" -eq 2 ]] || fail_test "expected two pi calls"
	[[ "$(sed -n '1p' "$calls")" == *"--name reviewer"* ]] || fail_test "first call is unnamed"
	[[ "$(sed -n '2p' "$calls")" == *"--name reviewer"* ]] || fail_test "follow-up call is unnamed"
	[[ -n "$(sed -n '1p' "$calls" | sed -n 's/.*--session \([^ ]*\).*/\1/p')" ]] ||
		fail_test "first run has no exact session path"
	[[ "$(sed -n '1p' "$calls" | sed -n 's/.*--session \([^ ]*\).*/\1/p')" == "$(sed -n '2p' "$calls" | sed -n 's/.*--session \([^ ]*\).*/\1/p')" ]] ||
		fail_test "alias did not preserve its session ID"

	start_json="$("$SCRIPT" reviewer --no-tools fail)"
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

command -v tmux >/dev/null 2>&1 || fail_test "tmux is required to run pi-sub tests"

case "${1:-all}" in
	status)
		test_missing_run_is_machine_readable
		;;
	list)
		test_list_empty_runs_dir
		test_list_owner_scope_and_schema
		test_list_lost_detection
		test_list_escapes_json_strings
		;;
	hardening)
		test_missing_status_classification
		test_leading_zero_exit_code_rejected
		test_worker_env_isolation
		test_start_handshake_timeout
		;;
	events)
		test_json_event_projection
		;;
	cancel)
		test_cancel_run
		test_cancel_queued_run
		test_cancel_completed_or_lost_run
		;;
	arguments)
		test_double_dash_cannot_bypass_owned_arguments
		test_pi_argument_boundaries
		;;
	nesting)
		test_nested_run_is_rejected
		;;
	owner)
		test_owner_isolates_same_workspace_alias
		test_owner_metadata_and_child_depth
		;;
	capabilities)
		test_capability_selection_is_required
		test_mutation_requires_write_scope
		test_capability_ceiling_and_metadata
		test_mutation_metadata_and_wrapper_arguments
		test_explicit_model_precedes_environment_default
		test_parent_model_context_is_inherited
		test_explicit_model_does_not_mix_parent_provider
		test_model_thinking_suffix_precedes_parent_reasoning
		;;
	transcript)
		test_durable_session_transcript
		;;
	packaging)
		test_install
		;;
	locking)
		test_alias_lock_is_independent_of_run_root
		test_session_file_is_alias_lock_carrier
		;;
	all)
		test_list_empty_runs_dir
		test_list_owner_scope_and_schema
		test_list_lost_detection
		test_missing_run_is_machine_readable
		test_double_dash_cannot_bypass_owned_arguments
		test_pi_argument_boundaries
		test_nested_run_is_rejected
		test_capability_selection_is_required
		test_mutation_requires_write_scope
		test_capability_ceiling_and_metadata
		test_mutation_metadata_and_wrapper_arguments
		test_explicit_model_precedes_environment_default
		test_parent_model_context_is_inherited
		test_explicit_model_does_not_mix_parent_provider
		test_model_thinking_suffix_precedes_parent_reasoning
		test_durable_session_transcript
		test_install
		test_owner_isolates_same_workspace_alias
		test_owner_metadata_and_child_depth
		test_alias_lock_is_independent_of_run_root
		test_session_file_is_alias_lock_carrier
		test_async_lifecycle
		test_cancel_run
		test_cancel_queued_run
		test_cancel_completed_or_lost_run
		test_missing_status_classification
		test_leading_zero_exit_code_rejected
		test_worker_env_isolation
		test_start_handshake_timeout
		test_json_event_projection
		;;
	*)
		fail_test "unknown test selection: $1"
		;;
esac

printf 'PASS\n'
