//! C FFI bindings for the diff engine (fff-style: JSON string round-trip).
//!
//! Conventions:
//! - `diff_generate_json` always returns a non-null JSON string; on failure the
//!   JSON carries an `error` field. The caller must free it with
//!   `diff_free_string`.
//! - `diff_engine_api_version` returns the protocol version; bindings must
//!   reject mismatches.

use std::cell::RefCell;
use std::ffi::{c_char, c_uint, CStr, CString};

use crate::engine::{generate_final_diff, Row, Side, DEFAULT_TIMEOUT_MS};

/// Current protocol version. Bump on any change to the JSON contract.
pub const API_VERSION: u32 = 1;

// Ring pool of returned JSON strings. Ownership stays in Rust so bindings
// never need to free (ffi-rs freeResultMemory mismatches every allocator).
// The returned pointer stays valid until the pool wraps; bindings must
// consume the string synchronously before the next call.
thread_local! {
    static RESULT_POOL: RefCell<Vec<CString>> = const { RefCell::new(Vec::new()) };
}
const POOL_CAPACITY: usize = 8;

/// Generate a final diff as JSON. Always returns a non-null string
/// (errors are encoded as `{"error": "..."}`). Caller frees with
/// `diff_free_string`.
///
/// Text is passed as NUL-terminated UTF-8 C strings (ffi-rs `DataType.String`).
///
/// JSON shape:
/// ```json
/// {
///   "v": 1,
///   "rows": [
///     {"k":"c","o":1,"n":1,"c":"alpha"},
///     {"k":"r","o":3,"c":"...","h":[[14,22]]},
///     {"k":"a","n":5,"c":"...","h":[[28,42]]},
///     {"k":"u","op":"add","c":"...","h":[]},
///     {"k":"f","n":2},
///     {"k":"x","s":"old","c":"\\ No newline at end of file"}
///   ],
///   "stats": {"a":3,"d":1,"cl":4},
///   "first": 1,
///   "degraded": false
/// }
/// ```
///
/// ## Safety
/// `old_text`/`new_text` must be valid NUL-terminated UTF-8 C strings (or null,
/// treated as empty).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diff_generate_json(
    old_text: *const c_char,
    new_text: *const c_char,
    context: c_uint,
    timeout_ms: c_uint,
) -> *mut c_char {
    let old = cstr_to_str(old_text);
    let new = cstr_to_str(new_text);
    // context is passed through verbatim: 0 is a valid explicit value in the
    // JS contract (no context lines). timeout_ms uses 0 = default.
    let context = context as usize;
    let timeout_ms = if timeout_ms == 0 { DEFAULT_TIMEOUT_MS } else { timeout_ms as u64 };

    let diff = generate_final_diff(&old, &new, context, timeout_ms);
    let json = rows_to_json(&diff);
    match CString::new(json) {
        Ok(c) => {
            let ptr = c.as_ptr() as *mut c_char;
            RESULT_POOL.with(|pool| {
                let mut pool = pool.borrow_mut();
                if pool.len() >= POOL_CAPACITY {
                    pool.remove(0);
                }
                pool.push(c);
            });
            ptr
        }
        Err(_) => std::ptr::null_mut(),
    }
}

/// No-op: returned strings are owned by the engine's ring pool and recycled
/// automatically. Kept for ABI compatibility with the documented contract.
///
/// ## Safety
/// Accepts any pointer; does nothing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn diff_free_string(_ptr: *mut c_char) {}

/// Current JSON protocol version (1).
#[unsafe(no_mangle)]
pub extern "C" fn diff_engine_api_version() -> u32 {
    API_VERSION
}

/// Read a NUL-terminated C string as UTF-8; null or invalid input becomes "".
fn cstr_to_str(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    match unsafe { CStr::from_ptr(ptr) }.to_str() {
        Ok(s) => s.to_string(),
        Err(_) => String::new(),
    }
}

fn rows_to_json(diff: &crate::engine::FinalDiff) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("{\"v\":1,\"rows\":[");
    for (i, row) in diff.rows.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        row_to_json(row, &mut out);
    }
    out.push_str("],\"stats\":{");
    out.push_str(&format!("\"a\":{},\"d\":{},\"cl\":{}", diff.stats.additions, diff.stats.deletions, diff.stats.additions + diff.stats.deletions));
    out.push('}');
    if let Some(first) = diff.first_changed_line {
        out.push_str(&format!(",\"first\":{first}"));
    }
    out.push_str(&format!(",\"degraded\":{}}}", diff.degraded));
    out
}

fn row_to_json(row: &Row, out: &mut String) {
    match row {
        Row::Context { old, new, content } => {
            out.push_str(&format!("{{\"k\":\"c\",\"o\":{old},\"n\":{new},\"c\":"));
            push_escaped(content, out);
            out.push('}');
        }
        Row::Remove { old, content, highlights } => {
            out.push_str(&format!("{{\"k\":\"r\",\"o\":{old},\"c\":"));
            push_escaped(content, out);
            push_highlights(highlights, out);
            out.push('}');
        }
        Row::Add { new, content, highlights } => {
            out.push_str(&format!("{{\"k\":\"a\",\"n\":{new},\"c\":"));
            push_escaped(content, out);
            push_highlights(highlights, out);
            out.push('}');
        }
        Row::Unlocated { op, content, highlights } => {
            let op = match op {
                1 => "remove",
                2 => "add",
                _ => "context",
            };
            out.push_str(&format!("{{\"k\":\"u\",\"op\":\"{op}\",\"c\":"));
            push_escaped(content, out);
            push_highlights(highlights, out);
            out.push('}');
        }
        Row::Fold { omitted } => {
            out.push_str(&format!("{{\"k\":\"f\",\"n\":{omitted}}}"));
        }
        Row::Annotation { side, content } => {
            let side = match side {
                Side::Old => "old",
                Side::New => "new",
            };
            out.push_str(&format!("{{\"k\":\"x\",\"s\":\"{side}\",\"c\":"));
            push_escaped(content, out);
            out.push('}');
        }
    }
}

fn push_highlights(highlights: &[(usize, usize)], out: &mut String) {
    if highlights.is_empty() {
        out.push_str(",\"h\":[]");
        return;
    }
    out.push_str(",\"h\":[");
    for (i, (s, e)) in highlights.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("[{s},{e}]"));
    }
    out.push(']');
}

fn push_escaped(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
