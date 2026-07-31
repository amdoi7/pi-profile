import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Deprecated local bash override.
 *
 * Kept as a no-op so it no longer conflicts with ~/.pi/agent/extensions/command-policy,
 * which is the sole owner of shell command interception.
 */
export default function (_pi: ExtensionAPI) {
	// no-op
}
