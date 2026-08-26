import { defineConfig } from "vitest/config";

/** 扩展运行时在 pi 宿主内解析 pi-coding-agent/pi-tui(node_modules 仅测试工具);
 * vitest 需显式 alias 到宿主包,与 tsconfig paths 对齐。 */
export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent":
				"/Users/amdoi7/.pi/agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
			"@earendil-works/pi-tui": "/Users/amdoi7/.pi/agent/node_modules/@earendil-works/pi-tui/dist/index.js",
		},
	},
});
