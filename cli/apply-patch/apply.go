package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type appliedChange struct {
	Index      int    `json:"index"`
	Operation  string `json:"operation"`
	Path       string `json:"path"`
	OldContent string `json:"oldContent,omitempty"`
	NewContent string `json:"newContent,omitempty"`
}

type applyFailure struct {
	code    string
	message string
	hunk    *hunkReference
	applied []appliedChange
}

func (failure *applyFailure) Error() string {
	return failure.message
}

type operationFailure struct {
	code    string
	message string
}

func (failure *operationFailure) Error() string {
	return failure.message
}

type affectedPaths struct {
	added    []string
	modified []string
	deleted  []string
}

func applyHunks(cwd string, hunks []patchHunk) (affectedPaths, []appliedChange, error) {
	if len(hunks) == 0 {
		return affectedPaths{}, nil, &applyFailure{code: "NO_CHANGES", message: "No files were modified."}
	}
	workspace, err := filepath.Abs(cwd)
	if err != nil {
		return affectedPaths{}, nil, fmt.Errorf("resolve workspace: %w", err)
	}
	var affected affectedPaths
	var applied []appliedChange
	for _, hunk := range hunks {
		path, err := cleanPatchPath(hunk.path)
		if err != nil {
			return affected, applied, hunkFailure(hunk, "INVALID_PATH", err.Error(), nil, applied)
		}
		oldContent, newContent, err := applyHunk(workspace, path, hunk)
		if err != nil {
			code, message, chunkIndex := classifyApplyError(hunk, err)
			return affected, applied, hunkFailure(hunk, code, message, chunkIndex, applied)
		}

		resultPath := hunk.path
		if hunk.movePath != "" {
			resultPath = hunk.movePath
		}
		applied = append(applied, appliedChange{
			Index:      hunk.index,
			Operation:  string(hunk.operation),
			Path:       resultPath,
			OldContent: oldContent,
			NewContent: newContent,
		})
		switch hunk.operation {
		case operationAdd:
			affected.added = append(affected.added, resultPath)
		case operationDelete:
			affected.deleted = append(affected.deleted, resultPath)
		case operationUpdate:
			affected.modified = append(affected.modified, resultPath)
		}
	}
	return affected, applied, nil
}

func applyHunk(workspace, path string, hunk patchHunk) (string, string, error) {
	workspacePath := resolvePatchPath(workspace, path)
	switch hunk.operation {
	case operationAdd:
		if _, err := os.Lstat(workspacePath); err == nil {
			return "", "", &operationFailure{code: "TARGET_EXISTS", message: fmt.Sprintf("Add File target already exists: %s", path)}
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", "", err
		}
		return "", "", atomicWrite(workspacePath, hunk.content, 0o644, false)
	case operationDelete:
		info, err := os.Lstat(workspacePath)
		if err != nil {
			return "", "", fmt.Errorf("delete file %s: %w", path, err)
		}
		if info.IsDir() {
			return "", "", fmt.Errorf("delete file %s: path is a directory", path)
		}
		return "", "", os.Remove(workspacePath)
	case operationUpdate:
		return applyUpdateHunk(workspace, path, hunk)
	default:
		return "", "", fmt.Errorf("unsupported operation %q", hunk.operation)
	}
}

