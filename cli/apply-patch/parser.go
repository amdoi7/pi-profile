package main

import (
	"fmt"
	"strings"
)

type operationKind string

const (
	operationAdd    operationKind = "add"
	operationDelete operationKind = "delete"
	operationUpdate operationKind = "update"

	beginPatch  = "*** Begin Patch"
	endPatch    = "*** End Patch"
	addFile     = "*** Add File: "
	deleteFile  = "*** Delete File: "
	updateFile  = "*** Update File: "
	moveTo      = "*** Move to: "
	section     = "@@"
	sectionWith = "@@ "
	endOfFile   = "*** End of File"
)

type patchHunk struct {
	index     int
	operation operationKind
	path      string
	movePath  string
	content   []byte
	chunks    []updateChunk
}

type updateChunk struct {
	index       int
	context     string
	hasContext  bool
	lines       []updateLine
	isEndOfFile bool
}

type updateLine struct {
	prefix byte
	text   string
}

type parseFailure struct {
	message string
	hunk    *hunkReference
}

func (failure *parseFailure) Error() string {
	return failure.message
}

func parsePatch(input string) ([]patchHunk, error) {
	lines := strings.Split(input, "\n")
	if len(lines) == 0 || lines[0] != beginPatch {
		return nil, invalidPatch("The first line of the patch must be '*** Begin Patch'")
	}
	if lines[len(lines)-1] != endPatch {
		return nil, invalidPatch("The last line of the patch must be '*** End Patch'")
	}

	var hunks []patchHunk
	for lineIndex := 1; lineIndex < len(lines)-1; {
		hunk, next, err := parseHunk(lines, lineIndex, len(hunks))
		if err != nil {
			return nil, err
		}
		hunks = append(hunks, hunk)
		lineIndex = next
	}
	if len(hunks) == 0 {
		return nil, invalidPatch("At least one file operation is required")
	}
	return hunks, nil
}

func parseHunk(lines []string, lineIndex, hunkIndex int) (patchHunk, int, error) {
	line := lines[lineIndex]
	switch {
	case strings.HasPrefix(line, addFile):
		path, err := parseHunkPath(line[len(addFile):])
		if err != nil {
			return patchHunk{}, 0, invalidHunk(hunkIndex, operationAdd, "", lineIndex, err.Error())
		}
		return parseAddHunk(lines, lineIndex, hunkIndex, path)
	case strings.HasPrefix(line, deleteFile):
		path, err := parseHunkPath(line[len(deleteFile):])
		if err != nil {
			return patchHunk{}, 0, invalidHunk(hunkIndex, operationDelete, "", lineIndex, err.Error())
		}
		return patchHunk{index: hunkIndex, operation: operationDelete, path: path}, lineIndex + 1, nil
	case strings.HasPrefix(line, updateFile):
		path, err := parseHunkPath(line[len(updateFile):])
		if err != nil {
			return patchHunk{}, 0, invalidHunk(hunkIndex, operationUpdate, "", lineIndex, err.Error())
		}
		return parseUpdateHunk(lines, lineIndex, hunkIndex, path)
	default:
		message := fmt.Sprintf("%q is not a valid file operation", line)
		return patchHunk{}, 0, &parseFailure{message: message, hunk: &hunkReference{Index: hunkIndex}}
	}
}

func parseHunkPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("file path must not be empty")
	}
	if path != strings.TrimSpace(path) {
		return "", fmt.Errorf("file path must not have leading or trailing whitespace")
	}
	return path, nil
}

func parseAddHunk(lines []string, lineIndex, hunkIndex int, path string) (patchHunk, int, error) {
	index := lineIndex + 1
	content := make([]byte, 0)
	for index < len(lines)-1 && !isOperationHeader(lines[index]) {
		line := lines[index]
		if line == "" || line[0] != '+' {
			return patchHunk{}, 0, invalidHunk(hunkIndex, operationAdd, path, index, "Add File lines must start with '+'")
		}
		content = append(content, line[1:]...)
		content = append(content, '\n')
		index++
	}
	if len(content) == 0 {
		return patchHunk{}, 0, invalidHunk(hunkIndex, operationAdd, path, lineIndex, "Add File hunk must contain at least one line")
	}
	return patchHunk{index: hunkIndex, operation: operationAdd, path: path, content: content}, index, nil
}

