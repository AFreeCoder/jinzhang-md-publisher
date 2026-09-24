import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { legacySamples } from '../lib/legacy-samples';
const fixture = path.resolve('fixtures/sample.png');
test('手机画布与预览栏一起收窄，正文不过度留白且小屏不横向溢出', async ({ page }) => {
  await page.goto('/format');
  await page
    .getByRole('textbox', { name: 'Markdown 原文' })
    .fill('## 手机阅读\n\n这是一段用于核对手机左右边距的正文。');
  const body = page.frameLocator('iframe').locator('body');
  await expect(body).toContainText('手机阅读');
  const original = await page.frameLocator('iframe').locator('article').innerHTML();
  for (const width of [1920, 1440, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: '手机', exact: true }).click();
    await expect(page.locator('.preview-panel')).toHaveCSS('width', '444px');
    await expect(page.locator('iframe')).toHaveCSS('width', '420px');
    await expect(body).toHaveCSS('padding-left', '16px');
    expect(await page.frameLocator('iframe').locator('article').innerHTML()).toBe(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '预览', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(body).toHaveCSS('padding-left', '16px');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '自适应', exact: true }).click();
  await expect(body).toHaveCSS('padding-left', '22px');
});
test('自适应与手机切换连贯过渡且可中途折返，减少动态效果时直接到位', async ({ page }) => {
  await page.goto('/format');
  await page.frameLocator('iframe').locator('article').waitFor();
  const running = () =>
    page.evaluate(() => document.querySelector('.workspace')!.getAnimations().length);
  const paperWidth = () =>
    page.evaluate(() => document.querySelector('.preview-paper')!.getBoundingClientRect().width);
  const wide = await paperWidth();
  await page.getByRole('button', { name: '手机', exact: true }).click();
  expect(await running()).toBeGreaterThan(0);
  // 过渡中途折返：从当前宽度继续，而不是跳回起点或终点。
  await page.getByRole('button', { name: '自适应', exact: true }).click();
  const turning = await paperWidth();
  expect(turning).toBeGreaterThan(420);
  expect(turning).toBeLessThanOrEqual(wide);
  await expect.poll(paperWidth).toBe(wide);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '手机', exact: true }).click();
  expect(await running()).toBe(0);
  await expect(page.locator('.preview-panel')).toHaveCSS('width', '444px');
});
test('老用户浏览器里原样未改的旧示例升级为新示例，排版设置保留', async ({ page }) => {
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  for (const markdown of legacySamples(origin)) {
    await page.evaluate((markdown) => {
      const fixed = {
        header: false,
        footer: false,
        headerStyle: '简约署名',
        footerStyle: '一句寄语',
        author: '',
        slogan: '',
        closing: '',
        collection: '',
      };
      localStorage.setItem(
        'jinzhang.document.v1',
        JSON.stringify({
          markdown,
          title: '把写作还给写作',
          theme: 'mac',
          platform: 'wechat',
          fixed: { wechat: fixed, zhihu: fixed },
        }),
      );
    }, markdown);
    await page.goto('/format');
    await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(/## 01 标题/);
    await expect(page.getByRole('button', { name: 'Mac', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.goto('/');
  }
});
test('新建保留设置与上一稿，刷新后恢复，取消不丢内容', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('需要保留的文章');
  await page.getByRole('button', { name: 'Mac', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '作者名', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '文章开头', exact: true }).check();
  await page.getByRole('textbox', { name: '作者名', exact: true }).fill('我的署名');
  await page.getByRole('checkbox', { name: '文章开头', exact: true }).uncheck();
  await expect(page.getByRole('textbox', { name: '作者名', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '文章开头', exact: true }).check();
  await expect(page.getByRole('textbox', { name: '作者名', exact: true })).toHaveValue('我的署名');
  await page.getByLabel('更多操作').click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toHaveValue('需要保留的文章');
  await page.getByLabel('更多操作').click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '新建文章', exact: true }).click();
  await expect(editor).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Mac', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('textbox', { name: '作者名', exact: true })).toHaveValue('我的署名');
  await page.getByLabel('更多操作').click();
  await page.getByRole('button', { name: '恢复上一稿', exact: true }).click();
  await expect(editor).toHaveValue('需要保留的文章');
});
test('长文双向同步、精确点击定位，手机编辑预览切换', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  const markdown = Array.from({ length: 50 }, (_, i) => `## 第 ${i + 1} 节\n\n重复正文。`).join(
    '\n\n',
  );
  await editor.fill(markdown);
  const preview = page.frameLocator('iframe');
  await expect(preview.locator('[data-source-line]')).not.toHaveCount(0);
  await editor.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await expect
    .poll(() => preview.locator('html').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1000);
  await page.waitForTimeout(100);
  await preview.locator('html').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => editor.evaluate((el) => el.scrollTop)).toBeLessThan(10);
  await preview.getByRole('heading', { name: '第 30 节', exact: true }).click();
  await expect(editor).toBeFocused();
  await expect
    .poll(() => editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart))
    .toBe(markdown.indexOf('## 第 30 节'));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  await expect(page.locator('iframe')).not.toBeVisible();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator('iframe')).toBeVisible();
  await preview.getByRole('heading', { name: '第 2 节', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect
    .poll(() => editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart))
    .toBe(markdown.indexOf('## 第 2 节'));
  await page.screenshot({ path: '/tmp/jinzhang-mobile-editor.png' });
});
test('图片处理期间继续打字，插入后光标与原生撤销重做正常', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as any).releaseImage = release;
    let first = true;
    window.createImageBitmap = (async (...args: any[]) => {
      if (first) {
        first = false;
        (window as any).imageWaiting = true;
        await waiting;
      }
      return (original as any)(...args);
    }) as typeof createImageBitmap;
  });
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('前文\n后文');
  await editor.press('Home');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '＋ 插入图片' }).click();
  await (await chooser).setFiles(fixture);
  await expect.poll(() => page.evaluate(() => (window as any).imageWaiting)).toBe(true);
  await editor.focus();
  await editor.press('ArrowUp');
  await editor.press('Home');
  await page.keyboard.insertText('新增前文\n');
  await page.evaluate(() => (window as any).releaseImage());
  await expect(editor).toHaveValue(/^新增前文\n前文\n\n!\[.*\]\(jz-local:.*\)\n后文$/);
  const inserted = await editor.inputValue();
  expect(await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
    inserted.length - 2,
  );
  await editor.press('ControlOrMeta+z');
  await expect(editor).toHaveValue('新增前文\n前文\n后文');
  await editor.press('ControlOrMeta+Shift+z');
  await expect(editor).toHaveValue(inserted);
});
test('拖图插入鼠标落点而不是旧光标位置', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('第一行\n第二行\n第三行\n第四行');
  await editor.press('ControlOrMeta+Home');
  const bytes = Array.from(await readFile(fixture));
  await editor.evaluate((el: HTMLTextAreaElement, bytes) => {
    const rect = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }));
    el.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.left + parseFloat(css.paddingLeft) + 1,
        clientY: rect.top + parseFloat(css.paddingTop) + parseFloat(css.lineHeight) * 2.5,
      }),
    );
  }, bytes);
  await expect(editor).toHaveValue(
    /^第一行\n第二行\n\n!\[drop.png\]\(jz-local:.*\)\n第三行\n第四行$/,
  );
});
test('光标插图即时上传，失败可重试，切平台与刷新复用图片', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await expect(editor).toHaveCSS('font-size', '16px');
  await expect(page.locator('.work-header')).toHaveCSS('height', '60px');
  await expect(page.getByRole('button', { name: '更换封面 ↗' })).toHaveCount(0);
  await editor.fill('前文\n后文');
  await editor.press('Home');
  let uploads = 0;
  await page.route('https://oss.example.test/upload', (route) => {
    uploads++;
    return route.fulfill({ status: uploads === 1 ? 500 : 201, body: '' });
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '＋ 插入图片' }).click();
  await (await chooser).setFiles(fixture);
  await expect(editor).toHaveValue(/^前文\n\n!\[.*\]\(jz-local:.*\)\n后文$/);
  await expect(page.getByRole('button', { name: '重试上传' })).toBeVisible();
  const articleWithImage = await editor.inputValue();
  await editor.fill('图片已删除');
  await expect(page.getByRole('button', { name: '重试上传' })).toHaveCount(0);
  await editor.fill(articleWithImage);
  await expect(page.getByRole('button', { name: '重试上传' })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '重试上传' }).click();
  await expect(page.getByRole('button', { name: '复制到公众号' })).toBeEnabled();
  await expect(page.frameLocator('iframe').locator('header img')).toHaveCount(0);
  await expect(page.frameLocator('iframe').getByText('未设置封面')).toHaveCount(0);
  await expect.poll(() => uploads).toBe(2);
  await page.getByRole('button', { name: '知乎', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '复制到知乎' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  expect(uploads).toBe(2);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('jinzhang-transit-cache') || '{}');
    for (const record of Object.values(saved) as { expires: number }[]) record.expires = 0;
    localStorage.setItem('jinzhang-transit-cache', JSON.stringify(saved));
  });
  await page.reload();
  await page.getByRole('button', { name: '复制到知乎' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  expect(uploads).toBe(3);
  await editor.click();
  await expect(editor).toHaveCSS('outline-style', 'none');
  await page.getByRole('textbox', { name: '文章标题' }).click();
  await expect(page.getByRole('textbox', { name: '文章标题' })).toHaveCSS('outline-style', 'none');
  expect(await page.locator('.preview-paper').evaluate((el) => el.clientWidth)).toBeGreaterThan(
    375,
  );
  await page.getByRole('button', { name: '手机', exact: true }).click();
  await expect(page.locator('.preview-paper')).toHaveCSS('width', '420px');
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/transit/sign', (route) =>
    route.fulfill({
      json: {
        url: 'https://oss.example.test/upload',
        fields: { key: 'image.png' },
        ticket: 'test',
      },
    }),
  );
  await page.route('https://oss.example.test/upload', (route) =>
    route.fulfill({ status: 201, body: '' }),
  );
  await page.route('**/api/transit/complete', (route) =>
    route.fulfill({ json: { url: 'https://oss.example.test/read?signature=test' } }),
  );
});
test('更多菜单按惯例关闭，后台上传不阻塞公众号或已删图的文章', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  const menu = page.locator('.workspace-menu');
  const trigger = menu.locator('summary');
  await trigger.click();
  await editor.click();
  await expect(menu).not.toHaveAttribute('open');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open');
  await expect(trigger).toBeFocused();

  let releaseUpload!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let uploadStarted = false;
  let uploadFinished = false;
  await page.route('https://oss.example.test/upload', async (route) => {
    uploadStarted = true;
    await waiting;
    await route.fulfill({ status: 500, body: '' });
    uploadFinished = true;
  });
  await editor.fill('正文');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '＋ 插入图片' }).click();
  await (await chooser).setFiles(fixture);
  await expect.poll(() => uploadStarted).toBe(true);
  await expect(page.getByText('正在上传 1 张图片…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  await editor.fill('已删图片的正文');
  await page.getByRole('button', { name: '知乎', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制到知乎' })).toBeEnabled();
  await expect(page.getByText('正在上传 1 张图片…', { exact: true })).toHaveCount(0);
  releaseUpload();
  await expect.poll(() => uploadFinished).toBe(true);
  await expect(page.getByRole('button', { name: '重试上传' })).toHaveCount(0);
});
test('标题提取忽略代码，示例替换保留两个平台的个人设置', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  const title = page.getByRole('textbox', { name: '文章标题' });
  await title.fill('保留的标题');
  await editor.fill('```sh\n# 代码注释\n```');
  await page.getByRole('button', { name: '用正文一级标题' }).click();
  await expect(page.getByRole('status')).toHaveText('没有找到正文一级标题。');
  await expect(title).toHaveValue('保留的标题');
  await editor.fill('```sh\n# 代码注释\n```\n\n# **真正**的标题');
  await page.getByRole('button', { name: '用正文一级标题' }).click();
  await expect(title).toHaveValue('真正的标题');
  await page.getByRole('button', { name: 'Mac', exact: true }).click();
  await page.getByRole('checkbox', { name: '文章开头', exact: true }).check();
  await page.getByRole('textbox', { name: '作者名', exact: true }).fill('公众号作者');
  await page.getByRole('button', { name: '知乎', exact: true }).click();
  await page.getByRole('checkbox', { name: '文章开头', exact: true }).check();
  await page.getByRole('textbox', { name: '作者名', exact: true }).fill('知乎作者');
  await page.getByText('···', { exact: true }).click();
  await page.getByRole('button', { name: '载入示例', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '载入示例', exact: true }).click();
  await expect(page.getByRole('button', { name: '知乎', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('textbox', { name: '作者名', exact: true })).toHaveValue('知乎作者');
  await expect(editor).toHaveValue(/把写作还给写作/);
  await page.getByRole('button', { name: '微信公众号', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mac', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('textbox', { name: '作者名', exact: true })).toHaveValue(
    '公众号作者',
  );
  await expect(page.getByRole('checkbox', { name: '文章开头', exact: true })).toBeChecked();
});
test('合集网址补全协议，无效输入就地反馈', async ({ page }) => {
  await page.goto('/format');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).fill('正文');
  await page.getByRole('checkbox', { name: '文章结尾', exact: true }).check();
  const link = page.getByRole('textbox', { name: '合集链接' });
  await link.fill('javascript:alert(1)');
  await link.press('Tab');
  await expect(page.locator('#collection-error')).toHaveText('请输入有效的网页地址');
  await expect(link).toHaveAttribute('aria-invalid', 'true');
  await link.fill('example.com/collection');
  await link.press('Tab');
  await expect(page.locator('#collection-error')).toHaveCount(0);
  await expect(page.frameLocator('iframe').getByRole('link', { name: '继续阅读' })).toHaveAttribute(
    'href',
    'https://example.com/collection',
  );
});
test('补图、刷新恢复、真实富文本复制到两个平台、封面不进入正文', async ({ page }) => {
  await page.goto('/format');
  await page
    .getByRole('textbox', { name: 'Markdown 原文' })
    .fill('# 测试文章\n\n正文保留。\n\n![插图](./one/a.png)');
  await page.getByRole('button', { name: '用正文一级标题' }).click();
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(page.getByRole('button', { name: '请先补齐图片' })).toBeVisible();
  await expect(page.getByRole('button', { name: '补图', exact: true })).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '补图', exact: true }).click();
  await (await chooser).setFiles(fixture);
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(/jz-local:\/\//);
  await expect(page.getByRole('button', { name: '复制到公众号' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(/jz-local:\/\//);
  await expect(
    page.frameLocator('iframe').getByRole('img', { name: '插图', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  const html = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return (await items[0].getType('text/html')).text();
  });
  expect(html).toContain('data:image/');
  expect(html).toContain('正文保留');
  expect(html).not.toContain('文章封面');
  expect(html).not.toContain('测试文章');
  await page.getByRole('button', { name: '知乎', exact: true }).click();
  let uploads = 0;
  await page.route('**/api/transit/sign', (route) =>
    route.fulfill({
      json: {
        url: 'https://oss.example.test/upload',
        fields: { key: 'image.png' },
        ticket: 'test-ticket',
      },
    }),
  );
  await page.route('https://oss.example.test/upload', (route) => {
    uploads++;
    return route.fulfill({ status: 201, body: '' });
  });
  await page.route('**/api/transit/complete', (route) =>
    route.fulfill({ json: { url: 'https://oss.example.test/read?signature=test' } }),
  );
  await page.getByRole('button', { name: '复制到知乎' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  expect(uploads).toBe(0);
  const zhihu = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return (await items[0].getType('text/html')).text();
  });
  expect(zhihu).toContain('https://oss.example.test/read?signature=test');
  expect(zhihu).not.toContain('style=');
});
test('两平台预览、移动布局和清除只作用于当前站点数据', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /让文字，.*锦绣成章/ })).toBeVisible();
  await page.getByRole('link', { name: '打开在线排版' }).click();
  // 首次打开即预置覆盖常见语法的示例稿，成品立刻可见。
  const article = page.frameLocator('iframe').locator('article');
  await expect(article.getByRole('heading', { name: '01 标题' })).toBeVisible();
  for (const selector of [
    'strong',
    'em',
    'del',
    'code',
    'a',
    'blockquote',
    'ul',
    'ol',
    'pre',
    'table',
    'img',
    'hr',
    'sup',
  ])
    await expect(article.locator(selector).first()).toBeAttached();
  await expect(article.locator('img')).toHaveJSProperty('complete', true);
  expect(
    await article.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Mac', exact: true }).click();
  await expect(page.frameLocator('iframe').locator('pre').first()).toHaveCSS(
    'background-color',
    'rgb(40, 45, 53)',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '排版设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭设置 ×' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '关闭设置 ×' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '排版设置', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '排版设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置 ×' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdown 原文' }).fill('只存在本浏览器的草稿');
  await page.getByText('···', { exact: true }).click();
  await page.getByRole('button', { name: '清除本地数据', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '清除本地数据', exact: true }).click();
  // 清除后回到首次打开的状态：草稿不再保留，刷新前后都是示例稿。
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(
    /^# 把写作还给写作/,
  );
  expect(await page.evaluate(() => localStorage.getItem('jinzhang.document.v1'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(
    /^# 把写作还给写作/,
  );
});

test('剪贴板权限失败后复用已上传图片，重试不会重复上传', async ({ page }) => {
  await page.goto('/format');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).fill('正文');
  let uploads = 0;
  await page.route('**/api/transit/sign', (route) =>
    route.fulfill({
      json: { url: 'https://oss.example.test/upload', fields: { key: 'x' }, ticket: 'ticket' },
    }),
  );
  await page.route('https://oss.example.test/upload', (route) => {
    uploads++;
    return route.fulfill({ status: 201, body: '' });
  });
  await page.route('**/api/transit/complete', (route) =>
    route.fulfill({ json: { url: 'https://oss.example.test/read' } }),
  );
  await page.locator('input[type=file]').setInputFiles([fixture, fixture]);
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(/jz-local/);
  await page.getByRole('button', { name: '知乎', exact: true }).click();
  await page.evaluate(() => {
    const original = navigator.clipboard.write.bind(navigator.clipboard);
    let calls = 0;
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: (data: ClipboardItems) =>
        ++calls === 1
          ? Promise.reject(new DOMException('Denied', 'NotAllowedError'))
          : original(data),
    });
  });
  await page.getByRole('button', { name: '复制到知乎' }).click();
  await expect(
    page.getByText('浏览器未允许写入剪贴板，请重试或手动复制。', { exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  await page.getByRole('button', { name: '重试复制', exact: true }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  expect(uploads).toBe(1);
});
test('快速改稿不显示旧稿，脚本不执行，手动复制不含标题封面', async ({ page }) => {
  await page.goto('/format');
  const input = page.getByRole('textbox', { name: 'Markdown 原文' });
  await input.fill('# 旧稿');
  await input.fill(
    '# 最新稿\n\n<script>parent.__unsafe=true</script>\n\n正文 <img src="x" onerror="parent.__unsafe=true">',
  );
  await expect(page.frameLocator('iframe').getByRole('heading', { name: '最新稿' })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__unsafe'))).toBeUndefined();
  await input.fill('可以手动复制的正文');
  await page.getByRole('textbox', { name: '文章标题' }).fill('不要复制这个标题');
  await page.evaluate(() =>
    Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: undefined }),
  );
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(
    page.getByText('浏览器不支持富文本剪贴板，请全选预览正文复制。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '手动复制' }).click();
  await expect
    .poll(() =>
      page
        .frameLocator('iframe')
        .locator('article')
        .evaluate(() => window.getSelection()?.toString()),
    )
    .toBe('可以手动复制的正文');
  await expect(page.frameLocator('iframe').locator('[data-source-line]')).toHaveCount(0);
});

test('粘贴 SVG 可栅格化，复制体积使用实际载荷', async ({ page }) => {
  await page.goto('/format');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).fill('图片测试');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).evaluate((el) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#ac493a"/></svg>';
    const dt = new DataTransfer();
    dt.items.add(new File([svg], 'vector.svg', { type: 'image/svg+xml' }));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
  });
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue(/jz-local/);
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const size = await page.evaluate(
    async () => (await (await navigator.clipboard.read())[0].getType('text/html')).size,
  );
  expect(size).toBeGreaterThan(100);
});

test('插图立即上传，编辑不被阻塞，远程图片失败有轻提示', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('旧稿');
  let uploaded = 0;
  await page.route('https://oss.example.test/upload', async (route) => {
    uploaded++;
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ status: 201, body: '' });
  });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(editor).toHaveValue(/jz-local/);
  await expect.poll(() => uploaded).toBe(1);
  await editor.fill('新稿');
  await expect(page.frameLocator('iframe').locator('article')).toContainText('新稿');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.route('https://remote.example.test/image.png', (route) => route.abort());
  await editor.fill('![远程](https://remote.example.test/image.png)');
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
  await expect(page.locator('.toast')).toContainText('远程图片未能处理');
});
test('损坏的本地数据不会被页面加载静默覆盖', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('jinzhang.document.v1', '{broken-json'));
  await page.goto('/format');
  await expect(page.getByRole('status')).toContainText('本地存储不可用');
  expect(await page.evaluate(() => localStorage.getItem('jinzhang.document.v1'))).toBe(
    '{broken-json',
  );
});

test('十张透明图片形成约 5 MB 富文本载荷，Chrome 剪贴板保留全部图片', async ({ page }) => {
  await page.goto('/format');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).fill('大体积图片测试');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).evaluate(async (el) => {
    const dt = new DataTransfer();
    for (let i = 0; i < 10; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 350;
      canvas.height = 350;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(350, 350);
      for (let offset = 0; offset < pixels.data.length; offset += 65536)
        crypto.getRandomValues(
          pixels.data.subarray(offset, Math.min(offset + 65536, pixels.data.length)),
        );
      for (let alpha = 3; alpha < pixels.data.length; alpha += 4) pixels.data[alpha] = 128;
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png'),
      );
      dt.items.add(new File([blob], `large-${i}.png`, { type: 'image/png' }));
    }
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
  });
  await expect
    .poll(
      async () =>
        (
          (await page.getByRole('textbox', { name: 'Markdown 原文' }).inputValue()).match(
            /jz-local:/g,
          ) || []
        ).length,
    )
    .toBe(10);
  await page.getByRole('button', { name: '复制到公众号' }).click();
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible({ timeout: 25_000 });
  const payload = await page.evaluate(async () => {
    const data = await navigator.clipboard.read();
    const blob = await data[0].getType('text/html');
    const html = await blob.text();
    return { size: blob.size, count: (html.match(/data:image\/png;base64/g) || []).length };
  });
  console.log('large clipboard payload', payload);
  expect(payload.count).toBe(10);
  expect(payload.size).toBeGreaterThan(4 * 1024 * 1024);
  expect(payload.size).toBeLessThan(8 * 1024 * 1024);
});

