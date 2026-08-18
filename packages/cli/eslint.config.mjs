import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["dist", "node_modules", "coverage", ".turbo", "*.config.ts", "*.config.mjs"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		files: ["**/*.test.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	}
);
