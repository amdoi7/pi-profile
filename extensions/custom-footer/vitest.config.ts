import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";

/**
 * Resolve pi runtime packages against the globally installed pi distribution
 * so tests always run against the exact version pi itself uses. The packages
 * are nested under @earendil-works/pi-coding-agent's own node_modules.
 */
const globalRoot = execSync("npm root -g").toString().trim();
const piCodingAgent = `${globalRoot}/@earendil-works/pi-coding-agent`;
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
