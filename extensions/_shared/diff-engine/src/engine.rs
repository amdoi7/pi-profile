//! Diff engine core: line diff (jsdiff-compatible Myers), line pairing
//! (inverted index + weighted monotone chain), word highlights, reorder.
//! Ported from extensions/_shared/final-diff.ts to keep behavior identical.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const DEFAULT_CONTEXT_LINES: usize = 4;
pub const DEFAULT_TIMEOUT_MS: u64 = 250;
pub const MAX_LINES: usize = 2000;
pub const MAX_BYTES: usize = 51200;
pub const PAIR_SIMILARITY_THRESHOLD: f64 = 0.5;
pub const SPARSE_MAX_COMPARISONS: usize = 1_000_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Old,
    New,
}

#[derive(Clone, Debug)]
pub enum Row {
    Context { old: usize, new: usize, content: String },
    Remove { old: usize, content: String, highlights: Vec<(usize, usize)> },
    Add { new: usize, content: String, highlights: Vec<(usize, usize)> },
    /// op: 0 = context, 1 = remove, 2 = add
    Unlocated { op: u8, content: String, highlights: Vec<(usize, usize)> },
    Fold { omitted: usize },
    Annotation { side: Side, content: String },
}

impl Row {
    fn changed_side(&self) -> Option<Side> {
        match self {
            Row::Remove { .. } => Some(Side::Old),
            Row::Add { .. } => Some(Side::New),
            Row::Unlocated { op, .. } if *op == 1 => Some(Side::Old),
            Row::Unlocated { op, .. } if *op == 2 => Some(Side::New),
            _ => None,
        }
    }
    fn changed_content(&self) -> Option<&str> {
        match self {
            Row::Remove { content, .. }
            | Row::Add { content, .. }
            | Row::Unlocated { content, .. } => Some(content),
            _ => None,
        }
    }
}

pub struct DiffStats {
    pub additions: usize,
    pub deletions: usize,
}

pub struct FinalDiff {
    pub rows: Vec<Row>,
    pub stats: DiffStats,
    pub first_changed_line: Option<usize>,
    pub degraded: bool,
}

// ---------------------------------------------------------------------------
// Myers diff (jsdiff-compatible: O(ND), timeout, component-link backtrack)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CmpKind {
    Equal,
    Add,
    Remove,
}

struct Cmp {
    kind: CmpKind,
    count: usize,
    prev: Option<usize>,
}

#[derive(Clone, Copy)]
struct Path {
    old_pos: i64,
    last: Option<usize>,
}

/// Myers over interned tokens. Returns component runs or None on timeout.
fn myers_diff(old: &[u32], new: &[u32], timeout_ms: u64) -> Option<Vec<(CmpKind, usize)>> {
    let old_len = old.len() as i64;
    let new_len = new.len() as i64;
    let max_edit = old.len() + new.len();
    if max_edit == 0 {
        return Some(vec![]);
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    let mut best_path: Vec<Option<Path>> = vec![None; 2 * max_edit + 1];
    let mut cmps: Vec<Cmp> = Vec::new();

    best_path[max_edit] = Some(Path { old_pos: -1, last: None });
    let mut new_pos = {
        let path = best_path[max_edit].as_mut().unwrap();
        extract_common(path, old, new, 0, &mut cmps)
    };
    if best_path[max_edit].as_ref().unwrap().old_pos + 1 >= old_len && new_pos + 1 >= new_len {
        return Some(build_values(best_path[max_edit].as_ref().unwrap().last, &cmps));
    }

    let mut edit_length = 1usize;
    let mut min_diag = i64::MIN;
    let mut max_diag = i64::MAX;

    while edit_length <= max_edit && Instant::now() <= deadline {
        let mut found: Option<Vec<(CmpKind, usize)>> = None;
        let lo = min_diag.max(-(edit_length as i64));
        let hi = max_diag.min(edit_length as i64);
        #[cfg(test)]
        eprintln!("--- edit_length={edit_length} d-range [{lo},{hi}] old_len={old_len} new_len={new_len}");
        let mut d = lo;
        while d <= hi {
            let idx = (d + max_edit as i64) as usize;
            let remove_path = if idx >= 1 { best_path[idx - 1].take() } else { None };
            let add_path = best_path.get(idx + 1).copied().flatten();
            let can_add = add_path.is_some_and(|p| {
                let np = p.old_pos - d;
                np >= 0 && np < new_len
            });
            let can_remove = remove_path.is_some_and(|p| p.old_pos + 1 < old_len);
            if can_add || can_remove {
                let base: Option<Path> = if !can_remove
                    || (can_add && remove_path.as_ref().unwrap().old_pos < add_path.unwrap().old_pos)
                {
                    add_to_path(add_path.unwrap(), true, false, 0, &mut cmps)
                } else {
                    add_to_path(remove_path.unwrap(), false, true, 1, &mut cmps)
                };
                let mut base = base.unwrap();
                new_pos = extract_common(&mut base, old, new, d, &mut cmps);
                #[cfg(test)]
                eprintln!("  d={d} choose={} -> old_pos={} new_pos={}", if can_add && (can_remove && remove_path.as_ref().unwrap().old_pos < add_path.as_ref().unwrap().old_pos || !can_remove) { "ADD" } else { "REMOVE" }, base.old_pos, new_pos);
                if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                    found = Some(build_values(base.last, &cmps));
                    break;
                }
                best_path[idx] = Some(base);
                if best_path[idx].as_ref().unwrap().old_pos + 1 >= old_len {
                    max_diag = max_diag.min(d - 1);
                }
                if new_pos + 1 >= new_len {
                    min_diag = min_diag.max(d + 1);
                }
            } else {
                best_path[idx] = None;
            }
            d += 2;
        }
        if let Some(v) = found {
            return Some(v);
        }
        edit_length += 1;
    }
    None
}

