import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"dist",
		"package",
		"esbuild.config.mjs",
		"vitest.config.ts",
		"src/__mocks__",
		"src/**/*.test.ts",
		"package.json",
		"tsconfig.json",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mts"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: {
			// `brands` replaces the plugin's default brand list rather than
			// extending it, so this names every brand the UI text uses.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: [
						"VaultOre",
						"Obsidian",
						"OpenAI",
						"Anthropic",
						"Docker",
						"Podman",
						"Colima",
						"Apple",
						"macOS",
					],
					ignoreRegex: [
						// The default output folder, which brand matching would
						// otherwise "correct" to _VaultOre.
						"_vaultore",
						// Cell types and frontmatter keys rendered as code.
						"^ore:[a-z]+$",
						"^ore: true$",
						"^schedule$",
					],
				},
			],
		},
	},
	// The recommended config applies validate-manifest to JS and TS files only,
	// so the manifest needs its own block. The community directory's review
	// warns on keys the rule does not allow (#133, #135).
	{
		files: ["manifest.json"],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			parser: tseslint.parser,
		},
		rules: {
			"obsidianmd/validate-manifest": "error",
		},
	},
);
