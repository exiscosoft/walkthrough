import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // Browser and ffmpeg tests share a fixture server and the CPU; run files one at a time.
    fileParallelism: false,
  },
});
