/**
 * Rust diff engine binding (fff pattern: Rust CDylib + ffi-rs + JSON round-trip).
 *
 * Loads `libdiff_engine.dylib` (built from `./diff-engine` with cargo) and
 * calls `diff_generate_json(old, new, context, timeoutMs) -> JSON`.
 *
 * Failure model: any load/version/parse failure marks the engine unavailable;
 * callers fall back to the pure-JS implementation. Never throws.
 */

import { open, define, DataType, close } from "ffi-rs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const API_VERSION = 1;
const LIBRARY_KEY = "diff-engine";

type EngineState = "unloaded" | "loaded" | "unavailable";

let state: EngineState = "unloaded";
let generate: ((params: unknown[]) => string) | undefined;

function libraryCandidates(): string[] {
	const candidates: string[] = [];
	const fromEnv = process.env.DIFF_ENGINE_LIB;
	if (fromEnv) candidates.push(fromEnv);
	const here = dirname(fileURLToPath(import.meta.url));
	const defaultLib = process.platform === "darwin"
		? "libdiff_engine.dylib"
		: process.platform === "win32"
			? "diff_engine.dll"
			: "libdiff_engine.so";
	candidates.push(join(here, "diff-engine", "target", "release", defaultLib));
	return candidates;
}

function loadEngine(): void {
	if (state !== "unloaded") return;
	const path = libraryCandidates().find((candidate) => existsSync(candidate));
	if (path === undefined) {
		state = "unavailable";
		return;
	}
	try {
		open({ library: LIBRARY_KEY, path });
		const fns = define({
			diff_engine_api_version: {
				library: LIBRARY_KEY,
				funcName: "diff_engine_api_version",
				retType: DataType.U32,
				paramsType: [],
			},
			diff_generate_json: {
				library: LIBRARY_KEY,
				funcName: "diff_generate_json",
				retType: DataType.String,
				paramsType: [DataType.String, DataType.String, DataType.U32, DataType.U32],
			},
		});
		const version = fns.diff_engine_api_version([]) as number;
		if (version !== API_VERSION) {
			close(LIBRARY_KEY);
			state = "unavailable";
			return;
		}
		generate = fns.diff_generate_json as typeof generate;
		state = "loaded";
	} catch {
		state = "unavailable";
	}
}

/** Whether the Rust engine is loaded and usable. */
export function isRustDiffEngineAvailable(): boolean {
	loadEngine();
	return state === "loaded";
}

/**
 * Generate a diff via the Rust engine. Returns the raw JSON (rows + stats) or
 * undefined when the engine is unavailable.
 */
export function rustGenerateDiffJson(
	oldText: string,
	newText: string,
	contextLines: number,
	timeoutMs: number,
): string | undefined {
	if (!isRustDiffEngineAvailable() || generate === undefined) return undefined;
	try {
		return generate([oldText, newText, contextLines, timeoutMs]) as string;
	} catch {
		return undefined;
	}
}
