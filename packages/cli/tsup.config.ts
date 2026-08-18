import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		cli: "src/cli.ts",
		index: "src/index.ts",
	},
	format: ["cjs"],
	dts: { entry: { index: "src/index.ts" } },
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	banner: {
		js: "#!/usr/bin/env node",
	},
});
