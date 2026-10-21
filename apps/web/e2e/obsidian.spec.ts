import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
// 安装包由 pnpm build（scripts/pack-obsidian.mjs）生成，跑这组测试前要先构建过一次。
const { version } = JSON.parse(readFileSync('apps/obsidian/manifest.json', 'utf8'));
const zip = `/downloads/jinzhang-obsidian-${version}.zip`;

test('首页插件卡片直接下载与 manifest 同版本的安装包，并链到教程页', async ({ page, request }) => {
  await page.goto('/');
  const card = page.locator('.entry', { hasText: '留在 Obsidian 里' });
  await expect(card.getByText(`v${version}`)).toBeVisible();
  const download = card.getByRole('link', { name: /下载 Obsidian 插件/ });
  await expect(download).toHaveAttribute('href', zip);
  const response = await request.get(zip);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/zip');
  const body = await response.body();
  expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  for (const name of ['jinzhang/main.js', 'jinzhang/manifest.json', 'jinzhang/styles.css'])
    expect(body.includes(Buffer.from(name))).toBe(true);
  await card.getByRole('link', { name: /安装与使用教程/ }).click();
  await expect(page).toHaveURL(/\/obsidian$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('写完就发');
});

test('教程页的下载、目录锚点可用，手机宽度不横向溢出', async ({ page }) => {
  await page.goto('/obsidian');
  await expect(page.getByRole('link', { name: `下载插件 v${version}` })).toHaveAttribute(
    'href',
    zip,
  );
  const toc = page.getByRole('navigation', { name: '目录' });
  const ids = await toc
    .getByRole('link')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href')!.slice(1)));
  expect(ids.length).toBeGreaterThan(5);
  for (const id of ids) await expect(page.locator(`section#${id} h2`)).toHaveCount(1);
  await toc.getByRole('link', { name: /常见问题/ }).click();
  await expect(page.locator('#faq h2')).toBeInViewport();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
