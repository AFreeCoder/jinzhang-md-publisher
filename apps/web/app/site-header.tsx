import Link from 'next/link';

export const repository = 'https://github.com/AFreeCoder/jinzhang-md-publisher';

/** 门户与教程页共用的顶栏；窄屏只保留 GitHub 与「开始排版」。 */
export function SiteHeader() {
  return (
    <header>
      <Link className="brand" href="/">
        <span className="seal">锦章</span> <small>JINZHANG</small>
      </Link>
      <nav>
        <a href="/#themes">排版样式</a>
        <Link href="/obsidian">Obsidian 插件</Link>
        <a className="github" href={repository} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
        <Link prefetch={false} href="/format" className="icon-link">
          开始排版 ↗
        </Link>
      </nav>
    </header>
  );
}
