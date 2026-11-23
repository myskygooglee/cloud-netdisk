import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "esbuild.config.mjs",
    "vitest.config.ts",
    "versions.json",
    "main.js",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "manifest.json"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // 插件要跟 115 这类无类型的第三方 JSON 接口打交道，
      // 允许在少数边界处显式标注 any（其余 unsafe-* 规则仍然生效）。
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // 单测文件不进产物，也不参与社区审核，放宽类型严格度。
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
