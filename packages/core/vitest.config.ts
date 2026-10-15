import { configDefaults, defineConfig } from "vitest/config";

// Integration tests need a container engine; they run only through
// vitest.integration.config.ts (`test:integration`).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.{test,spec}.ts"],
  },
});
