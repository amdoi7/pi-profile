package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type hunkRef struct {
	Index      int
	Operation  string
	ChunkIndex *int
	Path       string
}

type appliedEntry struct {
	Index     int
	Operation string
	Path      string
}

type skippedEntry struct {
	Hunk    hunkRef
	Message string
}

type failureReport struct {
	Code    string
	Message string
	Hunk    *hunkRef
	Applied []appliedEntry
	Skipped []skippedEntry
}

func executePatch(t *testing.T, cwd, patch string) (int, string, string) {
	t.Helper()
	return executePatchArgs(t, cwd, []string{patch})
}

func executePatchArgs(t *testing.T, cwd string, args []string) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := runCLI(args, strings.NewReader(""), &stdout, &stderr, cwd)
	return exitCode, stdout.String(), stderr.String()
}

var errorHeaderPattern = regexp.MustCompile(`^error\[([A-Z_]+)\]$`)
var hunkIndexPattern = regexp.MustCompile(`^#(\d+)`)

// parseHunkRef parses `#<index>[ <operation>][ chunk <n>][ <path>]`
// (field order fixed; path is the rest of the line and may contain spaces).
func parseHunkRef(t *testing.T, text string) hunkRef {
	t.Helper()
	m := hunkIndexPattern.FindStringSubmatch(text)
	require.NotNil(t, m, "hunk reference must start with #<index>: %q", text)
	index, err := strconv.Atoi(m[1])
	require.NoError(t, err)
	ref := hunkRef{Index: index}
	rest := text[len(m[0]):]
	if rest == "" {
		return ref
	}
	require.True(t, strings.HasPrefix(rest, " "), "hunk reference fields are space separated: %q", text)
	rest = rest[1:]
	for _, operation := range []string{"add", "delete", "update"} {
		if rest == operation || strings.HasPrefix(rest, operation+" ") {
			ref.Operation = operation
			rest = strings.TrimPrefix(rest, operation)
			if rest != "" {
				rest = rest[1:]
			}
			break
		}
	}
	if chunkPart, ok := strings.CutPrefix(rest, "chunk "); ok {
		if idx := strings.IndexByte(chunkPart, ' '); idx >= 0 {
			n, err := strconv.Atoi(chunkPart[:idx])
			require.NoError(t, err, "chunk index in %q", text)
			ref.ChunkIndex = &n
			rest = chunkPart[idx+1:]
		} else {
			n, err := strconv.Atoi(chunkPart)
			require.NoError(t, err, "chunk index in %q", text)
			ref.ChunkIndex = &n
			rest = ""
		}
	}
	if rest != "" {
		ref.Path = rest
	}
	return ref
}

func decodeFailure(t *testing.T, stderr string) failureReport {
	t.Helper()
	lines := strings.Split(strings.TrimSuffix(stderr, "\n"), "\n")
	require.NotEmpty(t, lines)
	header := errorHeaderPattern.FindStringSubmatch(lines[0])
	require.NotNil(t, header, "failure must start with error[CODE]; stderr=%s", stderr)
	report := failureReport{Code: header[1]}
	cursor := 1
	for cursor < len(lines) {
		line := lines[cursor]
		switch {
		case strings.HasPrefix(line, "hunk: "):
			ref := parseHunkRef(t, strings.TrimPrefix(line, "hunk: "))
			report.Hunk = &ref
		case strings.HasPrefix(line, "applied: "):
			body := strings.TrimPrefix(line, "applied: ")
			m := hunkIndexPattern.FindStringSubmatch(body)
			require.NotNil(t, m, "applied line: %q", line)
			index, err := strconv.Atoi(m[1])
			require.NoError(t, err)
			operation, path, found := strings.Cut(strings.TrimPrefix(body[len(m[0]):], " "), " ")
			require.True(t, found, "applied line carries operation and path: %q", line)
			report.Applied = append(report.Applied, appliedEntry{Index: index, Operation: operation, Path: path})
		case strings.HasPrefix(line, "skipped: "):
			body := strings.TrimPrefix(line, "skipped: ")
			refText, message, found := strings.Cut(body, " — ")
			require.True(t, found, "skipped line separates hunk and message with ' — ': %q", line)
			report.Skipped = append(report.Skipped, skippedEntry{Hunk: parseHunkRef(t, refText), Message: message})
		case strings.HasPrefix(line, "message: "):
			report.Message = strings.TrimPrefix(line, "message: ")
			if cursor+1 < len(lines) {
				report.Message += "\n" + strings.Join(lines[cursor+1:], "\n")
			}
			return report
		default:
			t.Fatalf("unexpected failure report line %q", line)
		}
		cursor++
	}
	t.Fatalf("failure report missing message line; stderr=%s", stderr)
	return report
}

