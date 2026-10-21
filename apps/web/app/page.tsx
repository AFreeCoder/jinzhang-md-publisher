import Link from 'next/link';
import { version } from '../package.json';
import { obsidianPlugin } from '../lib/obsidian-plugin';
import { SiteHeader } from './site-header';
export default function Home() {
  return (
    <main id="home">
      <SiteHeader />
      <section className="hero">
        <div>
          <div className="eyebrow">MARKDOWN 发布助手</div>
          <h1 className="serif">
            让文字，
            <br />
            <em>锦绣成章。</em>
          </h1>
          <p className="lead">
            写作已经花了很多心思，排版就交给锦章。
            <br />
            一篇 Markdown，妥帖呈现于公众号与知乎。
          </p>
          <div className="hero-meta">
            <span>原生 Markdown</span>
            <span>本地处理正文</span>
            <span>无需注册</span>
          </div>
        </div>
        <div className="art" aria-hidden="true">
          <div className="art-back">
            # 把想法写成文章
            <br />
            <br />
            好的内容，
            <br />
            值得被好好呈现。
            <br />
            <br />
            ## 从写作到发布
            <br />
            **专注于文字本身**
            <br />
            让排版轻一点。
          </div>
          <div className="art-front">
            <div className="number">JINZHANG / 01</div>
            <h2>
              好的内容，
              <br />
              自有章法。
            </h2>
            <p></p>
            <p></p>
            <p></p>
            <div className="stamp">锦绣成章</div>
          </div>
          <span className="art-note">从原文，到成品。</span>
        </div>
      </section>
      <section className="entry-grid">
        <article className="entry">
          <div className="entry-top">
            <span className="entry-icon">▤</span>
            <span className="tag">打开即用</span>
          </div>
          <h2>在浏览器里排版</h2>
          <p>
            贴入原文，挑一个喜欢的样式。
            <br />
            预览满意后，复制到平台编辑器。
          </p>
          <Link className="primary entry-action" prefetch={false} href="/format">
            打开在线排版 <span>↗</span>
          </Link>
        </article>
        <article className="entry">
          <div className="entry-top">
            <span className="entry-icon">⌘</span>
            <span className="tag">{process.env.JINZHANG_SKILL_INSTALL ? 'Skill' : '即将提供'}</span>
          </div>
          <h2>让 Agent 帮你发布</h2>
          <p>
            用一句话，把本地文章交给锦章 Skill。
            <br />
            在终端里预览、检查与投递草稿。
          </p>
          <code>{process.env.JINZHANG_SKILL_INSTALL || 'Skill 安装将在首个发行版本提供'}</code>
        </article>
        <article className="entry">
          <div className="entry-top">
            <span className="entry-icon">◇</span>
            <span className="tag">v{obsidianPlugin.version}</span>
          </div>
          <h2>留在 Obsidian 里</h2>
          <p>
            在写作发生的地方，完成发布前的最后一步。
            <br />
            从笔记直接预览、投递到草稿箱。
          </p>
          <a className="primary entry-action" href={obsidianPlugin.download} download>
            下载 Obsidian 插件 <span>↓</span>
          </a>
          <Link className="entry-more" href="/obsidian">
            安装与使用教程 →
          </Link>
        </article>
      </section>
      <section className="themes-section" id="themes">
        <div className="section-heading">
          <h2 className="serif">文字有风格，排版也有。</h2>
          <p>公众号呈现样式，知乎保留内容结构。</p>
        </div>
        <div className="samples">
          {[
            [
              '少数派',
              '把一个想法，认真写下来',
              '温润的纸面、克制的强调。',
              '让段落有呼吸，让重点被看见。',
            ],
            [
              '公众号原生',
              '留一点空间，给思考',
              '安静而有秩序的阅读节奏。',
              '适合长文、随笔与经验分享。',
            ],
            [
              'Mac',
              '复杂的技术，清楚地表达',
              '清晰的层次，明快的对比。',
              '让代码与文字，各得其所。',
            ],
          ].map(([name, title, a, b], i) => (
            <article className="sample" key={name}>
              <small>
                0{i + 1} / {name}
              </small>
              <b>{title}</b>
              <p>
                {a}
                <br />
                {b}
              </p>
            </article>
          ))}
        </div>
      </section>
      <footer>
        <span>锦章 Jinzhang · Markdown 发布助手 · v{version}</span>
        <span>写好内容，其余从简。</span>
      </footer>
    </main>
  );
}
