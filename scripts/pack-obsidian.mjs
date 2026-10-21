// 把 apps/obsidian/dist 的三件套打成网站下载用的 zip：解压得到 jinzhang 文件夹，放进 vault 的 .obsidian/plugins 即可。
// 只用 Node 自带的 zlib（crc32 需要 Node 22.2 以上），不引入压缩依赖。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const dist = new URL('apps/obsidian/dist/', root);
const out = new URL('apps/web/public/downloads/', root);
const FILES = ['main.js', 'manifest.json', 'styles.css'];
const FOLDER = 'jinzhang/';

const { version } = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`manifest.json 的版本号无效：${version}`);

/** zip 里的时间是 MS-DOS 格式（本地时间，精度 2 秒）。 */
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const stamp = dosTime(new Date());
const entries = [{ name: FOLDER, data: Buffer.alloc(0), directory: true }];
for (const file of FILES)
  entries.push({ name: FOLDER + file, data: await readFile(new URL(file, dist)) });

const locals = [];
const centrals = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const stored = entry.directory;
  const body = stored ? entry.data : deflateRawSync(entry.data, { level: 9 });
  const crc = stored ? 0 : crc32(entry.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // 解压所需版本 2.0
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(stored ? 0 : 8, 8); // 0 存储，8 deflate
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(entry.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // 创建者版本 2.0（MS-DOS 属性）
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(stored ? 0 : 8, 10);
  central.writeUInt16LE(stamp.time, 12);
  central.writeUInt16LE(stamp.date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(entry.data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(entry.directory ? 0x10 : 0, 38); // 目录属性
  central.writeUInt32LE(offset, 42);
  locals.push(local, name, body);
  centrals.push(central, name);
  offset += local.length + name.length + body.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

// 只保留当前版本，避免旧包随镜像一起发布。
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const zipName = `jinzhang-obsidian-${version}.zip`;
await writeFile(new URL(zipName, out), Buffer.concat([...locals, directory, end]));
console.log(`Obsidian 插件安装包：apps/web/public/downloads/${zipName}`);