fn extract_common(
    path: &mut Path,
    old: &[u32],
    new: &[u32],
    diagonal: i64,
    cmps: &mut Vec<Cmp>,
) -> i64 {
    let old_len = old.len() as i64;
    let new_len = new.len() as i64;
    let mut old_pos = path.old_pos;
    let mut new_pos = old_pos - diagonal;
    let mut common = 0usize;
    while new_pos + 1 < new_len && old_pos + 1 < old_len && old[(old_pos + 1) as usize] == new[(new_pos + 1) as usize] {
        new_pos += 1;
        old_pos += 1;
        common += 1;
    }
    if common > 0 {
        cmps.push(Cmp { kind: CmpKind::Equal, count: common, prev: path.last });
        path.last = Some(cmps.len() - 1);
    }
    path.old_pos = old_pos;
    new_pos
}

fn add_to_path(
    path: Path,
    added: bool,
    removed: bool,
    old_pos_inc: i64,
    cmps: &mut Vec<Cmp>,
) -> Option<Path> {
    let kind = if added {
        CmpKind::Add
    } else if removed {
        CmpKind::Remove
    } else {
        CmpKind::Equal
    };
    let last = path.last.and_then(|i| {
        let c = &cmps[i];
        (c.kind == kind).then_some(i)
    });
    // Immutable: each path gets its own component chain (jsdiff semantics).
    // Mutating a shared component would corrupt other paths' backtracks.
    match last {
        Some(i) => {
            let count = cmps[i].count + 1;
            let prev = cmps[i].prev;
            cmps.push(Cmp { kind, count, prev });
            Some(Path { old_pos: path.old_pos + old_pos_inc, last: Some(cmps.len() - 1) })
        }
        None => {
            cmps.push(Cmp { kind, count: 1, prev: path.last });
            Some(Path { old_pos: path.old_pos + old_pos_inc, last: Some(cmps.len() - 1) })
        }
    }
}

fn build_values(last: Option<usize>, cmps: &[Cmp]) -> Vec<(CmpKind, usize)> {
    let mut order: Vec<usize> = Vec::new();
    let mut cur = last;
    while let Some(i) = cur {
        order.push(i);
        cur = cmps[i].prev;
    }
    order.reverse();
    order.iter().map(|&i| (cmps[i].kind, cmps[i].count)).collect()
}

// ---------------------------------------------------------------------------
// Line diff: tokenize + intern + myers + hunk construction (jsdiff semantics)
// ---------------------------------------------------------------------------

/// Lines with trailing newline flags. Content excludes the newline.
struct Line {
    content: String,
    has_nl: bool,
}

fn split_lines(content: &str) -> (Vec<Line>, bool) {
    if content.is_empty() {
        return (vec![], false);
    }
    let ends_nl = content.ends_with('\n');
    let mut out: Vec<Line> = Vec::new();
    for part in content.split('\n') {
        out.push(Line { content: part.to_string(), has_nl: true });
    }
    if ends_nl {
        out.pop();
    } else if let Some(last) = out.last_mut() {
        last.has_nl = false;
    }
    (out, ends_nl)
}

fn source_line_count(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    if content.ends_with('\n') {
        content.split('\n').count() - 1
    } else {
        content.split('\n').count()
    }
}

struct RawHunk {
    old_start: usize,
    new_start: usize,
    /// Lines with +/-/space prefix, trailing newline stripped; may include "\ ..." annotations.
    lines: Vec<String>,
}

#[derive(Clone)]
struct Change {
    kind: CmpKind,
    lines: Vec<String>,
}

/// Intern lines (content + newline flag) shared across both sides.
fn intern_lines(old: &[Line], new: &[Line]) -> (Vec<u32>, Vec<u32>) {
    let mut intern: HashMap<String, u32> = HashMap::new();
    let mut intern_one = |lines: &[Line]| -> Vec<u32> {
        lines
            .iter()
            .map(|l| {
                let key = if l.has_nl {
                    format!("{}\n", l.content)
                } else {
                    l.content.clone()
                };
                match intern.get(&key) {
                    Some(&id) => id,
                    None => {
                        let id = intern.len() as u32;
                        intern.insert(key, id);
                        id
                    }
                }
            })
            .collect()
    };
    (intern_one(old), intern_one(new))
}

