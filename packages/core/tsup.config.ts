import { defineConfig } from 'tsup';
// 两份配置并行构建，不用 tsup 的 clean（会删掉另一份的产物），清理放在 build 脚本里。
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      preview: 'src/preview.ts',
      browser: 'src/browser.ts',
      publish: 'src/publish/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    noExternal: [/.*/],
    platform: 'browser',
    target: 'es2022',
    // worker 条件选择依赖的无 DOM 实现；浏览器条件仍为 css-tree 提供静态数据。
    esbuildOptions(options) {
      options.conditions = ['worker'];
    },
  },
  {
    // 配置目录读写只依赖 Node 内置模块，由命令行与 Obsidian 桌面端提供，不打进产物。
    entry: ['src/node.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    platform: 'node',
    target: 'es2022',
  },
]);
