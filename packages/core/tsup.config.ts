import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "parser/index": "src/parser/index.ts",
    "executor/index": "src/executor/index.ts",
    "runtime/index": "src/runtime/index.ts",
    "providers/index": "src/providers/index.ts",
    "scheduler/index": "src/scheduler/index.ts",
    "vault/index": "src/vault/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
