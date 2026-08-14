package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

type hunkReference struct {
	Index      int
	Operation  string
	Path       string
	ChunkIndex *int
}

type skippedHunk struct {
	Hunk    hunkReference
	Message string
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdin, os.Stdout, os.Stderr, ""))
}

func runCLI(args []string, stdin io.Reader, stdout, stderr io.Writer, cwd string) int {
	patch, exitCode, err := readPatch(args, stdin)
	if err != nil {
		writeFailure(stderr, "USAGE", err.Error(), nil, nil, nil)
		return exitCode
	}
	if cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			writeFailure(stderr, "CWD_FAILED", fmt.Sprintf("Failed to determine current directory: %v", err), nil, nil, nil)
			return 1
		}
	}

	hunks, skipped, err := parsePatch(patch)
	if err != nil {
		if len(skipped) > 0 {
			writeFailure(stderr, "PARTIAL_APPLY", "no valid file operations remain in the patch", nil, nil, skipped)
			return 1
		}
		if parseErr, ok := errors.AsType[*parseFailure](err); ok {
			writeFailure(stderr, "INVALID_PATCH", parseErr.message, parseErr.hunk, nil, nil)
		} else {
			writeFailure(stderr, "INVALID_PATCH", err.Error(), nil, nil, nil)
		}
		return 1
	}
	affected, applied, err := applyHunks(cwd, hunks)
	if err != nil {
		if applyErr, ok := errors.AsType[*applyFailure](err); ok {
			writeFailure(stderr, applyErr.code, applyErr.message, applyErr.hunk, applyErr.applied, skipped)
		} else {
			writeFailure(stderr, "APPLY_FAILED", err.Error(), nil, nil, skipped)
		}
		return 1
	}
	if len(skipped) > 0 {
		writeFailure(stderr, "PARTIAL_APPLY", fmt.Sprintf("partial apply: %d skipped", len(skipped)), nil, applied, skipped)
		return 1
	}
	writeSuccess(stdout, affected)
	return 0
}

func readPatch(args []string, stdin io.Reader) (string, int, error) {
	if len(args) > 1 {
		return "", 2, errors.New("apply_patch accepts exactly one argument")
	}
	var patch string
	if len(args) == 1 {
		patch = args[0]
	} else {
		content, err := io.ReadAll(stdin)
		if err != nil {
			return "", 1, fmt.Errorf("failed to read PATCH from stdin: %w", err)
		}
		patch = string(content)
	}
	if len(patch) == 0 {
		return "", 2, errors.New("usage: apply_patch 'PATCH'; echo 'PATCH' | apply_patch")
	}
	if !utf8.ValidString(patch) {
		return "", 1, errors.New("apply_patch requires UTF-8 PATCH input")
	}
	if strings.Contains(patch, "\r\n") {
		patch = strings.ReplaceAll(patch, "\r\n", "\n")
	}
	if strings.ContainsRune(patch, '\r') {
		return "", 1, errors.New("apply_patch PATCH input contains an unsupported CR character")
	}
	patch = strings.TrimSuffix(patch, "\n")
	return patch, 0, nil
}

func toLF(src []byte) []byte {
	if !bytes.Contains(src, []byte{'\r', '\n'}) {
		return src
	}
	return bytes.ReplaceAll(src, []byte{'\r', '\n'}, []byte{'\n'})
}

// Output is plain text: success on stdout, failure on stderr. Exit status is
// carried by the process exit code, not repeated in the output.
//
// Success: a marker line followed by one change per line (added, then
// modified, then deleted; status is A, M, or D; path is the rest of the
// line):
//
//	Success. Updated the following files:
//	M example.txt
//
// Failure: an error[CODE] header, an optional hunk reference, one line per
// applied change, one per skipped hunk, and the message last (it can span
// multiple lines and runs to EOF):
//
//	error[CONTEXT_NOT_FOUND]
//	hunk: #0 update chunk 1 example.txt
//	applied: #0 add other.txt
//	skipped: #1 update chunk 0 third.txt — Invalid patch hunk on line 3: ...
//	message: Failed to find expected lines in example.txt
//
// Hunk references are `#<index>` followed by optional `<operation>`,
// `chunk <n>`, and path fields in that order; the path is always the rest of
// the line and may contain spaces.
func writeSuccess(writer io.Writer, affected affectedPaths) {
	fmt.Fprintln(writer, "Success. Updated the following files:")
	for _, path := range affected.added {
		fmt.Fprintf(writer, "A %s\n", path)
	}
	for _, path := range affected.modified {
		fmt.Fprintf(writer, "M %s\n", path)
	}
	for _, path := range affected.deleted {
		fmt.Fprintf(writer, "D %s\n", path)
	}
}

func formatHunkReference(prefix string, hunk hunkReference) string {
	var b strings.Builder
	b.Grow(len(prefix) + len(hunk.Operation) + len(hunk.Path) + 24)
	b.WriteString(prefix)
	b.WriteByte('#')
	b.WriteString(strconv.Itoa(hunk.Index))
	if hunk.Operation != "" {
		b.WriteByte(' ')
		b.WriteString(hunk.Operation)
	}
	if hunk.ChunkIndex != nil {
		b.WriteString(" chunk ")
		b.WriteString(strconv.Itoa(*hunk.ChunkIndex))
	}
	if hunk.Path != "" {
		b.WriteByte(' ')
		b.WriteString(hunk.Path)
	}
	return b.String()
}

func writeFailure(writer io.Writer, code, message string, hunk *hunkReference, applied []appliedChange, skipped []skippedHunk) {
	fmt.Fprintf(writer, "error[%s]\n", code)
	if hunk != nil {
		fmt.Fprintln(writer, formatHunkReference("hunk: ", *hunk))
	}
	for _, change := range applied {
		fmt.Fprintf(writer, "applied: #%d %s %s\n", change.Index, change.Operation, change.Path)
	}
	for _, skip := range skipped {
		fmt.Fprintf(writer, "%s — %s\n", formatHunkReference("skipped: ", skip.Hunk), skip.Message)
	}
	fmt.Fprintf(writer, "message: %s\n", message)
}