/// jsdiff diffLinesResultToPatch port: edit script -> hunks with context + EOF annotations.
fn hunks_from_changes(changes: &[Change], context: usize) -> Vec<RawHunk> {
    // Sentinel at the end (jsdiff pushes {value:"",lines:[]}).
    let mut changes = changes.to_vec();
    changes.push(Change { kind: CmpKind::Equal, lines: vec![] });

    let mut hunks: Vec<RawHunk> = Vec::new();
    let mut old_line = 1usize;
    let mut new_line = 1usize;
    let mut old_range_start = 0usize;
    let mut new_range_start = 0usize;
    let mut cur_range: Vec<String> = Vec::new();

    for i in 0..changes.len() {
        let (kind, lines) = {
            let c = &changes[i];
            (c.kind, c.lines.clone())
        };
        if kind == CmpKind::Add || kind == CmpKind::Remove {
            if old_range_start == 0 {
                old_range_start = old_line;
                new_range_start = new_line;
                if i > 0 && !changes[i - 1].lines.is_empty() {
                    let prev_lines = &changes[i - 1].lines;
                    let take = context.min(prev_lines.len());
                    cur_range.extend(prev_lines[prev_lines.len() - take..].iter().map(|l| format!(" {l}")));
                    old_range_start -= take;
                    new_range_start -= take;
                }
            }
            let prefix = if kind == CmpKind::Add { "+" } else { "-" };
            for l in &lines {
                cur_range.push(format!("{prefix}{l}"));
            }
            if kind == CmpKind::Add {
                new_line += lines.len();
            } else {
                old_line += lines.len();
            }
        } else {
            if old_range_start != 0 {
                if lines.len() <= 2 * context && i < changes.len() - 2 {
                    cur_range.extend(lines.iter().map(|l| format!(" {l}")));
                } else {
                    let take = context.min(lines.len());
                    cur_range.extend(lines[..take].iter().map(|l| format!(" {l}")));
                    hunks.push(RawHunk {
                        old_start: old_range_start,
                        new_start: new_range_start,
                        lines: std::mem::take(&mut cur_range),
                    });
                    old_range_start = 0;
                    new_range_start = 0;
                }
            }
            old_line += lines.len();
            new_line += lines.len();
        }
    }

    // EOF annotations: strip trailing newline; insert "\ No newline at end of file".
    for hunk in &mut hunks {
        let mut i = 0usize;
        while i < hunk.lines.len() {
            if hunk.lines[i].ends_with('\n') {
                hunk.lines[i].pop();
                i += 1;
            } else {
                hunk.lines.insert(i + 1, "\\ No newline at end of file".to_string());
                i += 2;
            }
        }
    }
    hunks
}

/// Build display rows from hunks (jsdiff buildDisplayDiff port).
fn rows_from_hunks(
    hunks: &[RawHunk],
    old_line_count: usize,
    new_line_count: usize,
) -> Result<(Vec<Row>, DiffStats, Option<usize>), String> {
    let mut rows: Vec<Row> = Vec::new();
    let mut next_old_line = 1usize;
    let mut next_new_line = 1usize;
    let mut first_changed_line: Option<usize> = None;
    let mut additions = 0usize;
    let mut deletions = 0usize;

    let append_fold = |rows: &mut Vec<Row>, old_gap: usize, new_gap: usize| -> Result<(), String> {
        if old_gap != new_gap {
            return Err(format!(
                "diff_hunk_gap_mismatch oldGap={old_gap} newGap={new_gap} action=\"report the jsdiff hunk coordinates and input line counts\""
            ));
        }
        if old_gap > 0 {
            rows.push(Row::Fold { omitted: old_gap });
        }
        Ok(())
    };

    for hunk in hunks {
        let hunk_old_start = hunk.old_start.max(1);
        let hunk_new_start = hunk.new_start.max(1);
        append_fold(&mut rows, hunk_old_start - next_old_line, hunk_new_start - next_new_line)?;
        let mut old_line = hunk_old_start;
        let mut new_line = hunk_new_start;
        let mut previous_change: Option<Side> = None;
        for patch_line in &hunk.lines {
            let prefix = patch_line.chars().next().unwrap_or(' ');
            let content = &patch_line[1..];
            match prefix {
                ' ' => {
                    rows.push(Row::Context { old: old_line, new: new_line, content: content.to_string() });
                    old_line += 1;
                    new_line += 1;
                    previous_change = None;
                }
                '-' => {
                    if first_changed_line.is_none() {
                        first_changed_line = Some(new_line);
                    }
                    rows.push(Row::Remove { old: old_line, content: content.to_string(), highlights: vec![] });
                    old_line += 1;
                    deletions += 1;
                    previous_change = Some(Side::Old);
                }
                '+' => {
                    if first_changed_line.is_none() {
                        first_changed_line = Some(new_line);
                    }
                    rows.push(Row::Add { new: new_line, content: content.to_string(), highlights: vec![] });
                    new_line += 1;
                    additions += 1;
                    previous_change = Some(Side::New);
                }
                '\\' => {
                    if let Some(side) = previous_change {
                        rows.push(Row::Annotation {
                            side,
                            content: content.trim_start().to_string(),
                        });
                        continue;
                    }
                    return Err(format!(
                        "diff_hunk_line_invalid prefix=\"\\\\\" line={patch_line:?} action=\"report the jsdiff structuredPatch output\""
                    ));
                }
                other => {
                    return Err(format!(
                        "diff_hunk_line_invalid prefix={other:?} line={patch_line:?} action=\"report the jsdiff structuredPatch output\""
                    ));
                }
            }
        }
        next_old_line = old_line;
        next_new_line = new_line;
    }

    if !hunks.is_empty() {
        append_fold(&mut rows, old_line_count + 1 - next_old_line, new_line_count + 1 - next_new_line)?;
    }
    Ok((rows, DiffStats { additions, deletions }, first_changed_line))
}

