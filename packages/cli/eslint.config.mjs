import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

// The CLI does not ship in the plugin, but it lives in the repository the
// community directory's review reads, and it shares core's code paths. It gets
// the same recommended config as packages/obsidian and packages/core.
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
		rules: {
			// The CLI is a Node program and never runs in an Obsidian window:
			// there is no `window` to take timers from, and the popout-window
			// concern behind this rule does not arise.
			"obsidianmd/prefer-window-timers": "off",
		},
	},
	// The CLI's HTTP transport. Node has no `requestUrl`, and the recommended
	// config refuses an inline disable for this rule, so the exception is
	// scoped here to the one file that sends (#117).
	{
		basePath,
		files: ["src/fetch-request.ts"],
		rules: {
			"no-restricted-globals": "off",
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
