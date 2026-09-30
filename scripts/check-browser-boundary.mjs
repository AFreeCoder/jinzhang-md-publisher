import { build } from 'tsup';
import { readFile, readdir } from 'node:fs/promises';
await build({
  entry: [
    'packages/core/dist/index.js',
    'packages/core/dist/preview.js',
    'packages/core/dist/browser.js',
    'apps/web/lib/clipboard.ts',
  ],
  outDir: '.browser-audit',
  format: ['esm'],
  platform: 'browser',
  bundle: true,
  noExternal: [/.*/],
  metafile: true,
  clean: true,
  silent: true,
});
const files = await readdir('.browser-audit');
let checked = 0;
for (const file of files.filter((f) => f.endsWith('.json'))) {
  const graph = JSON.parse(await readFile(`.browser-audit/${file}`, 'utf8'));
  for (const input of Object.keys(graph.inputs || {})) {
    if (/(?:^|\/)(?:sharp|ali-oss|node:|publish)(?:\/|$)/.test(input))
      throw new Error(`浏览器依赖越界: ${input}`);
    checked++;
  }
}
if (!checked) throw new Error('未生成可检查的浏览器依赖图');
const chunks = await readdir('apps/web/.next/static/chunks');
for (const file of chunks.filter((f) => f.endsWith('.js'))) {
  const source = await readFile(`apps/web/.next/static/chunks/${file}`, 'utf8');
  if (/OSS_ACCESS_KEY_SECRET|TRANSIT_TICKET_SECRET/.test(source))
    throw new Error(`客户端含服务端配置名: ${file}`);
}
// Obsidian 插件产物：打包不能带原生模块与服务端依赖（sharp、ali-oss）。
const plugin = JSON.parse(await readFile('apps/obsidian/dist/meta.json', 'utf8'));
const pluginInputs = Object.keys(plugin.inputs || {});
for (const input of pluginInputs)
  if (/(?:^|\/)(?:sharp|ali-oss|kerberos)(?:\/|$)/.test(input))
    throw new Error(`插件产物越界: ${input}`);
if (!pluginInputs.length) throw new Error('未生成可检查的插件依赖图');
const bundle = await readFile('apps/obsidian/dist/main.js', 'utf8');
if (/require\(["'](?:sharp|ali-oss|kerberos)["']\)|["'](?:sharp|ali-oss)["']\s*\)/.test(bundle))
  throw new Error('插件产物引用了 sharp 或 ali-oss');
console.log(
  `浏览器依赖边界通过：${checked} 个模块；浏览器构建拒绝 Node 内置模块，无 OSS/sharp/投递依赖。`,
);
console.log(`插件产物检查通过：${pluginInputs.length} 个模块，不含 sharp 与 ali-oss。`);
