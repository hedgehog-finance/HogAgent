import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["test/runtime-home.ts"],
  },
});
