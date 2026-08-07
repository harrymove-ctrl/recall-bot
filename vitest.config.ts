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
      SLACK_SIGNING_SECRET: "test-signing-secret",
      SLACK_CLIENT_ID: "test-client-id",
      SLACK_CLIENT_SECRET: "test-client-secret",
      SLACK_STATE_SECRET: "test-state-secret-test-state-secret",
      DASHBOARD_SESSION_SECRET: "test-dashboard-session-secret",
      USER_SESSION_SECRET: "test-user-session-secret",
      PUBLIC_BASE_URL: "https://recall-bot.test",
    },
  },
});
