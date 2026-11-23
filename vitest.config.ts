import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `obsidian` 包只有类型定义，没有运行时入口，单测里替换为替身
      obsidian: path.resolve(__dirname, "test/stubs/obsidian.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
