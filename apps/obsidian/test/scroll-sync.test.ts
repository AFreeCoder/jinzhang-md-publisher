import { describe, expect, it } from 'vitest';
import { buildAnchors, headingKey, scrollTarget, sourceOutline } from '../src/scroll-sync';
describe('headingKey', () => {
  it('源码标题与渲染后的文字对得上', () => {
    expect(headingKey('一、常见的**部署**方案有哪些?')).toBe(
      headingKey('一、常见的部署方案有哪些？'),
    );
    expect(headingKey('1.1 [链接](https://x.com) 与 `code`')).toBe(headingKey('1.1 链接 与 code'));
    expect(headingKey('看 [[笔记名|别名]] 和 [[另一篇]]')).toBe(headingKey('看 别名 和 另一篇'));
  });
});
describe('sourceOutline', () => {
  it('跳过属性区与代码块，标签不算标题', () => {
    const text = [
      '---',
      '# yaml 注释',
      '---',
      '## 第一节',
      '#标签',
      '```md',
      '## 代码里的',
      '```',
      '### 第二节 ##',
      '~~~~',
      '# 也在代码里',
      '~~~',
      '~~~~',
      '#### 第三节',
    ].join('\n');
    const outline = sourceOutline(text, text.indexOf('## 第一节'));
    expect(outline.first).toBe(3);
    expect(outline.last).toBe(13);
    expect(outline.headings).toEqual([
      { line: 3, key: '第一节' },
      { line: 8, key: '第二节' },
      { line: 13, key: '第三节' },
    ]);
  });
});
describe('buildAnchors 与 scrollTarget', () => {
  const outline = {
    first: 2,
    last: 100,
    headings: [
      { line: 10, key: 'a' },
      { line: 20, key: '只在源码里' },
      { line: 40, key: 'b' },
      { line: 60, key: 'a' },
    ],
  };
  it('按顺序匹配，对不上的跳过，重名标题对到下一个', () => {
    const targets = [
      { key: '开头样式里的', y: 50 },
      { key: 'a', y: 300 },
      { key: 'b', y: 900 },
      { key: 'a', y: 1500 },
    ];
    expect(buildAnchors(outline, targets, 2000)).toEqual([
      { line: 2, y: 0 },
      { line: 10, y: 300 },
      { line: 40, y: 900 },
      { line: 60, y: 1500 },
      { line: 100, y: 2000 },
    ]);
  });
  it('预览滚不到的标题位置截到最大值，保持单调', () => {
    const targets = [
      { key: 'a', y: 300 },
      { key: 'b', y: 2500 },
      { key: 'a', y: 2600 },
    ];
    expect(buildAnchors(outline, targets, 2000)).toEqual([
      { line: 2, y: 0 },
      { line: 10, y: 300 },
      { line: 40, y: 2000 },
      { line: 60, y: 2000 },
      { line: 100, y: 2000 },
    ]);
  });
  it('锚点之间线性插值，两端截住', () => {
    const anchors = [
      { line: 2, y: 0 },
      { line: 10, y: 300 },
      { line: 40, y: 900 },
      { line: 100, y: 2000 },
    ];
    expect(scrollTarget(0, anchors)).toBe(0);
    expect(scrollTarget(6, anchors)).toBe(150);
    expect(scrollTarget(10, anchors)).toBe(300);
    expect(scrollTarget(25, anchors)).toBe(600);
    expect(scrollTarget(120, anchors)).toBe(2000);
  });
  it('没有标题时按比例', () => {
    const anchors = buildAnchors({ first: 0, last: 100, headings: [] }, [], 1000);
    expect(scrollTarget(50, anchors)).toBe(500);
  });
});
