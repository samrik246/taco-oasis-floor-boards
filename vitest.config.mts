import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Integration tests share prisma/dev.db — run files serially
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
    },
  },
});
