import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30000,
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    env: {
      DATABASE_URL: "postgres://recall:recall@localhost:55432/recall_test",
      BUCKET: "test-bucket",
      ACCESS_KEY_ID: "test-access-key",
      SECRET_ACCESS_KEY: "test-secret-key",
      REGION: "us-east-1",
      ENDPOINT: "http://localhost:9000",
    },
  },
});
