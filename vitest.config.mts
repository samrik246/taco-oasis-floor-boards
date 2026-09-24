import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Tests run on the restaurant's clock, as the home-base Mac does. ExcelJS reads
// CSV dates in local time, and the committed xlsx fixture was built in Chicago,
// so a UTC runner would read the same CSV five hours apart from the fixture.
// Set before the test workers start, so they inherit it.
process.env.TZ = "America/Chicago";

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
