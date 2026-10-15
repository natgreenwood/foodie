import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Recreates and migrates the database in TEST_DATABASE_URL before any
    // test file runs; fails the run if it is not set or not reachable.
    globalSetup: ["src/test/global-setup.ts"],
  },
});
