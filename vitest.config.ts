import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    env: {
      DATABASE_URL: "postgres://recall:recall@localhost:55432/recall_test",
    },
  },
});
