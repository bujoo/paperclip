import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No workspace projects — run tests in this package directly
    globals: true,
    environment: "node",
  },
});
