import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
const production = process.argv[2] === 'production';
await mkdir('dist', { recursive: true });
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/main.js',
  // Obsidian 与 Electron 提供这些模块；Node 内置模块由桌面端提供，不打进产物。
  external: [
    'obsidian',
    'electron',
    '@electron/remote',
    '@codemirror/*',
    '@lezer/*',
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  sourcemap: production ? false : 'inline',
  minify: production,
  metafile: true,
  logLevel: 'info',
  banner: { js: '/* 锦章 Obsidian 插件，由 esbuild 从 apps/obsidian 构建 */' },
  plugins: [
    {
      name: 'jinzhang-assets',
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length) return;
          await copyFile('manifest.json', 'dist/manifest.json');
          await copyFile('styles.css', 'dist/styles.css');
          // 产物依赖图，scripts/check-browser-boundary.mjs 据此确认没有 sharp 与 ali-oss。
          await writeFile('dist/meta.json', JSON.stringify(result.metafile));
        });
      },
    },
  ],
});
if (production) {
  await context.rebuild();
  await context.dispose();
} else await context.watch();