test('旧复制任务晚失败不能覆盖新任务进度', async ({ page }) => {
  await page.goto('/format');
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: () => {
        const call = ++calls;
        return new Promise<void>((resolve, reject) => {
          window.addEventListener(
            `finish-copy-${call}`,
            () => {
              if (call === 1) reject(new DOMException('Denied', 'NotAllowedError'));
              else resolve();
            },
            { once: true },
          );
        });
      },
    });
  });
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  const copy = page.getByRole('button', { name: '复制到公众号' });
  await editor.fill('旧稿');
  await copy.click();
  await editor.fill('新稿');
  await expect(page.frameLocator('iframe').locator('article')).toContainText('新稿');
  await copy.click();
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('finish-copy-1'));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page.getByRole('button', { name: '正在复制…' })).toBeDisabled();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('finish-copy-2')));
  await expect(page.getByRole('button', { name: '已复制 ✓' })).toBeVisible();
});

test('编辑保留上一帧，复制等待最新版本，短视口没有整页溢出', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('原来的正文');
  await expect(page.frameLocator('iframe').locator('body')).toContainText('原来的正文');
  await editor.fill('最新正文');
  // 防抖期间按钮保持可用，点击等待最新排版结果。
  expect(await page.getByRole('button', { name: '复制到公众号', exact: true }).isDisabled()).toBe(
    false,
  );
  await expect(page.locator('iframe')).toBeVisible();
  await page.getByRole('button', { name: '复制到公众号', exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => navigator.clipboard.readText()))
    .toContain('最新正文');
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await expect(page.getByRole('button', { name: '手机', exact: true })).toBeHidden();
});
test('弹窗内部留白不关闭，背景点击仍可关闭', async ({ page }) => {
  await page.goto('/format');
  await page.getByRole('textbox', { name: 'Markdown 原文' }).fill('保留正文');
  await page.getByLabel('更多操作').click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.click({ position: { x: 6, y: 6 } });
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Markdown 原文' })).toHaveValue('保留正文');
});
test('拖图到预览区域在原文光标插入，不导航离开编辑器', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('原文');
  await editor.press('End');
  const bytes = [...(await readFile(fixture))];
  await page.locator('.preview-panel').evaluate((el, bytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(bytes)], 'outer.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, bytes);
  await expect(editor).toHaveValue(/原文\n!\[outer.png\]\(jz-local:/);
  await expect(page).toHaveURL(/\/format$/);
  await expect(page.frameLocator('iframe').locator('img')).toBeVisible();
  await page
    .frameLocator('iframe')
    .locator('body')
    .evaluate((el, bytes) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array(bytes)], 'frame.png', { type: 'image/png' }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    }, bytes);
  await expect(editor).toHaveValue(/frame.png/);
  await expect(page.frameLocator('iframe').locator('img')).toHaveCount(2);
});

