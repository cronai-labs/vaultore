import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("src/__mocks__/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    setupFiles: ["../core/src/testing/no-network.ts"],
  },
});
