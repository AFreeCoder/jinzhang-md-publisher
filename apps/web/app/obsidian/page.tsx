import type { Metadata } from 'next';
import Link from 'next/link';
import { version } from '../../package.json';
import { obsidianPlugin } from '../../lib/obsidian-plugin';
import { SiteHeader } from '../site-header';

export const metadata: Metadata = {
  title: 'Obsidian 插件 · 锦章 Jinzhang',
  description:
    '下载锦章 Obsidian 插件：在笔记旁预览公众号与知乎成品，复制到平台编辑器，或一键推送到草稿箱。附安装与使用教程。',
};

const sections = [
  ['install', '安装'],
  ['preview', '打开预览'],
  ['copy', '复制到平台'],
  ['push', '推送到草稿箱'],
  ['style', '开头、结尾与名片'],
  ['syntax', 'Obsidian 写法'],
  ['commands', '命令一览'],
  ['data', '数据存在哪里'],
  ['update', '更新与卸载'],
  ['faq', '常见问题'],
] as const;

/** 与 Obsidian 界面一致的 Lucide 图标，帮读者认出按钮。 */
const icons = {
  newspaper: (
    <>
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
      <path d="M18 14h-8" />
      <path d="M15 18h-5" />
      <path d="M10 6h8v4h-8V6Z" />
    </>
  ),
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  checks: (
    <>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  folder: (
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  ),
  reload: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
};
function Icon({ name, label }: { name: keyof typeof icons; label?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {icons[name]}
    </svg>
  );
}

function Heading({ id, children }: { id: string; children: React.ReactNode }) {
  const index = sections.findIndex(([key]) => key === id) + 1;
  return (
    <h2 className="serif">
      <span>{String(index).padStart(2, '0')}</span>
      {children}
    </h2>
  );
}

export default function ObsidianGuide() {
  const { download, minAppVersion, repo } = obsidianPlugin;
  return (
    <main id="guide">
      <SiteHeader />
      <section className="guide-hero">
        <div>
          <div className="eyebrow">OBSIDIAN 插件</div>
          <h1 className="serif">
            在笔记里，
            <br />
            <em>写完就发。</em>
          </h1>
          <p className="lead">
            锦章插件把成品预览放在 Obsidian
            右侧栏：边写边看公众号排版，写完复制到平台编辑器，或直接推送到公众号与知乎的草稿箱。
          </p>
          <div className="guide-download">
            <a className="primary entry-action" href={download} download>
              下载插件 v{obsidianPlugin.version} <span>↓</span>
            </a>
            <small>
              免费 · 适用于 Obsidian {minAppVersion}{' '}
              及以上的桌面版（macOS、Windows、Linux），不支持手机
            </small>
          </div>
        </div>
        <ol className="guide-glance" aria-label="三步上手">
          <li>
            <b>下载并解压</b>
            <span>
              得到 <code>jinzhang</code> 文件夹，放进仓库的插件文件夹
            </span>
          </li>
          <li>
            <b>启用插件</b>
            <span>设置 → 第三方插件，打开「锦章 Jinzhang」</span>
          </li>
          <li>
            <b>打开预览</b>
            <span>
              点左侧功能区的 <Icon name="newspaper" label="报纸图标" />
              ，右侧栏出现成品
            </span>
          </li>
        </ol>
      </section>

      <div className="guide-body">
        <nav className="guide-toc" aria-label="目录">
          {sections.map(([id, name], i) => (
            <a key={id} href={`#${id}`}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              {name}
            </a>
          ))}
        </nav>

        <article className="guide-article">
          <section id="install">
            <Heading id="install">安装</Heading>
            <p>插件装在当前仓库（vault）里；有多个仓库时，每个仓库各装一次。两种方式任选其一。</p>

            <h3>方式一：下载安装包（推荐）</h3>
            <ol className="steps">
              <li>
                <a href={download} download>
                  下载安装包
                </a>
                并解压，得到一个 <code>jinzhang</code> 文件夹，里面有 <code>main.js</code>、
                <code>manifest.json</code>、<code>styles.css</code> 三个文件。
              </li>
              <li>
                在 Obsidian 打开<b>设置 → 第三方插件</b>
                。如果页面提示处于安全模式（受限模式），先按提示允许社区插件。
              </li>
              <li>
                点「已安装插件」右侧的 <Icon name="folder" label="文件夹图标" />
                （打开插件文件夹），把 <code>jinzhang</code> 文件夹整个放进去。放好后的位置是
                <code>.obsidian/plugins/jinzhang/main.js</code>。
              </li>
              <li>
                回到第三方插件页，点「已安装插件」右侧的 <Icon name="reload" label="刷新图标" />
                （重新加载插件），在列表里找到「锦章 Jinzhang」，打开右侧的开关。
              </li>
            </ol>
            <p className="note">
              Windows 的「全部解压缩」会多套一层{' '}
              <code>jinzhang-obsidian-{obsidianPlugin.version}</code>
              文件夹，放进插件文件夹的应该是里面那个 <code>jinzhang</code>。
            </p>

            <h3>方式二：用 BRAT 安装（自动更新）</h3>
            <p>适合能顺畅访问 GitHub 的用户，以后发布新版本会自动更新。</p>
            <ol className="steps">
              <li>
                在<b>设置 → 第三方插件 → 社区插件市场</b>里搜索 BRAT，安装并启用。
              </li>
              <li>
                打开 BRAT 的设置，点「Add Beta plugin」，填入仓库 <code>{repo}</code>
                ，按提示完成添加。
              </li>
              <li>回到第三方插件页，打开「锦章 Jinzhang」的开关。</li>
            </ol>
          </section>

          <section id="preview">
            <Heading id="preview">打开预览</Heading>
            <p>
              点左侧功能区的 <Icon name="newspaper" label="报纸图标" />
              （悬停显示「打开锦章预览」），或按 <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>P</kbd>{' '}
              打开命令面板，输入「锦章」选择「打开预览」。预览出现在右侧栏，已经打开时会切过去。
            </p>
            <ul>
              <li>预览跟随当前笔记：编辑后约半秒自动刷新，还没保存的改动也算在内。</li>
              <li>滚动编辑器时，预览跟着滚到对应的位置。</li>
              <li>拖动右侧栏的宽度，就能看到窄屏下的效果。</li>
              <li>找不到的图片显示为占位块，预览底部列出没找到的引用和找过的位置。</li>
            </ul>
            <div className="mock-toolbar" aria-hidden="true">
              <span className="mock-seg">
                <span className="on">公众号</span>
                <span>知乎</span>
              </span>
              <span className="mock-chip">少数派 ▾</span>
              <span className="mock-chip">封面：正文首图</span>
              <span className="mock-spacer" />
              <span className="mock-icon">
                <Icon name="copy" />
              </span>
              <span className="mock-icon">
                <Icon name="checks" />
              </span>
              <span className="mock-icon">
                <Icon name="send" />
              </span>
            </div>
            <p className="caption">预览顶部的工具栏，从左到右：</p>
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr>
                    <th>公众号 / 知乎</th>
                    <td>切换预览的平台。公众号所见即所得；知乎只看结构，最终样式由知乎决定。</td>
                  </tr>
                  <tr>
                    <th>主题</th>
                    <td>少数派、公众号原生、Mac 三套，只作用于公众号。</td>
                  </tr>
                  <tr>
                    <th>封面</th>
                    <td>显示当前封面来自哪里，点击可换一张，见「推送到草稿箱」。</td>
                  </tr>
                  <tr>
                    <th>
                      <Icon name="copy" /> 复制
                    </th>
                    <td>复制当前平台的成品，见下一节。</td>
                  </tr>
                  <tr>
                    <th>
                      <Icon name="checks" /> 体检
                    </th>
                    <td>检查当前平台能否推送，只检查、不推送。</td>
                  </tr>
                  <tr>
                    <th>
                      <Icon name="send" /> 推送
                    </th>
                    <td>推送到当前平台的草稿箱。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="copy">
            <Heading id="copy">复制到平台编辑器</Heading>
            <p>不用填任何账号，装好就能用。</p>
            <ol className="steps">
              <li>
                在预览里选好平台，点工具栏的 <Icon name="copy" label="复制图标" />
                ，或用命令「复制为公众号格式」「复制为知乎格式」。
              </li>
              <li>到公众号后台或知乎的文章编辑器里粘贴，核对一遍。</li>
            </ol>
            <ul>
              <li>公众号：图片随正文一起进剪贴板，粘贴后由公众号编辑器保存。</li>
              <li>
                知乎：本地图片会临时传到锦章服务器，换成 24
                小时有效的地址，知乎粘贴时会把图片转存到自己的图床；临时文件 1
                天后自动删除。网络图片保留原地址，粘贴后请看一眼是否显示。
              </li>
              <li>复制的内容不含封面，封面请在平台编辑器里单独设置。</li>
              <li>
                如果写入剪贴板失败，会弹出「手动复制」窗口，正文已经全选，按 <kbd>Ctrl</kbd> /{' '}
                <kbd>⌘</kbd> + <kbd>C</kbd> 复制即可。
              </li>
            </ul>
          </section>

          <section id="push">
            <Heading id="push">推送到草稿箱</Heading>
            <p>
              推送只会新建或更新草稿，不会直接发布；发布前请在平台后台再看一遍。第一次推送前，先做下面的准备。
            </p>

            <h3>公众号：填写开发者凭证与 IP 白名单</h3>
            <ol className="steps">
              <li>
                登录公众号后台，在<b>设置与开发 → 基本配置</b>里找到开发者
                ID（AppID）和开发者密码（AppSecret）。
              </li>
              <li>
                在 Obsidian 打开<b>设置 → 锦章 Jinzhang → 公众号</b>，填入 AppID 与
                AppSecret，点「保存凭证」。
              </li>
              <li>
                点「探测出口 IP」，IP 会自动复制，把它加到公众号后台的
                <b>设置与开发 → 基本配置 → IP 白名单</b>。
              </li>
            </ol>
            <p className="note">
              家庭宽带的 IP
              会变，变了以后推送前体检会提示，重新探测并加进白名单即可。有固定出口的代理时，可以填在「代理地址」里，只有公众号请求会走代理。
            </p>

            <h3>知乎：登录</h3>
            <p>
              在<b>设置 → 锦章 Jinzhang → 知乎</b>
              点「登录」（也可以用命令「登录知乎」），在弹窗里用知乎 App
              扫码或输入账号登录，需要滑动验证就在弹窗里完成。登录成功后设置页会显示账号名。
            </p>

            <h3>封面</h3>
            <p>
              默认用正文里的第一张图。想换一张，点工具栏的封面按钮或用命令「设置本文封面」，从仓库图片里搜索选择；选「清除，改回正文首图」可以恢复默认。公众号草稿必须有封面，纯文字的稿子要先设置封面；知乎没有封面时草稿不设题图。
            </p>

            <h3>推送</h3>
            <ol className="steps">
              <li>
                点工具栏的 <Icon name="send" label="推送图标" />
                推送到当前平台，或用命令「推送到公众号」「推送到知乎」「推送到默认平台」。
              </li>
              <li>
                插件先做体检：凭证、白名单、登录状态、封面、图片和正文长度。有问题的平台会写明原因和怎么处理，其他平台照常继续。
              </li>
              <li>
                确认弹窗列出要推送的平台、账号、标题、封面、图片数、字数，以及是新建还是更新草稿。点「确认推送」后才开始上传。
              </li>
              <li>完成后在结果弹窗里点「打开草稿」，到平台里核对并发布。</li>
            </ol>
            <ul>
              <li>
                改稿后重推：同一篇笔记再次推送，会更新上次那份草稿，不会重复新建；原草稿已删除或已发布时会新建一份并提示。知乎文章发布后再推送，只更新草稿，不改线上内容。
              </li>
              <li>
                默认推送平台：在<b>设置 → 锦章 Jinzhang → 排版</b>
                里打开「默认推送到公众号」「默认推送到知乎」，命令「推送到默认平台」会依次推送选中的平台。
              </li>
              <li>
                结果不确定：网络中断时可能不知道草稿建好没有，结果里会提示先去草稿箱确认。下次推送这篇时，确认弹窗里要勾选「草稿箱里没有对应草稿」才能继续；如果草稿其实已经建好，先在平台删掉那份再勾选。
              </li>
            </ul>
          </section>

          <section id="style">
            <Heading id="style">开头、结尾与名片</Heading>
            <p>
              在<b>设置 → 锦章 Jinzhang</b>
              里可以给文章加固定的开头和结尾，预览、复制与推送都会带上。
            </p>
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr>
                    <th>开头样式一</th>
                    <td>
                      公众号文章最上方依次显示顶部宣言、账号名片、作者、出品公众号和分隔线，没填的行不显示。
                    </td>
                  </tr>
                  <tr>
                    <th>结尾样式一</th>
                    <td>
                      公众号文章末尾先放你写的一段 Markdown，启用名片时再放账号名片。可以用{' '}
                      <code>{'{{title}}'}</code>、<code>{'{{date}}'}</code>、
                      <code>{'{{author}}'}</code>，缺值的行不显示。
                    </td>
                  </tr>
                  <tr>
                    <th>账号名片</th>
                    <td>
                      需要填公众号 ID（fakeid）和名称，设置页里有获取 fakeid
                      的说明链接。名片在公众号编辑器里才会真正显示，预览里用占位块示意。
                    </td>
                  </tr>
                  <tr>
                    <th>知乎默认结尾</th>
                    <td>追加在知乎正文之后，只保留文字、图片与链接；知乎没有开头，也不带名片。</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              两段结尾 Markdown 保存在配置目录的模板文件里，<b>高级 → 打开模板目录</b>
              可以直接用编辑器修改。
            </p>
          </section>

          <section id="syntax">
            <Heading id="syntax">Obsidian 写法怎么处理</Heading>
            <p>
              标题取笔记的文件名；正文第一个一级标题与文件名相同时会自动去重。图片支持仓库里的附件、本机绝对路径和网络图片。Obsidian
              特有的写法在发布前这样转换：
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>写法</th>
                    <th>发布时</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>文件开头的属性区（YAML）</td>
                    <td>去掉，不进正文</td>
                  </tr>
                  <tr>
                    <td>
                      <code>%%注释%%</code>
                    </td>
                    <td>删除，写给自己的话不会发出去</td>
                  </tr>
                  <tr>
                    <td>
                      <code>![[图片.png]]</code>、<code>![[图片.png|300]]</code>
                    </td>
                    <td>按 Obsidian 的规则找到图片，宽度参数忽略</td>
                  </tr>
                  <tr>
                    <td>
                      <code>[[笔记]]</code>、<code>[[笔记|别名]]</code>
                    </td>
                    <td>只保留显示的文字</td>
                  </tr>
                  <tr>
                    <td>
                      <code>![[其他笔记]]</code>
                    </td>
                    <td>不展开，显示为「嵌入笔记：笔记名」并提示</td>
                  </tr>
                  <tr>
                    <td>
                      <code>{'> [!note] 标题'}</code> 等标注块
                    </td>
                    <td>转成普通引用，标题加粗</td>
                  </tr>
                  <tr>
                    <td>Dataview、Excalidraw 等其他插件的语法</td>
                    <td>当普通文本处理，并给出提示</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="commands">
            <Heading id="commands">命令一览</Heading>
            <p>
              在命令面板输入「锦章」都能找到，也可以在<b>设置 → 快捷键</b>
              里给常用命令绑定快捷键。除「打开预览」「登录知乎」外，其他命令需要当前打开的是一篇笔记。
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>命令</th>
                    <th>作用</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>打开预览</td>
                    <td>在右侧栏打开成品预览</td>
                  </tr>
                  <tr>
                    <td>复制为公众号格式 / 复制为知乎格式</td>
                    <td>复制当前笔记的成品</td>
                  </tr>
                  <tr>
                    <td>推送到公众号 / 推送到知乎</td>
                    <td>推送到单个平台的草稿箱</td>
                  </tr>
                  <tr>
                    <td>推送到默认平台</td>
                    <td>依次推送设置里选中的平台</td>
                  </tr>
                  <tr>
                    <td>推送前体检</td>
                    <td>只检查、不推送</td>
                  </tr>
                  <tr>
                    <td>设置本文封面</td>
                    <td>选择或清除当前笔记的封面</td>
                  </tr>
                  <tr>
                    <td>登录知乎</td>
                    <td>打开知乎登录弹窗</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="data">
            <Heading id="data">数据存在哪里</Heading>
            <ul>
              <li>
                排版和图片处理都在你的电脑上完成；推送时由你的电脑直接连接公众号和知乎，不经过锦章服务器。唯一的例外是「复制到知乎」时的本地图片，会在锦章服务器临时存放
                1 天。
              </li>
              <li>
                公众号凭证、知乎登录状态、排版设置、开头结尾模板和草稿记录，都保存在用户目录的
                <code>~/.config/jinzhang/</code>（Windows 为{' '}
                <code>C:\Users\用户名\.config\jinzhang</code>
                ），不放在仓库里，不会随仓库同步。换一台电脑需要重新设置。
              </li>
              <li>AppSecret 保存后，设置页不再显示它的值。</li>
            </ul>
          </section>

          <section id="update">
            <Heading id="update">更新与卸载</Heading>
            <ul>
              <li>
                下载安装的：到本页下载新版，用新的三个文件覆盖 <code>jinzhang</code>
                文件夹里的旧文件，然后在第三方插件里关掉再打开锦章，或重启
                Obsidian。设置都在配置目录里，不会丢。
              </li>
              <li>BRAT 安装的：BRAT 会自动检查更新，也可以在 BRAT 设置里手动检查。</li>
              <li>
                卸载：在<b>设置 → 第三方插件</b>
                里找到锦章，点卸载。配置目录不会被删除，不再使用时可以手动删掉
                <code>~/.config/jinzhang/</code>。
              </li>
            </ul>
          </section>

          <section id="faq">
            <Heading id="faq">常见问题</Heading>
            <h3>找不到 .obsidian 文件夹？</h3>
            <p>
              以点开头的文件夹默认隐藏。用第三方插件页的 <Icon name="folder" label="文件夹图标" />
              按钮打开最省事；也可以在 macOS 访达里按 <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>.</kbd>
              显示隐藏文件，或在 Windows 资源管理器里勾选「查看 → 隐藏的项目」。
            </p>
            <h3>放进去以后列表里没有锦章？</h3>
            <p>
              检查文件位置是不是 <code>.obsidian/plugins/jinzhang/main.js</code>
              ，中间不要多一层文件夹；然后点刷新按钮或重启 Obsidian。
            </p>
            <h3>推送公众号时提示 IP 不在白名单？</h3>
            <p>
              在设置里点「探测出口 IP」，把新的 IP 加到公众号后台的 IP 白名单。开关代理、换网络后 IP
              都可能变化。
            </p>
            <h3>提示公众号没有草稿或素材接口的权限？</h3>
            <p>说明这个公众号的账号类型不支持草稿接口，可以改用复制，到公众号编辑器里粘贴。</p>
            <h3>手机上能用吗？</h3>
            <p>
              插件只支持桌面版 Obsidian。在手机或别的电脑上，可以用
              <Link prefetch={false} href="/format">
                在线排版
              </Link>
              ，排版效果与插件一致。
            </p>
          </section>
        </article>
      </div>
      <footer>
        <span>锦章 Jinzhang · Markdown 发布助手 · v{version}</span>
        <span>写好内容，其余从简。</span>
      </footer>
    </main>
  );
}