func requirePatchFailure(t *testing.T, exitCode int, stdout, stderr, code string) failureReport {
	t.Helper()
	require.Equal(t, 1, exitCode)
	assert.Empty(t, stdout)
	report := decodeFailure(t, stderr)
	require.Equal(t, code, report.Code)
	return report
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	return string(content)
}

func TestFormatHunkReference(t *testing.T) {
	chunk := func(n int) *int { return &n }
	tests := []struct {
		prefix string
		hunk   hunkReference
		want   string
	}{
		{"hunk: ", hunkReference{Index: 0}, "hunk: #0"},
		{"hunk: ", hunkReference{Index: 1, Operation: "add"}, "hunk: #1 add"},
		{"hunk: ", hunkReference{Index: 2, ChunkIndex: chunk(0)}, "hunk: #2 chunk 0"},
		{"hunk: ", hunkReference{Index: 3, Operation: "update", ChunkIndex: chunk(1), Path: "dir/name with spaces.txt"}, "hunk: #3 update chunk 1 dir/name with spaces.txt"},
		{"skipped: ", hunkReference{Index: 4, Operation: "delete", Path: "gone.txt"}, "skipped: #4 delete gone.txt"},
		{"", hunkReference{Index: 5, Path: "p"}, "#5 p"},
	}
	for _, tc := range tests {
		assert.Equal(t, tc.want, formatHunkReference(tc.prefix, tc.hunk))
	}
}

func TestUpdateWithConflictingSecondChunkDoesNotWriteFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "multi.txt")
	original := "one\ntwo\nthree\nfour\n"
	mustWrite(t, path, original)
	patch := `*** Begin Patch
*** Update File: multi.txt
@@
-two
+TWO
@@
-missing
+FOUR
*** End Patch`

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, stdout, stderr, "CONTEXT_NOT_FOUND")
	assert.Equal(t, 0, failure.Hunk.Index)
	assert.Equal(t, "update", failure.Hunk.Operation)
	assert.Equal(t, "multi.txt", failure.Hunk.Path)
	require.NotNil(t, failure.Hunk.ChunkIndex)
	assert.Equal(t, 1, *failure.Hunk.ChunkIndex)
	assert.Equal(t, original, mustRead(t, path))
}

func TestCRLFContextAppliesUsingCodexLineMatching(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "windows.txt")
	mustWrite(t, path, "alpha\r\nbeta\r\n")
	patch := `*** Begin Patch
*** Update File: windows.txt
@@
 alpha
-beta
+gamma
*** End Patch`

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	require.Zero(t, exitCode)
	assert.Empty(t, stderr)
	assert.Equal(t, "Success. Updated the following files:\nM windows.txt\n", stdout)
	assert.Equal(t, "alpha\ngamma\n", mustRead(t, path))
}

func TestMoveRenamesFile(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "old", "name.txt")
	destination := filepath.Join(dir, "renamed", "name.txt")
	mustWrite(t, source, "old content\n")
	patch := `*** Begin Patch
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-old content
+new content
*** End Patch`

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	require.Zero(t, exitCode)
	assert.Empty(t, stderr)
	assert.Equal(t, "Success. Updated the following files:\nM renamed/name.txt\n", stdout)
	_, err := os.Stat(source)
	assert.ErrorIs(t, err, os.ErrNotExist)
	assert.Equal(t, "new content\n", mustRead(t, destination))
}

