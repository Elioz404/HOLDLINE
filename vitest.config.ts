import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // No test in this suite is allowed to reach the network. Every fixture is
    // local JSON; the CALL-E client is never constructed with real credentials.
    testTimeout: 5_000,
  },
});
