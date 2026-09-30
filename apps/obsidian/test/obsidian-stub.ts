// Vitest 里代替 obsidian 包（它只有类型声明）；各测试再用 vi.mock 覆盖需要的行为。
export const requestUrl = (): never => {
  throw new Error('测试里需要用 vi.mock 提供 requestUrl');
};
export function getFrontMatterInfo(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match
    ? {
        exists: true,
        frontmatter: match[1],
        from: 4,
        to: 4 + match[1].length,
        contentStart: match[0].length,
      }
    : { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
}
export class Notice {
  constructor(public message = '') {}
  setMessage(message: string) {
    this.message = message;
    return this;
  }
  hide() {}
}
export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class MarkdownView {}
export class FuzzySuggestModal {}
export class TFile {}
export class FileSystemAdapter {}
export class Setting {}
export class ButtonComponent {}
export class DropdownComponent {}
export class TextAreaComponent {}
export const setIcon = () => {};