func TestRepeatedPatchReturnsFailedHunkAndLeavesFirstResult(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "repeat.txt")
	mustWrite(t, path, "before\n")
	patch := `*** Begin Patch
*** Update File: repeat.txt
@@
-before
+after
*** End Patch`

	firstExit, _, firstStderr := executePatch(t, dir, patch)
	secondExit, secondStdout, secondStderr := executePatch(t, dir, patch)

	require.Zero(t, firstExit)
	assert.Empty(t, firstStderr)
	failure := requirePatchFailure(t, secondExit, secondStdout, secondStderr, "CONTEXT_NOT_FOUND")
	assert.Equal(t, 0, failure.Hunk.Index)
	assert.Equal(t, "repeat.txt", failure.Hunk.Path)
	assert.Equal(t, "after\n", mustRead(t, path))
}

func TestLexicalContractAndCRLFInput(t *testing.T) {
	t.Run("CRLF patch input is normalized", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "target.txt")
		mustWrite(t, path, "before\n")
		patch := strings.ReplaceAll(`*** Begin Patch
*** Update File: target.txt
@@
-before
+after
*** End Patch`, "\n", "\r\n")

		exitCode, _, stderr := executePatch(t, dir, patch)

		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Equal(t, "after\n", mustRead(t, path))
	})

	invalidPatches := []struct {
		name     string
		patch    string
		wantCode string
	}{
		{"indented content line", "*** Begin Patch\n*** Add File: bad.txt\n  +x\n*** End Patch", "PARTIAL_APPLY"},
		{"path has trailing whitespace", "*** Begin Patch\n*** Add File: bad.txt \n+x\n*** End Patch", "PARTIAL_APPLY"},
		{"content before envelope", "\n*** Begin Patch\n*** Add File: bad.txt\n+x\n*** End Patch", "INVALID_PATCH"},
	}
	for _, tc := range invalidPatches {
		t.Run(tc.name, func(t *testing.T) {
			exitCode, stdout, stderr := executePatch(t, t.TempDir(), tc.patch)
			if tc.wantCode == "INVALID_PATCH" {
				requirePatchFailure(t, exitCode, stdout, stderr, tc.wantCode)
				return
			}
			require.Equal(t, 1, exitCode)
			assert.Empty(t, stdout)
			failure := decodeFailure(t, stderr)
			assert.Equal(t, tc.wantCode, failure.Code)
			assert.NotEmpty(t, failure.Skipped)
		})
	}
}

func TestIndentedControlLinesApply(t *testing.T) {
	// 指令行（*** / @@）允许前导空白（heredoc 整体缩进）；内容行保持严格（line[0] 即标记）。
	t.Run("update with indented control lines", func(t *testing.T) {
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, "a.txt"), "old\n")
		patch := "  *** Begin Patch\n  *** Update File: a.txt\n  @@\n-old\n+new\n  *** End Patch"
		exitCode, stdout, stderr := executePatch(t, dir, patch)
		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Contains(t, stdout, "M a.txt")
		assert.Equal(t, "new\n", mustRead(t, filepath.Join(dir, "a.txt")))
	})
	t.Run("add with indented control lines", func(t *testing.T) {
		dir := t.TempDir()
		patch := "*** Begin Patch\n   *** Add File: new.txt\n+content\n   *** End Patch"
		exitCode, stdout, stderr := executePatch(t, dir, patch)
		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Contains(t, stdout, "A new.txt")
		assert.Equal(t, "content\n", mustRead(t, filepath.Join(dir, "new.txt")))
	})
}