/// Degraded path: strip common prefix/suffix, mark the rest as unlocated rows.
fn degrade_to_unlocated(old_content: &str, new_content: &str) -> (Vec<Row>, DiffStats) {
    let old_lines: Vec<&str> = if old_content.is_empty() {
        vec![]
    } else {
        let mut v: Vec<&str> = old_content.split('\n').collect();
        if old_content.ends_with('\n') {
            v.pop();
        }
        v
    };
    let new_lines: Vec<&str> = if new_content.is_empty() {
        vec![]
    } else {
        let mut v: Vec<&str> = new_content.split('\n').collect();
        if new_content.ends_with('\n') {
            v.pop();
        }
        v
    };
    let mut prefix = 0usize;
    let common_limit = old_lines.len().min(new_lines.len());
    while prefix < common_limit && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < common_limit - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let old_end = old_lines.len() - suffix;
    let new_end = new_lines.len() - suffix;
    let mut rows: Vec<Row> = Vec::new();
    for line in &old_lines[prefix..old_end] {
        rows.push(Row::Unlocated { op: 1, content: (*line).to_string(), highlights: vec![] });
    }
    for line in &new_lines[prefix..new_end] {
        rows.push(Row::Unlocated { op: 2, content: (*line).to_string(), highlights: vec![] });
    }
    let stats = DiffStats {
        additions: new_end - prefix,
        deletions: old_end - prefix,
    };
    (rows, stats)
}

// ---------------------------------------------------------------------------
// Line pairing: interned tokens + inverted index + weighted monotone chain
// ---------------------------------------------------------------------------

struct PairCandidate {
    i: usize,
    j: usize,
    w: f64,
}

