import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.canonical.{test,spec}.ts"],
  },
});
