import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      src: path.join(root, "src"),
      test: path.join(root, "test"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setupEnv.ts"],
  },
});