func applyUpdateHunk(workspace, path string, hunk patchHunk) (string, string, error) {
	sourcePath := resolvePatchPath(workspace, path)
	resolvedSource, err := filepath.EvalSymlinks(sourcePath)
	if err != nil {
		return "", "", fmt.Errorf("resolve file to update %s: %w", path, err)
	}

	destination := ""
	destinationPath := ""
	if hunk.movePath != "" {
		destination, err = cleanPatchPath(hunk.movePath)
		if err != nil {
			return "", "", &operationFailure{code: "INVALID_PATH", message: err.Error()}
		}
		if destination == path {
			return "", "", &operationFailure{code: "MOVE_PATH_INVALID", message: "Move source and destination must differ"}
		}
		destinationPath = resolvePatchPath(workspace, destination)
		if _, err := os.Lstat(destinationPath); err == nil {
			return "", "", &operationFailure{code: "DESTINATION_EXISTS", message: fmt.Sprintf("Move destination already exists: %s", destination)}
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", "", err
		}
	}

	content, err := os.ReadFile(resolvedSource)
	if err != nil {
		return "", "", fmt.Errorf("read file to update %s: %w", path, err)
	}
	updated := content
	if len(hunk.chunks) > 0 {
		updated, err = deriveUpdatedContent(updated, path, hunk.chunks)
		if err != nil {
			return "", "", err
		}
	}
	info, err := os.Stat(resolvedSource)
	if err != nil {
		return "", "", fmt.Errorf("stat file to update %s: %w", path, err)
	}
	if destination == "" {
		return string(content), string(updated), atomicWrite(resolvedSource, updated, info.Mode().Perm(), true)
	}
	if err := atomicWrite(destinationPath, updated, info.Mode().Perm(), false); err != nil {
		return "", "", fmt.Errorf("write move destination %s: %w", destination, err)
	}
	if err := os.Remove(sourcePath); err != nil {
		return "", "", fmt.Errorf("remove move source %s: %w", path, err)
	}
	return string(content), string(updated), nil
}

func cleanPatchPath(path string) (string, error) {
	if path == "" {
		return "", errors.New("patch path must not be empty")
	}
	if strings.HasPrefix(path, "~") || strings.ContainsAny(path, "$`*?[]") {
		return "", fmt.Errorf("patch path contains expansion or glob syntax: %s", path)
	}
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) && (path == "." || path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator))) {
		return "", fmt.Errorf("patch path escapes workspace: %s", path)
	}
	return path, nil
}

func resolvePatchPath(workspace, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(workspace, path)
}

func atomicWrite(path string, content []byte, mode os.FileMode, replace bool) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	temporary, err := writeTemporary(directory, content, mode)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)

	if replace {
		return os.Rename(temporary, path)
	}
	return os.Link(temporary, path)
}

func writeTemporary(directory string, content []byte, mode os.FileMode) (name string, err error) {
	file, err := os.CreateTemp(directory, ".apply-patch-*")
	if err != nil {
		return "", err
	}
	name = file.Name()
	closed := false
	defer func() {
		if !closed {
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
		}
		if err != nil {
			_ = os.Remove(name)
		}
	}()

	if err = file.Chmod(mode); err != nil {
		return "", err
	}
	if _, err = file.Write(content); err != nil {
		return "", err
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	err = file.Close()
	closed = true
	if err != nil {
		return "", err
	}
	return name, nil
}

func classifyApplyError(hunk patchHunk, err error) (string, string, *int) {
	if operation, ok := errors.AsType[*operationFailure](err); ok {
		return operation.code, operation.message, nil
	}
	if match, ok := errors.AsType[*matchFailure](err); ok {
		return "CONTEXT_NOT_FOUND", match.message, new(match.chunkIndex)
	}
	if errors.Is(err, os.ErrNotExist) {
		return "FILE_NOT_FOUND", err.Error(), nil
	}
	switch hunk.operation {
	case operationDelete:
		return "DELETE_FAILED", err.Error(), nil
	case operationAdd:
		return "WRITE_FAILED", err.Error(), nil
	case operationUpdate:
		return "UPDATE_FAILED", err.Error(), nil
	default:
		return "IO_ERROR", err.Error(), nil
	}
}

func hunkFailure(hunk patchHunk, code, message string, chunkIndex *int, applied []appliedChange) error {
	reference := hunk.reference()
	reference.ChunkIndex = chunkIndex
	return &applyFailure{code: code, message: message, hunk: &reference, applied: append([]appliedChange(nil), applied...)}
}

func (hunk patchHunk) reference() hunkReference {
	return hunkReference{Index: hunk.index, Operation: string(hunk.operation), Path: hunk.path}
}
