import { defineConfig } from 'tsup';
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/preview.ts', 'src/browser.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
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
