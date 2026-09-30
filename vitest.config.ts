import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // obsidian 包只有类型声明，插件测试用桩代替。
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./apps/obsidian/test/obsidian-stub.ts', import.meta.url)),
    },
  },
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], testTimeout: 15000 },
});