func parseUpdateHunk(lines []string, lineIndex, hunkIndex int, path string) (patchHunk, int, error) {
	hunk := patchHunk{index: hunkIndex, operation: operationUpdate, path: path}
	index := lineIndex + 1
	if index < len(lines)-1 && strings.HasPrefix(lines[index], moveTo) {
		movePath, err := parseHunkPath(lines[index][len(moveTo):])
		if err != nil {
			return patchHunk{}, 0, invalidHunk(hunkIndex, operationUpdate, path, index, err.Error())
		}
		hunk.movePath = movePath
		index++
	}

	for index < len(lines)-1 && !isOperationHeader(lines[index]) {
		chunk, next, err := parseUpdateChunk(lines, index, len(hunk.chunks), hunk)
		if err != nil {
			return patchHunk{}, 0, err
		}
		hunk.chunks = append(hunk.chunks, chunk)
		index = next
		if chunk.isEndOfFile && index < len(lines)-1 && !isOperationHeader(lines[index]) {
			return patchHunk{}, 0, invalidChunk(hunk, chunk.index, index, "End of File must be the final item in an update operation")
		}
	}
	if len(hunk.chunks) == 0 && hunk.movePath == "" {
		message := fmt.Sprintf("Update file hunk for path %q is empty", path)
		return patchHunk{}, 0, invalidHunk(hunkIndex, operationUpdate, path, lineIndex, message)
	}
	return hunk, index, nil
}

func parseUpdateChunk(lines []string, lineIndex, chunkIndex int, hunk patchHunk) (updateChunk, int, error) {
	chunk := updateChunk{index: chunkIndex}
	index := lineIndex
	if lines[index] == section {
		index++
	} else if strings.HasPrefix(lines[index], sectionWith) {
		chunk.context = lines[index][len(sectionWith):]
		if chunk.context == "" {
			return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, index, "Section header context must not be empty")
		}
		chunk.hasContext = true
		index++
	} else if chunkIndex > 0 {
		return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, index, "Expected update hunk to start with a @@ context marker")
	}

	hasChange := false
	for index < len(lines)-1 {
		line := lines[index]
		if line == endOfFile {
			if len(chunk.lines) == 0 {
				return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, index, "Update hunk does not contain any lines")
			}
			chunk.isEndOfFile = true
			index++
			break
		}
		if strings.HasPrefix(line, section) || isOperationHeader(line) {
			break
		}
		if line == "" || (line[0] != ' ' && line[0] != '-' && line[0] != '+') {
			return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, index, "Every update line must start with ' ', '+', or '-'")
		}
		chunk.lines = append(chunk.lines, updateLine{prefix: line[0], text: line[1:]})
		hasChange = hasChange || line[0] != ' '
		index++
	}
	if len(chunk.lines) == 0 {
		return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, lineIndex, "Update hunk does not contain any lines")
	}
	if !hasChange {
		return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, lineIndex, "Update hunk must contain an insertion or deletion")
	}
	return chunk, index, nil
}

func isOperationHeader(line string) bool {
	return strings.HasPrefix(line, addFile) || strings.HasPrefix(line, deleteFile) || strings.HasPrefix(line, updateFile)
}

func invalidPatch(message string) error {
	return &parseFailure{message: message}
}

func invalidHunk(index int, operation operationKind, path string, lineIndex int, message string) error {
	return &parseFailure{
		message: fmt.Sprintf("Invalid patch hunk on line %d: %s", lineIndex+1, message),
		hunk:    &hunkReference{Index: index, Operation: string(operation), Path: path},
	}
}

func invalidChunk(hunk patchHunk, chunkIndex, lineIndex int, message string) error {
	reference := hunk.reference()
	reference.ChunkIndex = new(chunkIndex)
	return &parseFailure{message: fmt.Sprintf("Invalid patch hunk on line %d: %s", lineIndex+1, message), hunk: &reference}
}
