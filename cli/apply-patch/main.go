package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

type hunkReference struct {
	Index      int    `json:"index"`
	Operation  string `json:"operation,omitempty"`
	Path       string `json:"path,omitempty"`
	ChunkIndex *int   `json:"chunkIndex,omitempty"`
}

type errorPayload struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Hunk    *hunkReference `json:"hunk,omitempty"`
}

type skippedHunk struct {
	Hunk    hunkReference `json:"hunk"`
	Message string        `json:"message"`
}

type failurePayload struct {
	OK            bool            `json:"ok"`
	ExitCode      int             `json:"exitCode"`
	Error         errorPayload    `json:"error"`
	AppliedPrefix []appliedChange `json:"appliedPrefix"`
	Skipped       []skippedHunk   `json:"skipped,omitempty"`
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdin, os.Stdout, os.Stderr, ""))
}

func runCLI(args []string, stdin io.Reader, stdout, stderr io.Writer, cwd string) int {
	patch, exitCode, err := readPatch(args, stdin)
	if err != nil {
		writeFailure(stderr, exitCode, "USAGE", err.Error(), nil, nil, nil)
		return exitCode
	}
	if cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			writeFailure(stderr, 1, "CWD_FAILED", fmt.Sprintf("Failed to determine current directory: %v", err), nil, nil, nil)
			return 1
		}
	}

	hunks, skipped, err := parsePatch(patch)
	if err != nil {
		if len(skipped) > 0 {
			writePartialFailure(stderr, "no valid file operations remain in the patch", nil, skipped)
			return 1
		}
		if parseErr, ok := errors.AsType[*parseFailure](err); ok {
			writeFailure(stderr, 1, "INVALID_PATCH", parseErr.message, parseErr.hunk, nil, nil)
		} else {
			writeFailure(stderr, 1, "INVALID_PATCH", err.Error(), nil, nil, nil)
		}
		return 1
	}
	affected, applied, err := applyHunks(cwd, hunks)
	if err != nil {
		if applyErr, ok := errors.AsType[*applyFailure](err); ok {
			writeFailure(stderr, 1, applyErr.code, applyErr.message, applyErr.hunk, applyErr.applied, skipped)
		} else {
			writeFailure(stderr, 1, "APPLY_FAILED", err.Error(), nil, nil, skipped)
		}
		return 1
	}
	if len(skipped) > 0 {
		writePartialFailure(stderr, fmt.Sprintf("partial apply: %d skipped", len(skipped)), applied, skipped)
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

func writeFailure(writer io.Writer, exitCode int, code, message string, hunk *hunkReference, applied []appliedChange, skipped []skippedHunk) {
	payload := failurePayload{
		OK: false, ExitCode: exitCode,
		Error:         errorPayload{Code: code, Message: message, Hunk: hunk},
		AppliedPrefix: applied,
		Skipped:       skipped,
	}
	if payload.AppliedPrefix == nil {
		payload.AppliedPrefix = []appliedChange{}
	}
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writePartialFailure(writer io.Writer, message string, applied []appliedChange, skipped []skippedHunk) {
	payload := failurePayload{
		OK:            false,
		ExitCode:      1,
		Error:         errorPayload{Code: "PARTIAL_APPLY", Message: message},
		AppliedPrefix: applied,
		Skipped:       skipped,
	}
	if payload.AppliedPrefix == nil {
		payload.AppliedPrefix = []appliedChange{}
	}
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}