func TestUniformIndentedPatchApplies(t *testing.T) {
	// heredoc 整体统一缩进（指令行 + 内容行同步前移）：按统一前缀 N 剥除后按标准规则解析。
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.ts"), "foo();\n});\n")
	patch := " *** Begin Patch\n *** Update File: a.ts\n @@\n -foo();\n +bar();\n  });\n *** End Patch"
	exitCode, stdout, stderr := executePatch(t, dir, patch)
	require.Zero(t, exitCode)
	assert.Empty(t, stderr)
	assert.Contains(t, stdout, "M a.ts")
	assert.Equal(t, "bar();\n});\n", mustRead(t, filepath.Join(dir, "a.ts")))
}

func TestWorkspaceAndAddSafety(t *testing.T) {
	t.Run("absolute path outside workspace is allowed", func(t *testing.T) {
		root := t.TempDir()
		workspace := filepath.Join(root, "workspace")
		target := filepath.Join(root, "memory", "issues.md")
		require.NoError(t, os.Mkdir(workspace, 0o755))
		mustWrite(t, target, "before\n")
		patch := fmt.Sprintf("*** Begin Patch\n*** Update File: %s\n@@\n-before\n+after\n*** End Patch", target)

		exitCode, stdout, stderr := executePatch(t, workspace, patch)

		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Equal(t, fmt.Sprintf("Success. Updated the following files:\nM %s\n", target), stdout)
		assert.Equal(t, "after\n", mustRead(t, target))
	})

	t.Run("parent traversal is rejected", func(t *testing.T) {
		root := t.TempDir()
		workspace := filepath.Join(root, "workspace")
		require.NoError(t, os.Mkdir(workspace, 0o755))
		patch := "*** Begin Patch\n*** Add File: ../outside.txt\n+outside\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, workspace, patch)

		requirePatchFailure(t, exitCode, stdout, stderr, "INVALID_PATH")
		_, err := os.Stat(filepath.Join(root, "outside.txt"))
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("Add File refuses an existing target", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "existing.txt")
		mustWrite(t, path, "original\n")
		patch := "*** Begin Patch\n*** Add File: existing.txt\n+replacement\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		requirePatchFailure(t, exitCode, stdout, stderr, "TARGET_EXISTS")
		assert.Equal(t, "original\n", mustRead(t, path))
	})
}

func TestUpdateSemanticValidation(t *testing.T) {
	patches := []string{
		"*** Begin Patch\n*** Update File: target.txt\n@@\n unchanged\n*** End Patch",
		"*** Begin Patch\n*** Update File: target.txt\n@@\n-old\n+new\n*** End of File\n@@\n-tail\n+TAIL\n*** End Patch",
	}
	for i, patch := range patches {
		t.Run(fmt.Sprintf("case %d", i), func(t *testing.T) {
			dir := t.TempDir()
			mustWrite(t, filepath.Join(dir, "target.txt"), "unchanged\nold\ntail\n")

			exitCode, stdout, stderr := executePatch(t, dir, patch)
			require.Equal(t, 1, exitCode)
			assert.Empty(t, stdout)
			failure := decodeFailure(t, stderr)
			assert.Equal(t, "PARTIAL_APPLY", failure.Code)
			assert.NotEmpty(t, failure.Skipped)
		})
	}
}

func TestMoveSafety(t *testing.T) {
	t.Run("destination must not exist", func(t *testing.T) {
		dir := t.TempDir()
		source := filepath.Join(dir, "source.txt")
		destination := filepath.Join(dir, "destination.txt")
		mustWrite(t, source, "source\n")
		mustWrite(t, destination, "destination\n")
		patch := "*** Begin Patch\n*** Update File: source.txt\n*** Move to: destination.txt\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		requirePatchFailure(t, exitCode, stdout, stderr, "DESTINATION_EXISTS")
		assert.Equal(t, "source\n", mustRead(t, source))
		assert.Equal(t, "destination\n", mustRead(t, destination))
	})

	t.Run("source and destination must differ", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "same.txt")
		mustWrite(t, path, "same\n")
		patch := "*** Begin Patch\n*** Update File: same.txt\n*** Move to: same.txt\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		requirePatchFailure(t, exitCode, stdout, stderr, "MOVE_PATH_INVALID")
		assert.Equal(t, "same\n", mustRead(t, path))
	})
}

