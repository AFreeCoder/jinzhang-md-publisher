import manifest from '../../obsidian/manifest.json';

/** Obsidian 插件的下载信息：安装包由 scripts/pack-obsidian.mjs 按同一份 manifest 生成，文件名带版本号。 */
export const obsidianPlugin = {
  version: manifest.version,
  minAppVersion: manifest.minAppVersion,
  download: `/downloads/jinzhang-obsidian-${manifest.version}.zip`,
  /** BRAT 安装与 GitHub Release 用的仓库。 */
  repo: 'AFreeCoder/jinzhang-md-publisher',
};
