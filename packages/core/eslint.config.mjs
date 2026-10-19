import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

// Core ships inside the plugin bundle, so the community directory's review
// reads its source with the same recommended config as packages/obsidian.
//
// `bun run lint` runs this from the repository root (see package.json): the
// recommended config reads manifest.json from the working directory and takes
// the desktop-only allowances (Node globals, Node built-in imports) from it,
// as the review does with the root manifest. Run from this directory it finds
// no manifest, prints an ENOENT stack trace and warns on every Node import.
// `basePath` keeps the patterns below relative to this package.
const basePath = import.meta.dirname;

export default defineConfig(
	{
		basePath,
		ignores: [
			"node_modules",
			"dist",
			"coverage",
			".turbo",
			"*.config.ts",
			"*.config.mjs",
			"package.json",
			"tsconfig.json",
		],
	},
	{
		basePath,
		files: ["src/**/*.ts"],
		ignores: ["src/**/*.test.ts"],
		extends: [obsidianmd.configs.recommended],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: basePath,
			},
		},
	},
	// Test support runs in Node only and never ships (tsup builds only the
	// entries in tsup.config.ts), so there is no window to take timers from.
	{
		basePath,
		files: ["src/testing/**/*.ts"],
		rules: {
			"obsidianmd/prefer-window-timers": "off",
		},
	},
	// Tests do not ship and tsconfig.json leaves them out, so the type-checked
	// review rules cannot run on them. They keep the untyped rules they had.
	{
		basePath,
		files: ["src/**/*.test.ts"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
);
