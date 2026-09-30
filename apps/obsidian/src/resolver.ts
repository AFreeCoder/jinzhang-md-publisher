import type { AssetResolver, ResolvedAsset } from '@jinzhang/core';
/** 解析器用到的 Obsidian 能力，测试里可以换成假的 vault。 */
export interface VaultFile {
  path: string;
  extension: string;
  stat: { mtime: number; size: number };
}
export interface VaultAccess {
  getFileByPath(path: string): VaultFile | null;
  getFirstLinkpathDest(linkpath: string, sourcePath: string): VaultFile | null;
  readBinary(file: VaultFile): Promise<ArrayBuffer>;
  /** 读取 vault 外的磁盘文件（node:fs）。 */
  readDisk(absPath: string): Promise<Uint8Array>;
}
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};
const mimeOf = (path: string) =>
  MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const isWindowsAbsolute = (path: string) => /^[a-z]:[\\/]/i.test(path);
/** 规范化 vault 内路径：去掉首尾斜杠与 `.`，处理 `..`；越出 vault 返回 undefined。 */
function vaultPath(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/').normalize('NFC');
}
export function joinDisk(base: string, relative: string) {
  const windows = isWindowsAbsolute(base);
  const parts = base.replace(/\\/g, '/').split('/');
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(part);
  }
  const joined = parts.join('/');
  return windows ? joined : joined.startsWith('/') ? joined : `/${joined}`;
}
/** 按 Obsidian 的链接规则找图（设计第 3 节）：读出字节返回 blob，找不到时写明找过哪些位置。 */
export class VaultAssetResolver implements AssetResolver {
  constructor(
    private vault: VaultAccess,
    /** vault 根目录的磁盘路径。 */
    private basePath: string,
    /** 当前笔记在 vault 里的路径。 */
    private notePath: string,
  ) {}
  private async fromVault(file: VaultFile): Promise<ResolvedAsset> {
    return {
      kind: 'blob',
      bytes: new Uint8Array(await this.vault.readBinary(file)),
      mime: mimeOf(file.path),
      assetId: file.path,
    };
  }
  private async fromDisk(absPath: string): Promise<ResolvedAsset | undefined> {
    try {
      return {
        kind: 'blob',
        bytes: await this.vault.readDisk(absPath),
        mime: mimeOf(absPath),
        assetId: absPath,
      };
    } catch {
      return undefined;
    }
  }
  async resolve(ref: string): Promise<ResolvedAsset> {
    if (/^https?:\/\//i.test(ref)) {
      try {
        const url = new URL(ref);
        if (url.username || url.password) throw new Error();
        return { kind: 'remote', url: url.href };
      } catch {
        return { kind: 'missing', reason: '图片地址无效' };
      }
    }
    const data = ref.match(/^data:(image\/[\w.+-]+);base64,(.*)$/is);
    if (data) {
      try {
        return {
          kind: 'data',
          bytes: Uint8Array.from(atob(data[2]), (c) => c.charCodeAt(0)),
          mime: data[1],
        };
      } catch {
        return { kind: 'missing', reason: '内嵌图片无效' };
      }
    }
    if (ref.startsWith('jz-local://vault/')) {
      const path = decode(ref.slice('jz-local://vault/'.length));
      const file = this.vault.getFileByPath(path);
      return file ? this.fromVault(file) : { kind: 'missing', reason: `vault 里找不到 ${path}` };
    }
    if (ref.startsWith('jz-local://file/')) {
      const rest = decode(ref.slice('jz-local://file/'.length));
      const absPath = isWindowsAbsolute(rest) ? rest : `/${rest}`;
      return (
        (await this.fromDisk(absPath)) ?? { kind: 'missing', reason: `磁盘上找不到 ${absPath}` }
      );
    }
    const path = decode(ref.trim());
    if (!path) return { kind: 'missing', reason: '图片地址为空' };
    if (isWindowsAbsolute(path))
      return (await this.fromDisk(path)) ?? { kind: 'missing', reason: `磁盘上找不到 ${path}` };
    if (path.startsWith('/')) {
      const inVault = vaultPath(path);
      const file = inVault !== undefined ? this.vault.getFileByPath(inVault) : null;
      if (file) return this.fromVault(file);
      return (
        (await this.fromDisk(path)) ?? {
          kind: 'missing',
          reason: `找过 vault 内的 /${inVault ?? ''} 与磁盘上的 ${path}`,
        }
      );
    }
    const linked = this.vault.getFirstLinkpathDest(path, this.notePath);
    if (linked) return this.fromVault(linked);
    const noteDir = this.notePath.includes('/') ? this.notePath.replace(/\/[^/]*$/, '') : '';
    const absPath = joinDisk(joinDisk(this.basePath, noteDir), path);
    return (
      (await this.fromDisk(absPath)) ?? {
        kind: 'missing',
        reason: `找过 vault 链接「${path}」与磁盘上的 ${absPath}`,
      }
    );
  }
}
