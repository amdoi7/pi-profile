import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Resolve pi runtime packages against the globally installed pi distribution
 * so tests always run against the exact version pi itself uses. The packages
 * are nested under @earendil-works/pi-coding-agent's own node_modules.
 * mise 环境下 npm root -g 可能指向 mise 全局根：优先 agent 根 node_modules 的固定链接。
 */
const agentLink = join(process.env.HOME ?? "", ".pi", "agent", "node_modules", "@earendil-works", "pi-coding-agent");
const globalRoot = execSync("npm root -g").toString().trim();
const piCodingAgent = existsSync(join(agentLink, "package.json"))
	? realpathSync(agentLink)
	: `${globalRoot}/@earendil-works/pi-coding-agent`;
const piWorkspace = `${piCodingAgent}/node_modules/@earendil-works`;

export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-tui": `${piWorkspace}/pi-tui`,
      "@earendil-works/pi-ai": `${piWorkspace}/pi-ai`,
      "@earendil-works/pi-coding-agent": piCodingAgent,
    },
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
