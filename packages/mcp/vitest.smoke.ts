import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.smoke.test.ts"],
    testTimeout: 30_000,
  },
});
