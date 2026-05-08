import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default defineConfig([
    {
        ignores: ["coverage/", "node_modules/", "tsconfig.json", "tests/*.test*.ts"],
    },
    tseslint.configs.recommended,
    eslintConfigPrettier,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "_", argsIgnorePattern: "_" }],
        },
    },
]);