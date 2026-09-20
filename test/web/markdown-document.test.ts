import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chartImageUrl, extractMarkdownChartSection } from '../../src/web/markdown-document.ts';
import { resolveMarkdownImage } from '../../src/web/markdown-resources.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Markdown preview document contract', () => {
  it('extracts multiline chart JSON while retaining descriptions and later footnotes', () => {
    const document = extractMarkdownChartSection('正文 {图1}\n\n[图表数据]\n- {图1}: {\n"option":{"series":[{"type":"line","data":[1,2]}]}\n} 收入变化\n- {图2}: {"url":"images/chart.png"} 估值图\n\n[参考资料]\n原文链接');
    expect(document.body).toContain('正文 {图1}');
    expect(document.body).toContain('[参考资料]\n原文链接');
    expect(document.body).not.toContain('series');
    expect(document.charts.map(chart => chart.description)).toEqual(['收入变化', '估值图']);
    expect(chartImageUrl(document.charts[1].json)).toBe('images/chart.png');
  });

  it('keeps code examples intact and hides malformed footnote payloads', () => {
    const source = '```md\n[图表数据]\n{图1}: {"example":true}\n```\n正文\n[图表数据]\n{图2}: {broken JSON\n';
    const result = extractMarkdownChartSection(source);
    expect(result.body).toContain('{"example":true}');
    expect(result.body).not.toContain('broken JSON');
    expect(result.charts).toEqual([{ id: '{图2}', json: '', description: '' }]);
  });

  it('bounds JSON with strings and legacy formatter functions without executing it', () => {
    const result = extractMarkdownChartSection('[图表数据]\n{图1}: {"option":{"tooltip":{"formatter":function(){ /* } */ return "}"; }},"series":[]}} 描述');
    expect(result.charts[0].description).toBe('描述');
    expect(result.charts[0].json).toContain('function()');
  });

  it('allows only referenced images in the document root, including reference-style and chart images', () => {
    const root = mkdtempSync(join(tmpdir(), 'hog-md-resources-')); roots.push(root);
    const task = join(root, 'task'); mkdirSync(join(task, 'docs'), { recursive: true });
    mkdirSync(join(task, '.hedgehog'));
    const doc = join(task, 'docs/report.md');
    writeFileSync(join(task, 'chart.png'), 'image');
    writeFileSync(join(task, 'other.png'), 'other');
    writeFileSync(join(root, 'outside.png'), 'outside');
    writeFileSync(join(task, '.hedgehog/private.png'), 'private');
    symlinkSync(join(root, 'outside.png'), join(task, 'escape.png'));
    writeFileSync(doc, [
      '![正常][chart]', '[chart]: ../chart.png',
      '![越界](../../outside.png)', '![别名](../escape.png)', '![内部](../.hedgehog/private.png)',
      '![网络](https://example.test/a.png)', '![文档](report.md)',
      '[图表数据]', '{图1}: {"url":"../chart.png"} 图表',
    ].join('\n\n'));
    expect(resolveMarkdownImage(doc, task, '../chart.png')).toBe(realpathSync(join(task, 'chart.png')));
    for (const path of ['../other.png', '../../outside.png', '../escape.png', '../.hedgehog/private.png', 'https://example.test/a.png', 'report.md']) {
      expect(resolveMarkdownImage(doc, task, path)).toBeNull();
    }
  });
});