/// Tokenize a line into sorted unique interned token IDs.
fn intern_line_tokens(content: &str, intern: &mut HashMap<String, u32>) -> Vec<u32> {
    let mut ids: Vec<u32> = Vec::new();
    for token in tokenize_words(content) {
        match intern.get(token) {
            Some(&id) => ids.push(id),
            None => {
                let id = intern.len() as u32;
                intern.insert(token.to_string(), id);
                ids.push(id);
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Word tokenization matching jsdiff's diffWordsWithSpace extended word chars.
fn tokenize_words(s: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = s[i..].chars().next().unwrap();
        let ch_len = ch.len_utf8();
        let class = word_char_class(ch);
        i += ch_len;
        if i < bytes.len() {
            let next = s[i..].chars().next().unwrap();
            if word_char_class(next) != class {
                out.push(&s[start..i]);
                start = i;
            }
        } else {
            out.push(&s[start..i]);
        }
    }
    out
}

#[inline]
fn word_char_class(c: char) -> u8 {
    if c == '\n' || c == '\r' {
        return 1;
    }
    if is_extended_word_char(c) {
        return 2;
    }
    if c.is_whitespace() {
        return 3;
    }
    4
}

/// jsdiff extendedWordChars: a-zA-Z0-9_ plus unicode ranges.
fn is_extended_word_char(c: char) -> bool {
    if c.is_ascii_alphanumeric() || c == '_' {
        return true;
    }
    let cp = c as u32;
    cp == 0xAD
        || (0xC0..=0xD6).contains(&cp)
        || (0xD8..=0xF6).contains(&cp)
        || (0xF8..=0x2C6).contains(&cp)
        || (0x2C8..=0x2D7).contains(&cp)
        || (0x2DE..=0x2FF).contains(&cp)
        || (0x1E00..=0x1EFF).contains(&cp)
}

fn dice_similarity(a: &[u32], b: &[u32]) -> f64 {
    let total = a.len() + b.len();
    if total == 0 {
        return 0.0;
    }
    let required = (total + 3) / 4;
    if required > a.len().min(b.len()) {
        return 0.0;
    }
    let mut common = 0usize;
    let mut i = 0usize;
    let mut j = 0usize;
    while i < a.len() && j < b.len() {
        if common + (a.len() - i).min(b.len() - j) < required {
            return 0.0;
        }
        if a[i] == b[j] {
            common += 1;
            i += 1;
            j += 1;
        } else if a[i] < b[j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    if common >= required {
        2.0 * common as f64 / total as f64
    } else {
        0.0
    }
}

fn sparse_candidates(
    old_tokens: &[Vec<u32>],
    new_tokens: &[Vec<u32>],
    max_comparisons: usize,
) -> Option<Vec<PairCandidate>> {
    let mut inverted: HashMap<u32, Vec<usize>> = HashMap::new();
    for (j, tokens) in new_tokens.iter().enumerate() {
        for &token in tokens {
            inverted.entry(token).or_default().push(j);
        }
    }
    // popular pruning (difflib autoJunk / imara-diff histogram limit)
    if new_tokens.len() >= 200 {
        let popular_limit = new_tokens.len() / 100 + 1;
        inverted.retain(|_, list| list.len() <= popular_limit);
    }
    let mut candidates: Vec<PairCandidate> = Vec::new();
    let mut seen: Vec<bool> = vec![false; new_tokens.len()];
    let mut comparisons = 0usize;
    for i in 0..old_tokens.len() {
        seen.iter_mut().for_each(|s| *s = false);
        for &token in &old_tokens[i] {
            let Some(list) = inverted.get(&token) else { continue };
            for &j in list {
                if seen[j] {
                    continue;
                }
                seen[j] = true;
                comparisons += 1;
                if comparisons > max_comparisons {
                    return None;
                }
                let w = dice_similarity(&old_tokens[i], &new_tokens[j]);
                if w >= PAIR_SIMILARITY_THRESHOLD {
                    candidates.push(PairCandidate { i, j, w });
                }
            }
        }
    }
    Some(candidates)
}

/// Weighted monotone chain via Fenwick tree over the new-side column.
fn weighted_monotone_chain(candidates: &[PairCandidate], new_count: usize) -> Vec<(usize, usize)> {
    let mut bit_value: Vec<f64> = vec![0.0; new_count + 1];
    let mut bit_index: Vec<i64> = vec![-1; new_count + 1];
    let mut best: Vec<f64> = vec![0.0; new_count + 1];
    let mut prev: Vec<usize> = vec![0; new_count + 1];
    let mut updater: Vec<i64> = vec![-1; new_count + 1];

    let prefix_max = |j0: usize, bit_value: &Vec<f64>, bit_index: &Vec<i64>| -> (f64, i64) {
        let mut value = 0.0f64;
        let mut index = -1i64;
        let mut j = j0;
        while j > 0 {
            if bit_value[j] > value {
                value = bit_value[j];
                index = bit_index[j];
            }
            j -= j & j.wrapping_neg();
        }
        (value, index)
    };
    let update_bit = |j0: usize, value: f64, index0: i64, bit_value: &mut Vec<f64>, bit_index: &mut Vec<i64>| {
        let mut j = j0 + 1;
        while j <= new_count {
            if value > bit_value[j] {
                bit_value[j] = value;
                bit_index[j] = index0;
            }
            j += j & j.wrapping_neg();
        }
    };

    let mut pending: Vec<(usize, f64, usize, usize)> = Vec::new(); // (j, score, prev_pos, i)
    let mut current_i = usize::MAX;
    let flush = |pending: &mut Vec<(usize, f64, usize, usize)>,
                     best: &mut Vec<f64>,
                     prev: &mut Vec<usize>,
                     updater: &mut Vec<i64>,
                     bit_value: &mut Vec<f64>,
                     bit_index: &mut Vec<i64>| {
        for &(j, score, prev_pos, i) in pending.iter() {
            if score > best[j + 1] {
                best[j + 1] = score;
                prev[j + 1] = prev_pos;
                updater[j + 1] = i as i64;
                update_bit(j, score, j as i64, bit_value, bit_index);
            }
        }
        pending.clear();
    };
    for c in candidates {
        if c.i != current_i {
            flush(&mut pending, &mut best, &mut prev, &mut updater, &mut bit_value, &mut bit_index);
            current_i = c.i;
        }
        let (value, index) = prefix_max(c.j, &bit_value, &bit_index);
        let prev_pos = if index >= 0 { (index + 1) as usize } else { 0 };
        pending.push((c.j, value + c.w, prev_pos, c.i));
    }
    flush(&mut pending, &mut best, &mut prev, &mut updater, &mut bit_value, &mut bit_index);

    let mut best_j = 0usize;
    for j in 1..=new_count {
        if best[j] > best[best_j] {
            best_j = j;
        }
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    while best_j > 0 {
        pairs.push((updater[best_j] as usize, best_j - 1));
        best_j = prev[best_j];
    }
    pairs
}

/// Dense fallback: rolling-array weighted LCS, O(m*n).
fn dense_pair_changed_items(old_tokens: &[Vec<u32>], new_tokens: &[Vec<u32>]) -> Vec<(usize, usize)> {
    let old_count = old_tokens.len();
    let new_count = new_tokens.len();
    let mut best: Vec<f64> = vec![0.0; new_count + 1];
    let mut choice: Vec<u8> = vec![0; old_count * new_count];
    for i in 1..=old_count {
        let mut diagonal = best[0];
        for j in 1..=new_count {
            let skip_old = best[j];
            let skip_new = best[j - 1];
            let similarity = dice_similarity(&old_tokens[i - 1], &new_tokens[j - 1]);
            let pair_score = if similarity >= PAIR_SIMILARITY_THRESHOLD {
                diagonal + similarity
            } else {
                f64::NEG_INFINITY
            };
            let slot = (i - 1) * new_count + (j - 1);
            if pair_score >= skip_old && pair_score >= skip_new {
                best[j] = pair_score;
                choice[slot] = 2;
            } else if skip_old >= skip_new {
                best[j] = skip_old;
                choice[slot] = 0;
            } else {
                best[j] = skip_new;
                choice[slot] = 1;
            }
            diagonal = skip_old;
        }
    }
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut i = old_count;
    let mut j = new_count;
    while i > 0 && j > 0 {
        let slot = (i - 1) * new_count + (j - 1);
        if choice[slot] == 2 {
            pairs.push((i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if choice[slot] == 0 {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    pairs
}

// ---------------------------------------------------------------------------
// Block refinement: pair, reorder, highlight
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct BlockItem {
    row_index: usize,
    annotations: Vec<usize>,
}

/// Append a highlight range, trimming surrounding whitespace (jsdiff/TS port).
fn append_highlight(row: &mut Row, start: usize, end: usize) {
    let content = row.changed_content().unwrap_or_default();
    let value = &content[start..end];
    let trim_start = value.len() - value.trim_start().len();
    let trim_end = value.len() - value.trim_end().len();
    let start = start + trim_start;
    let end = end - trim_end;
    if start >= end {
        return;
    }
    let highlights = match row {
        Row::Remove { highlights, .. } | Row::Add { highlights, .. } | Row::Unlocated { highlights, .. } => {
            highlights
        }
        _ => return,
    };
    if let Some(prev) = highlights.last_mut() {
        if start <= prev.1 {
            prev.1 = prev.1.max(end);
            return;
        }
    }
    highlights.push((start, end));
}

fn highlight_whole_row(row: &mut Row) {
    let len = row.changed_content().unwrap_or_default().len();
    append_highlight(row, 0, len);
}

/// Word-level diff of a pair (jsdiff diffWordsWithSpace semantics).
fn diff_words_with_space(a: &str, b: &str) -> Vec<(u8, String)> {
    let at = tokenize_words(a);
    let bt = tokenize_words(b);
    let mut intern: HashMap<String, u32> = HashMap::new();
    let mut intern_one = |toks: &[&str]| -> Vec<u32> {
        toks.iter()
            .map(|t| match intern.get(*t) {
                Some(&id) => id,
                None => {
                    let id = intern.len() as u32;
                    intern.insert((*t).to_string(), id);
                    id
                }
            })
            .collect()
    };
    let ai = intern_one(&at);
    let bi = intern_one(&bt);
    // Small DP: token counts are tiny per line; produces a minimal edit script.
    // (jsdiff uses Myers; for typical short lines the optimal alignment agrees.)
    let n = ai.len();
    let m = bi.len();
    let mut dp: Vec<usize> = vec![0; (n + 1) * (m + 1)];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * (m + 1) + j] = if ai[i] == bi[j] {
                dp[(i + 1) * (m + 1) + j + 1] + 1
            } else {
                dp[(i + 1) * (m + 1) + j].max(dp[i * (m + 1) + j + 1])
            };
        }
    }
    // Reconstruct LCS alignment: 0 = equal, 1 = remove (from a), 2 = add (from b).
    let mut parts: Vec<(u8, &str)> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if ai[i] == bi[j] {
            parts.push((0, at[i]));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1] {
            parts.push((1, at[i]));
            i += 1;
        } else {
            parts.push((2, bt[j]));
            j += 1;
        }
    }
    while i < n {
        parts.push((1, at[i]));
        i += 1;
    }
    while j < m {
        parts.push((2, bt[j]));
        j += 1;
    }
    // Merge adjacent runs.
    let mut out: Vec<(u8, String)> = Vec::new();
    for (k, text) in parts {
        if let Some(last) = out.last_mut() {
            if last.0 == k {
                last.1.push_str(text);
                continue;
            }
        }
        out.push((k, text.to_string()));
    }
    out
}

fn refine_pair(old_row: &mut Row, new_row: &mut Row) {
    let old_content = old_row.changed_content().unwrap_or_default().to_string();
    let new_content = new_row.changed_content().unwrap_or_default().to_string();
    let mut old_offset = 0usize;
    let mut new_offset = 0usize;
    for (kind, value) in diff_words_with_space(&old_content, &new_content) {
        match kind {
            1 => {
                append_highlight(old_row, old_offset, old_offset + value.len());
                old_offset += value.len();
            }
            2 => {
                append_highlight(new_row, new_offset, new_offset + value.len());
                new_offset += value.len();
            }
            _ => {
                old_offset += value.len();
                new_offset += value.len();
            }
        }
    }
}

/// Reorder changed block: paired rows adjacent (- then +), inserts in new order,
/// deletes inserted before the first later paired row (monotone on both sides).
fn reorder_changed_items(
    rows: &mut Vec<Row>,
    block: &[BlockItem],
    old_items: &[BlockItem],
    new_items: &[BlockItem],
    pairs: &[(usize, usize)],
) -> Result<(), String> {
    let mut new_to_old: HashMap<usize, usize> = HashMap::new();
    for &(o, n) in pairs {
        new_to_old.insert(n, o);
    }
    let mut ordered: Vec<BlockItem> = Vec::new();
    let mut ordered_old_indexes: Vec<Option<usize>> = Vec::new();
    let mut pushed_old: Vec<bool> = vec![false; old_items.len()];
    for (new_index, new_item) in new_items.iter().enumerate() {
        if let Some(&old_index) = new_to_old.get(&new_index) {
            if !pushed_old[old_index] {
                ordered.push(old_items[old_index].clone());
                ordered_old_indexes.push(Some(old_index));
                pushed_old[old_index] = true;
            }
        }
        ordered.push(new_item.clone());
        ordered_old_indexes.push(None);
    }
    for (old_index, old_item) in old_items.iter().enumerate() {
        if pairs.iter().any(|&(o, _)| o == old_index) {
            continue;
        }
        let mut position = ordered.len();
        for (k, anchor) in ordered_old_indexes.iter().enumerate() {
            if let Some(a) = anchor {
                if *a > old_index {
                    position = k;
                    break;
                }
            }
        }
        ordered.insert(position, old_item.clone());
        ordered_old_indexes.insert(position, Some(old_index));
    }

    let first = &block[0];
    let last = block.last().unwrap();
    let start = first.row_index;
    let end = last.annotations.last().copied().unwrap_or(last.row_index) + 1;
    let mut rebuilt: Vec<Row> = Vec::new();
    for item in &ordered {
        rebuilt.push(rows[item.row_index].clone());
        for &a in &item.annotations {
            rebuilt.push(rows[a].clone());
        }
    }
    if rebuilt.len() != end - start {
        return Err(format!(
            "diff_block_reorder_mismatch expected={} actual={} action=\"report the changed block rows\"",
            end - start,
            rebuilt.len()
        ));
    }
    rows.splice(start..end, rebuilt);
    Ok(())
}

fn refine_changed_block(rows: &mut Vec<Row>, block: &[BlockItem]) -> Result<(), String> {
    if block.is_empty() || block.len() > MAX_LINES {
        return Ok(());
    }
    let old_items: Vec<BlockItem> = block
        .iter()
        .filter(|item| rows[item.row_index].changed_side() == Some(Side::Old))
        .cloned()
        .collect();
    let new_items: Vec<BlockItem> = block
        .iter()
        .filter(|item| rows[item.row_index].changed_side() == Some(Side::New))
        .cloned()
        .collect();
    let old_text: String = old_items
        .iter()
        .map(|item| rows[item.row_index].changed_content().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    let new_text: String = new_items
        .iter()
        .map(|item| rows[item.row_index].changed_content().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    if old_text.len() + new_text.len() > MAX_BYTES {
        return Ok(());
    }
    if old_items.is_empty() || new_items.is_empty() {
        for item in block {
            let row = &mut rows[item.row_index];
            highlight_whole_row(row);
        }
        return Ok(());
    }

    let pairs = pair_changed_items(rows, &old_items, &new_items);
    if pairs.is_empty() {
        for item in block {
            let row = &mut rows[item.row_index];
            highlight_whole_row(row);
        }
        return Ok(());
    }

    // Highlight before reorder: row_index still points at the original rows.
    for &(old_index, new_index) in &pairs {
        let oi = old_items[old_index].row_index;
        let ni = new_items[new_index].row_index;
        let (lo, hi) = (oi.min(ni), oi.max(ni));
        let (left, right) = rows.split_at_mut(hi);
        let old_row = &mut left[lo];
        let new_row = &mut right[0];
        refine_pair(old_row, new_row);
    }
    let paired_old: Vec<bool> = {
        let mut v = vec![false; old_items.len()];
        for &(o, _) in &pairs {
            v[o] = true;
        }
        v
    };
    for (index, item) in old_items.iter().enumerate() {
        if !paired_old[index] {
            highlight_whole_row(&mut rows[item.row_index]);
        }
    }
    let paired_new: Vec<bool> = {
        let mut v = vec![false; new_items.len()];
        for &(_, n) in &pairs {
            v[n] = true;
        }
        v
    };
    for (index, item) in new_items.iter().enumerate() {
        if !paired_new[index] {
            highlight_whole_row(&mut rows[item.row_index]);
        }
    }

    reorder_changed_items(rows, block, &old_items, &new_items, &pairs)
}

fn pair_changed_items(
    rows: &mut Vec<Row>,
    old_items: &[BlockItem],
    new_items: &[BlockItem],
) -> Vec<(usize, usize)> {
    let old_count = old_items.len();
    let new_count = new_items.len();
    if old_count == 0 || new_count == 0 {
        return vec![];
    }
    // Intern tokens with a shared table across both sides (imara-diff style).
    let mut intern: HashMap<String, u32> = HashMap::new();
    let mut cache: HashMap<String, Vec<u32>> = HashMap::new();
    let mut intern_one = |items: &[BlockItem]| -> Vec<Vec<u32>> {
        items
            .iter()
            .map(|item| {
                let content = rows[item.row_index].changed_content().unwrap_or_default().to_string();
                if let Some(t) = cache.get(&content) {
                    return t.clone();
                }
                let tokens = intern_line_tokens(&content, &mut intern);
                cache.insert(content, tokens.clone());
                tokens
            })
            .collect()
    };
    let old_tokens = intern_one(old_items);
    let new_tokens = intern_one(new_items);
    match sparse_candidates(&old_tokens, &new_tokens, SPARSE_MAX_COMPARISONS) {
        Some(candidates) => weighted_monotone_chain(&candidates, new_count),
        None => dense_pair_changed_items(&old_tokens, &new_tokens),
    }
}

fn refine_changed_blocks(rows: &mut Vec<Row>) -> Result<(), String> {
    let mut block: Vec<BlockItem> = Vec::new();
    let mut index = 0usize;
    while index < rows.len() {
        let is_changed = rows[index].changed_side().is_some();
        let is_annotation = matches!(rows[index], Row::Annotation { .. });
        if is_changed {
            block.push(BlockItem { row_index: index, annotations: vec![] });
            index += 1;
            continue;
        }
        if is_annotation && !block.is_empty() {
            block.last_mut().unwrap().annotations.push(index);
            index += 1;
            continue;
        }
        refine_changed_block(rows, &block)?;
        block.clear();
        index += 1;
    }
    refine_changed_block(rows, &block)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Top-level pipeline
// ---------------------------------------------------------------------------

pub fn generate_final_diff(old_content: &str, new_content: &str, context: usize, timeout_ms: u64) -> FinalDiff {
    let (old_lines, _) = split_lines(old_content);
    let (new_lines, _) = split_lines(new_content);
    let (old_tokens, new_tokens) = intern_lines(&old_lines, &new_lines);
    let components = myers_diff(&old_tokens, &new_tokens, timeout_ms);

    let Some(components) = components else {
        let (rows, stats) = degrade_to_unlocated(old_content, new_content);
        return FinalDiff { rows, stats, first_changed_line: None, degraded: true };
    };

    // Build changes with line values.
    #[cfg(test)]
    {
        eprintln!("COMPONENTS: {:?}", components);
        eprintln!("old_lines: {}, new_lines: {}", old_lines.len(), new_lines.len());
    }
    let mut changes: Vec<Change> = Vec::new();
    let mut old_pos = 0usize;
    let mut new_pos = 0usize;
    for (kind, count) in components {
        let mut lines: Vec<String> = Vec::with_capacity(count);
        match kind {
            CmpKind::Equal => {
                for _ in 0..count {
                    let l = &old_lines[old_pos];
                    lines.push(format!("{}{}", l.content, if l.has_nl { "\n" } else { "" }));
                    old_pos += 1;
                    new_pos += 1;
                }
            }
            CmpKind::Remove => {
                for _ in 0..count {
                    let l = &old_lines[old_pos];
                    lines.push(format!("{}{}", l.content, if l.has_nl { "\n" } else { "" }));
                    old_pos += 1;
                }
            }
            CmpKind::Add => {
                for _ in 0..count {
                    let l = &new_lines[new_pos];
                    lines.push(format!("{}{}", l.content, if l.has_nl { "\n" } else { "" }));
                    new_pos += 1;
                }
            }
        }
        changes.push(Change { kind, lines });
    }

    let hunks = hunks_from_changes(&changes, context);
    let old_line_count = source_line_count(old_content);
    let new_line_count = source_line_count(new_content);
    match rows_from_hunks(&hunks, old_line_count, new_line_count) {
        Ok((mut rows, stats, first_changed_line)) => {
            if let Err(e) = refine_changed_blocks(&mut rows) {
                return FinalDiff {
                    rows: vec![Row::Annotation { side: Side::Old, content: e }],
                    stats: DiffStats { additions: 0, deletions: 0 },
                    first_changed_line: None,
                    degraded: true,
                };
            }
            FinalDiff { rows, stats, first_changed_line, degraded: false }
        }
        Err(e) => FinalDiff {
            rows: vec![Row::Annotation { side: Side::Old, content: e }],
            stats: DiffStats { additions: 0, deletions: 0 },
            first_changed_line: None,
            degraded: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_far_edits_do_not_overflow() {
        let lines: Vec<String> = (1..=200).map(|i| format!("line{i}")).collect();
        let old_content = lines.join("\n") + "\n";
        let mut new_lines = lines.clone();
        new_lines[9] = "EDIT_TOP".to_string();
        new_lines[189] = "EDIT_BOTTOM".to_string();
        let new_content = new_lines.join("\n") + "\n";
        let diff = generate_final_diff(&old_content, &new_content, 4, 250);
        assert!(!diff.degraded);
        assert_eq!(diff.stats.additions, 2);
        assert_eq!(diff.stats.deletions, 2);
    }

    #[test]
    fn single_middle_edit() {
        let lines: Vec<String> = (1..=100).map(|i| format!("line{i}")).collect();
        let old_content = lines.join("\n") + "\n";
        let mut new_lines = lines.clone();
        new_lines[49] = "CHANGED".to_string();
        let new_content = new_lines.join("\n") + "\n";
        let diff = generate_final_diff(&old_content, &new_content, 4, 250);
        assert!(!diff.degraded);
        assert_eq!(diff.stats.additions, 1);
        assert_eq!(diff.stats.deletions, 1);
    }
}
