package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type failureEnvelope struct {
	OK       bool `json:"ok"`
	ExitCode int  `json:"exitCode"`
	Error    struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Hunk    struct {
			Index      int    `json:"index"`
			Operation  string `json:"operation"`
			Path       string `json:"path"`
			ChunkIndex *int   `json:"chunkIndex,omitempty"`
		} `json:"hunk"`
	} `json:"error"`
	AppliedPrefix []struct {
		Index      int    `json:"index"`
		Operation  string `json:"operation"`
		Path       string `json:"path"`
		OldContent string `json:"oldContent"`
		NewContent string `json:"newContent"`
	} `json:"appliedPrefix"`
	Skipped []struct {
		Message string `json:"message"`
		Hunk    struct {
			Index      int    `json:"index"`
			Operation  string `json:"operation"`
			Path       string `json:"path"`
			ChunkIndex *int   `json:"chunkIndex,omitempty"`
		} `json:"hunk"`
	} `json:"skipped"`
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

func decodeFailure(t *testing.T, stderr string) failureEnvelope {
	t.Helper()
	var failure failureEnvelope
	require.NoError(t, json.Unmarshal([]byte(strings.TrimSpace(stderr)), &failure),
		"failure is not one JSON object; stderr=%s", stderr)
	return failure
}

func requirePatchFailure(t *testing.T, exitCode int, stdout, stderr, code string) failureEnvelope {
	t.Helper()
	require.Equal(t, 1, exitCode)
	assert.Empty(t, stdout)
	failure := decodeFailure(t, stderr)
	assert.False(t, failure.OK)
	assert.Equal(t, 1, failure.ExitCode)
	require.Equal(t, code, failure.Error.Code)
	return failure
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
	assert.Equal(t, 0, failure.Error.Hunk.Index)
	assert.Equal(t, "update", failure.Error.Hunk.Operation)
	assert.Equal(t, "multi.txt", failure.Error.Hunk.Path)
	require.NotNil(t, failure.Error.Hunk.ChunkIndex)
	assert.Equal(t, 1, *failure.Error.Hunk.ChunkIndex)
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
	assert.Equal(t, 0, failure.Error.Hunk.Index)
	assert.Equal(t, "repeat.txt", failure.Error.Hunk.Path)
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
		{"indented control marker", "*** Begin Patch\n *** Add File: bad.txt\n+x\n*** End Patch", "PARTIAL_APPLY"},
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
			assert.Equal(t, tc.wantCode, failure.Error.Code)
			assert.NotEmpty(t, failure.Skipped)
		})
	}
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
			assert.Equal(t, "PARTIAL_APPLY", failure.Error.Code)
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
	assert.Equal(t, 1, failure.Error.Hunk.Index)
	assert.Equal(t, "update", failure.Error.Hunk.Operation)
	assert.Equal(t, "missing.txt", failure.Error.Hunk.Path)
	require.Len(t, failure.AppliedPrefix, 1)
	assert.Equal(t, 0, failure.AppliedPrefix[0].Index)
	assert.Equal(t, "add", failure.AppliedPrefix[0].Operation)
	assert.Equal(t, "hello\n", mustRead(t, created))
}

func TestLineMatchingIsExact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "exact.txt")
	mustWrite(t, path, "value with trailing space \n")
	patch := "*** Begin Patch\n*** Update File: exact.txt\n@@\n-value with trailing space\n+changed\n*** End Patch"

	exitCode, _, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, "", stderr, "CONTEXT_NOT_FOUND")
	assert.Contains(t, failure.Error.Message, "value with trailing space")
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

func TestAppliedPrefixCarriesUpdateContent(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "good.txt"), "old\n")
	patch := "*** Begin Patch\n*** Update File: good.txt\n@@\n-old\n+new\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
	require.Len(t, failure.AppliedPrefix, 2)
	update := failure.AppliedPrefix[0]
	assert.Equal(t, "update", update.Operation)
	assert.Equal(t, "good.txt", update.Path)
	assert.Equal(t, "old\n", update.OldContent)
	assert.Equal(t, "new\n", update.NewContent)
	add := failure.AppliedPrefix[1]
	assert.Equal(t, "add", add.Operation)
	assert.Empty(t, add.OldContent)
	assert.Empty(t, add.NewContent)
}

func TestAppliedPrefixCarriesMoveContent(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "from.txt"), "before\n")
	patch := "*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-before\n+after\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

	exitCode, stdout, stderr := executePatch(t, dir, patch)

	failure := requirePatchFailure(t, exitCode, stdout, stderr, "FILE_NOT_FOUND")
	require.Len(t, failure.AppliedPrefix, 1)
	move := failure.AppliedPrefix[0]
	assert.Equal(t, "update", move.Operation)
	assert.Equal(t, "to.txt", move.Path)
	assert.Equal(t, "before\n", move.OldContent)
	assert.Equal(t, "after\n", move.NewContent)
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
		assert.False(t, failure.OK)
		assert.Equal(t, "PARTIAL_APPLY", failure.Error.Code)
		require.Len(t, failure.Skipped, 1)
		assert.Equal(t, "add", failure.Skipped[0].Hunk.Operation)
		assert.Equal(t, "bad.txt", failure.Skipped[0].Hunk.Path)
		require.Len(t, failure.AppliedPrefix, 2)
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
		assert.Equal(t, "missing.txt", failure.Error.Hunk.Path)
		assert.Empty(t, failure.AppliedPrefix)
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
		assert.Equal(t, "new.txt", failure.Error.Hunk.Path)
		assert.Empty(t, failure.AppliedPrefix)
		_, err := os.Stat(filepath.Join(dir, "other.txt"))
		assert.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("fails when no valid operation remains", func(t *testing.T) {
		patch := "*** Begin Patch\n*** Add File: a.txt\nbad\n*** End Patch"

		exitCode, stdout, stderr := executePatch(t, t.TempDir(), patch)

		require.Equal(t, 1, exitCode)
		assert.Empty(t, stdout)
		failure := decodeFailure(t, stderr)
		assert.Equal(t, "PARTIAL_APPLY", failure.Error.Code)
		require.Len(t, failure.Skipped, 1)
		assert.Empty(t, failure.AppliedPrefix)
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
		assert.Equal(t, "PARTIAL_APPLY", failure.Error.Code)
		require.Len(t, failure.AppliedPrefix, 1)
		assert.Equal(t, "b.txt", failure.AppliedPrefix[0].Path)
		assert.Equal(t, "ok\n", mustRead(t, filepath.Join(dir, "b.txt")))
	})
}
