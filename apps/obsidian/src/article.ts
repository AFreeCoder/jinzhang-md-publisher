import { prepare, render, type Platform, type RenderResult, type Warning } from '@jinzhang/core';
import { localFixed, type JinzhangConfig } from '@jinzhang/core/publish';
import { preprocessObsidian, type EmbedTarget } from './obsidian-markdown';
import { VaultAssetResolver, type VaultAccess } from './resolver';
/** 一次操作只取一份编辑器文本：预处理、排版、体检、确认、复制与推送都用它（设计第 7 节）。 */
export interface Snapshot {
  /** 笔记在 vault 里的路径。 */
  path: string;
  /** 源文件规范化后的绝对路径，草稿映射与文章设置的键。 */
  source: string;
  title: string;
  content: string;
  /** 属性区结束位置，由 `getFrontMatterInfo(content)` 给出。 */
  contentStart: number;
}
export interface BuildEnv {
  vault: VaultAccess;
  basePath: string;
  config: JinzhangConfig;
  /** 公众号的结尾 Markdown 与知乎的默认结尾，来自配置目录的模板文件。 */
  footers: Record<Platform, string>;
  /** 单独设置的封面（绝对路径），没有为 undefined。 */
  cover?: string;
  resolveEmbed(linkpath: string, notePath: string): EmbedTarget | null;
  today?: string;
}
export interface BuiltArticle {
  platform: Platform;
  result: RenderResult;
  /** 预处理产生的提示（嵌入笔记不展开等）。 */
  notes: Warning[];
  fixed: { header: boolean; footer: boolean };
  templates: { header: string; footer: string };
  variables: Record<string, string>;
}
let task = 0;
export async function buildArticle(
  snapshot: Snapshot,
  platform: Platform,
  env: BuildEnv,
): Promise<BuiltArticle> {
  const { markdown, warnings: notes } = preprocessObsidian(snapshot.content, {
    contentStart: snapshot.contentStart,
    resolveEmbed: (linkpath) => env.resolveEmbed(linkpath, snapshot.path),
  });
  const { fixed, templates, variables, card } = localFixed(
    platform,
    env.config,
    env.footers,
    env.today ?? new Date().toLocaleDateString('sv-SE'),
  );
  const prepared = await prepare(
    { markdown, title: snapshot.title, templates },
    {
      platform,
      fixed,
      plainFixed: true,
      card,
      cover: env.cover,
      resolver: new VaultAssetResolver(env.vault, env.basePath, snapshot.path),
      config: variables,
      version: String(++task),
    },
  );
  return {
    platform,
    result: render(prepared, { theme: env.config.theme }),
    notes,
    fixed,
    templates,
    variables,
  };
}