func TestLaterFailureReportsAndPreservesAppliedPrefix(t *testing.T) {
	dir := t.TempDir()
	created := filepath.Join(dir, "created.txt")
	patch := `*** Begin Patch
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch`

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
	assert.Equal(t, 1, failure.Hunk.Index)
	assert.Equal(t, "update", failure.Hunk.Operation)
	assert.Equal(t, "missing.txt", failure.Hunk.Path)
	require.Len(t, failure.Applied, 1)
	assert.Equal(t, 0, failure.Applied[0].Index)
	assert.Equal(t, "add", failure.Applied[0].Operation)
	assert.Equal(t, "hello\n", mustRead(t, created))
}

func TestLineMatchingIsExact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exact.txt")
	mustWrite(t, path, "value with trailing space \n")
	patch := "*** Begin Patch\n*** Update File: exact.txt\n@@\n-value with trailing space\n+changed\n*** End Patch"

	exitCode, _, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, "", stderr, "CONTEXT_NOT_FOUND")
	assert.Contains(t, failure.Message, "value with trailing space")
	assert.Equal(t, "value with trailing space \n", mustRead(t, path))
}

func TestTrailingEmptyLineFallback(t *testing.T) {
	t.Run("replacement at end of file without a final newline", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "eof.txt")
		mustWrite(t, path, "foo\n")
		patch := "*** Begin Patch\n*** Update File: eof.txt\n@@\n-foo\n-\n+bar\n+\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Equal(t, "Success. Updated the following files:\nM eof.txt\n", stdout)
		assert.Equal(t, "bar\n", mustRead(t, path))
	})

	t.Run("mid-file empty line is still matched verbatim", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "mid.txt")
		mustWrite(t, path, "alpha\n\nomega\n")
		patch := "*** Begin Patch\n*** Update File: mid.txt\n@@\n-alpha\n-\n+ALPHA\n+\n*** End Patch"

		exitCode, _, stderr := executePatch(t, dir, patch)

		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Equal(t, "ALPHA\n\nomega\n", mustRead(t, path))
	})
}

func TestAppliedPrefixReportsUpdateAndAdd(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "good.txt"), "old\n")
	patch := "*** Begin Patch\n*** Update File: good.txt\n@@\n-old\n+new\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
	require.Len(t, failure.Applied, 2)
	update := failure.Applied[0]
	assert.Equal(t, "update", update.Operation)
	assert.Equal(t, "good.txt", update.Path)
	add := failure.Applied[1]
	assert.Equal(t, "add", add.Operation)
	assert.Equal(t, "created.txt", add.Path)
}

func TestAppliedPrefixReportsMoveDestination(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "from.txt"), "before\n")
	patch := "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
	require.Len(t, failure.Applied, 1)
	move := failure.Applied[0]
	assert.Equal(t, "update", move.Operation)
	assert.Equal(t, "to.txt", move.Path)
}

func TestWorkspaceSymlinkUpdateFollowsAndPreservesTarget(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	target := filepath.Join(root, "outside", "secret.txt")
	link := filepath.Join(workspace, "linked.txt")
	require.NoError(t, os.Mkdir(workspace, 0o755))
	mustWrite(t, target, "unchanged\n")
	require.NoError(t, os.Symlink(target, link))
	patch := "*** Begin Patch\n*** Update File: linked.txt\n@@\n-unchanged\n+changed\n*** End Patch"

	exitCode, stdout, stderr := executePatch(t, workspace, patch)

	require.Zero(t, exitCode)
	assert.Empty(t, stderr)
	assert.Equal(t, "Success. Updated the following files:\nM linked.txt\n", stdout)
	assert.Equal(t, "changed\n", mustRead(t, target))
	info, err := os.Lstat(link)
	require.NoError(t, err)
	assert.NotZero(t, info.Mode()&os.ModeSymlink)
}