test('复制反馈保持尺寸，首页手机入口与图标可用', async ({ page }, testInfo) => {
  await page.goto('/format');
  await page
    .getByRole('textbox', { name: 'Markdown 原文' })
    .fill('## 排版核对\n\n这是正文，用于核对编辑器和预览的布局。\n\n- 列表一\n- 列表二');
  const button = page.getByRole('button', { name: '复制到公众号', exact: true });
  await expect(button).toBeEnabled();
  const before = await button.boundingBox();
  const workspace = await page.locator('.workspace').boundingBox();
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')),
    }),
  );
  await button.click();
  await expect(
    page.getByText('浏览器未允许写入剪贴板，请重试或手动复制。', { exact: true }),
  ).toBeVisible();
  expect(await page.locator('.workspace').boundingBox()).toEqual(workspace);
  expect((await button.boundingBox())?.width).toBe(before?.width);
  await page.getByRole('button', { name: '关闭复制提示' }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop.png') });
  await page.getByRole('button', { name: '手机', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('phone-preview.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('mobile.png') });
  await page.goto('/');
  await expect(page.getByRole('link', { name: '开始排版 ↗', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const icon = await page.locator('link[rel="icon"]').first().getAttribute('href');
  expect((await page.request.get(icon!)).ok()).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('home-mobile.png') });
});
test('被忽略或清理的原文内容在编辑区底部提示，修正后提示消失', async ({ page }) => {
  await page.goto('/format');
  const editor = page.getByRole('textbox', { name: 'Markdown 原文' });
  await editor.fill('---\n注意: 这是重点\n---\n\n正文内容\n\n<script>alert(1)</script>');
  const warnings = page.locator('.input-warnings');
  await expect(warnings).toContainText('已忽略 frontmatter');
  await expect(warnings).toContainText('已清理不支持或不安全的 HTML');
  await expect(page.frameLocator('iframe').locator('article')).toContainText('正文内容');
  await editor.fill('正文内容');
  await expect(warnings).toHaveCount(0);
});
