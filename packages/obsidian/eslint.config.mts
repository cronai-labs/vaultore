import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
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
		"manifest.json",
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
);