func TestContinueOnError(t *testing.T) {
	t.Run("skips a syntactically invalid hunk and applies the rest", func(t *testing.T) {
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, "good.txt"), "old\n")
		patch := "*** Begin Patch\n*** Update File: good.txt\n@@\n-old\n+new\n*** Add File: bad.txt\nnot a plus line\n*** Add File: created.txt\n+hello\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		require.Equal(t, 1, exitCode)
		assert.Empty(t, stdout)
		failure := decodeFailure(t, stderr)
		assert.Equal(t, "PARTIAL_APPLY", failure.Code)
		require.Len(t, failure.Skipped, 1)
		assert.Equal(t, "add", failure.Skipped[0].Hunk.Operation)
		assert.Equal(t, "bad.txt", failure.Skipped[0].Hunk.Path)
		require.Len(t, failure.Applied, 2)
		assert.Equal(t, "new\n", mustRead(t, filepath.Join(dir, "good.txt")))
		assert.Equal(t, "hello\n", mustRead(t, filepath.Join(dir, "created.txt")))
		_, err := os.Stat(filepath.Join(dir, "bad.txt"))
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("stops at the first apply failure", func(t *testing.T) {
		dir := t.TempDir()
		patch := "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** Add File: created.txt\n+hello\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
		assert.Equal(t, "missing.txt", failure.Hunk.Path)
		assert.Empty(t, failure.Applied)
		_, err := os.Stat(filepath.Join(dir, "created.txt"))
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("reports skipped operations alongside the first apply failure", func(t *testing.T) {
		dir := t.TempDir()
		patch := "*** Begin Patch\n*** Add File: new.txt\nbad line\n*** Update File: new.txt\n@@\n-old\n+new\n*** Add File: other.txt\n+ok\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
		require.Len(t, failure.Skipped, 1)
		assert.Equal(t, "new.txt", failure.Skipped[0].Hunk.Path)
		assert.Equal(t, "new.txt", failure.Hunk.Path)
		assert.Empty(t, failure.Applied)
		_, err := os.Stat(filepath.Join(dir, "other.txt"))
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("fails when no valid operation remains", func(t *testing.T) {
		patch := "*** Begin Patch\n*** Add File: a.txt\nbad\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, t.TempDir(), patch)

		require.Equal(t, 1, exitCode)
		assert.Empty(t, stdout)
		failure := decodeFailure(t, stderr)
		assert.Equal(t, "PARTIAL_APPLY", failure.Code)
		require.Len(t, failure.Skipped, 1)
		assert.Empty(t, failure.Applied)
	})

	t.Run("envelope-level errors still fail wholesale", func(t *testing.T) {
		patch := "*** Add File: a.txt\n+x\n"

		exitCode, stdout, stderr := executePatch(t, t.TempDir(), patch)

		requirePatchFailure(t, exitCode, stdout, stderr, "INVALID_PATCH")
	})

	t.Run("applies cleanly when nothing is skipped or failed", func(t *testing.T) {
		dir := t.TempDir()
		patch := "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, dir, patch)

		require.Zero(t, exitCode)
		assert.Empty(t, stderr)
		assert.Equal(t, "Success. Updated the following files:\nA a.txt\n", stdout)
	})

	t.Run("accepts piped stdin with degradation", func(t *testing.T) {
		dir := t.TempDir()
		patch := "*** Begin Patch\n*** Add File: a.txt\nbad\n*** Add File: b.txt\n+ok\n*** End Patch"

		var stdout bytes.Buffer
		var stderr bytes.Buffer
		exitCode := runCLI(nil, strings.NewReader(patch), &stdout, &stderr, dir)

		require.Equal(t, 1, exitCode)
		assert.Empty(t, stdout)
		failure := decodeFailure(t, stderr.String())
		assert.Equal(t, "PARTIAL_APPLY", failure.Code)
		require.Len(t, failure.Applied, 1)
		assert.Equal(t, "b.txt", failure.Applied[0].Path)
		assert.Equal(t, "ok\n", mustRead(t, filepath.Join(dir, "b.txt")))
	})
}
