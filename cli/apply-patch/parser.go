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

func parsePatch(input string) ([]patchHunk, []skippedHunk, error) {
	lines := strings.Split(input, "\n")
	// 统一 heredoc 缩进剥除：所有指令行（trim 后以 ***/@@ 开头）前导空白的最小值 = N；
	// 每行剥去至多 N 个前导空白后按标准规则解析（内容行 line[0] 即标记，恢复严格匹配）。
	lines = stripIndent(lines, patchIndent(lines))
	if len(lines) == 0 || strings.TrimLeft(lines[0], " \t") != beginPatch {
		return nil, nil, invalidPatch("The first line of the patch must be '*** Begin Patch'")
	}
	if strings.TrimLeft(lines[len(lines)-1], " \t") != endPatch {
		return nil, nil, invalidPatch("The last line of the patch must be '*** End Patch'")
	}

	var hunks []patchHunk
	var skipped []skippedHunk
	operationIndex := 0
	for lineIndex := 1; lineIndex < len(lines)-1; {
		hunk, next, err := parseHunk(lines, lineIndex, operationIndex)
		operationIndex++
		if err != nil {
			reference := hunkReference{Index: operationIndex - 1}
			if failure, ok := err.(*parseFailure); ok && failure.hunk != nil {
				reference = *failure.hunk
			}
			skipped = append(skipped, skippedHunk{Hunk: reference, Message: err.Error()})
			lineIndex = nextOperationLine(lines, lineIndex)
			continue
		}
		hunks = append(hunks, hunk)
		lineIndex = next
	}
	if len(hunks) == 0 {
		if len(skipped) > 0 {
			return nil, skipped, invalidPatch("No valid file operations remain in the patch")
		}
		return nil, nil, invalidPatch("At least one file operation is required")
	}
	return hunks, skipped, nil
}

// patchIndent 计算统一 heredoc 缩进量：指令行（trim 后以 ***/@@ 开头）前导空白的最小值。
// 顶格 patch 为 0；无指令行（非 patch 内容）为 0（不剥除）。
func patchIndent(lines []string) int {
	n := -1
	for _, line := range lines {
		trimmed := strings.TrimLeft(line, " \t")
		if !strings.HasPrefix(trimmed, "***") && !strings.HasPrefix(trimmed, "@@") {
			continue
		}
		indent := len(line) - len(trimmed)
		if n == -1 || indent < n {
			n = indent
		}
	}
	if n < 0 {
		return 0
	}
	return n
}

// stripIndent 每行剥去至多 n 个前导空白字符（统一 heredoc 缩进；不足 n 的行剥到 0）。
func stripIndent(lines []string, n int) []string {
	if n <= 0 {
		return lines
	}
	out := make([]string, len(lines))
	for i, line := range lines {
		strip := 0
		for strip < n && strip < len(line) && (line[strip] == ' ' || line[strip] == '\t') {
			strip++
		}
		out[i] = line[strip:]
	}
	return out
}

func nextOperationLine(lines []string, lineIndex int) int {
	for i := lineIndex + 1; i < len(lines)-1; i++ {
		if isOperationHeader(lines[i]) {
			return i
		}
	}
	return len(lines) - 1
}

func parseHunk(lines []string, lineIndex, hunkIndex int) (patchHunk, int, error) {
	line := strings.TrimLeft(lines[lineIndex], " \t")
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
	if index < len(lines)-1 && strings.HasPrefix(strings.TrimLeft(lines[index], " \t"), moveTo) {
		movePath, err := parseHunkPath(strings.TrimLeft(lines[index], " \t")[len(moveTo):])
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
	if strings.TrimLeft(lines[index], " \t") == section {
		index++
	} else if strings.HasPrefix(strings.TrimLeft(lines[index], " \t"), sectionWith) {
		chunk.context = strings.TrimLeft(lines[index], " \t")[len(sectionWith):]
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
		if strings.TrimLeft(line, " \t") == endOfFile {
			if len(chunk.lines) == 0 {
				return updateChunk{}, 0, invalidChunk(hunk, chunkIndex, index, "Update hunk does not contain any lines")
			}
			chunk.isEndOfFile = true
			index++
			break
		}
		if strings.HasPrefix(strings.TrimLeft(line, " \t"), section) || isOperationHeader(line) {
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
	trimmed := strings.TrimLeft(line, " \t")
	return strings.HasPrefix(trimmed, addFile) || strings.HasPrefix(trimmed, deleteFile) || strings.HasPrefix(trimmed, updateFile)
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
