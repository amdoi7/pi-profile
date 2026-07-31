package main

import (
	"bytes"
	"fmt"
)

type replacement struct {
	start    int
	oldCount int
	lines    []updateLine
}

type matchFailure struct {
	message    string
	chunkIndex int
}

func (failure *matchFailure) Error() string {
	return failure.message
}

func deriveUpdatedContent(content []byte, path string, chunks []updateChunk) ([]byte, error) {
	content = toLF(content)
	lines := bytes.Split(bytes.TrimSuffix(content, []byte{'\n'}), []byte{'\n'})
	replacements, err := computeReplacements(lines, path, chunks)
	if err != nil {
		return nil, err
	}

	result := make([]byte, 0, updatedSize(lines, replacements))
	lineIndex := 0
	for _, change := range replacements {
		result = appendFileLines(result, lines[lineIndex:change.start])
		result = appendUpdateLines(result, change.lines)
		lineIndex = change.start + change.oldCount
	}
	return appendFileLines(result, lines[lineIndex:]), nil
}

func updatedSize(lines [][]byte, replacements []replacement) int {
	size := 0
	lineIndex := 0
	for _, change := range replacements {
		size += linesSize(lines[lineIndex:change.start])
		size += updateLinesSize(change.lines)
		lineIndex = change.start + change.oldCount
	}
	return size + linesSize(lines[lineIndex:])
}

func linesSize(lines [][]byte) int {
	size := len(lines)
	for _, line := range lines {
		size += len(line)
	}
	return size
}

func updateLinesSize(lines []updateLine) int {
	size := 0
	for _, line := range lines {
		if line.prefix != '-' {
			size += len(line.text) + 1
		}
	}
	return size
}

func appendFileLines(dst []byte, lines [][]byte) []byte {
	for _, line := range lines {
		dst = append(dst, line...)
		dst = append(dst, '\n')
	}
	return dst
}

func appendUpdateLines(dst []byte, lines []updateLine) []byte {
	for _, line := range lines {
		if line.prefix != '-' {
			dst = append(dst, line.text...)
			dst = append(dst, '\n')
		}
	}
	return dst
}

func computeReplacements(lines [][]byte, path string, chunks []updateChunk) ([]replacement, error) {
	changes := make([]replacement, 0, len(chunks))
	lineIndex := 0
	for _, chunk := range chunks {
		if chunk.hasContext {
			contextIndex, found := seekLine(lines, chunk.context, lineIndex)
			if !found {
				message := fmt.Sprintf("Failed to find context %q in %s", chunk.context, path)
				return nil, &matchFailure{message: message, chunkIndex: chunk.index}
			}
			lineIndex = contextIndex + 1
		}

		oldCount := matchedLineCount(chunk.lines)
		start := len(lines)
		found := true
		if oldCount > 0 {
			start, found = seekUpdate(lines, chunk.lines, lineIndex, chunk.isEndOfFile)
		} else if chunk.hasContext {
			start = lineIndex
		}
		if !found {
			message := fmt.Sprintf("Failed to find expected lines in %s", path)
			return nil, &matchFailure{message: message, chunkIndex: chunk.index}
		}
		changes = append(changes, replacement{start: start, oldCount: oldCount, lines: chunk.lines})
		lineIndex = start + oldCount
	}
	return changes, nil
}

func matchedLineCount(lines []updateLine) int {
	count := 0
	for _, line := range lines {
		if line.prefix != '+' {
			count++
		}
	}
	return count
}

func seekLine(lines [][]byte, expected string, start int) (int, bool) {
	for index := start; index < len(lines); index++ {
		if bytes.Equal(lines[index], []byte(expected)) {
			return index, true
		}
	}
	return 0, false
}

func seekUpdate(lines [][]byte, update []updateLine, start int, eof bool) (int, bool) {
	oldCount := matchedLineCount(update)
	if oldCount > len(lines) {
		return 0, false
	}
	if eof {
		start = len(lines) - oldCount
	}
	for index := start; index <= len(lines)-oldCount; index++ {
		if updateMatches(lines, update, index) {
			return index, true
		}
	}
	return 0, false
}

func updateMatches(lines [][]byte, update []updateLine, index int) bool {
	for _, line := range update {
		if line.prefix == '+' {
			continue
		}
		if !bytes.Equal(lines[index], []byte(line.text)) {
			return false
		}
		index++
	}
	return true
}
