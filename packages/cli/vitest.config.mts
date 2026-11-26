import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../core/src/testing/no-network.ts"],
  },
});
