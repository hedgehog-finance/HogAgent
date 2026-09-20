/** Real browser + loopback download server; all documents and sessions are temporary. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const out = mkdtempSync(join(tmpdir(), 'hogagent-markdown-preview-'));
const runtime = join(out, 'runtime');
process.env.HOGAGENT_USER_DIR = join(runtime, 'system');
const { startWebServer } = await import('../../dist/src/web/server.js');
const { FileDelivery } = await import('../../dist/src/artifacts/file-delivery.js');
const { startArtifactRun } = await import('../../dist/src/artifacts/artifact-protocol.js');
const { getSessionsDir } = await import('../../dist/src/config.js');
const workspaceDir = join(runtime, 'workspace');
const sessionTaskDir = join(workspaceDir, 'tasks', 'preview-session');
mkdirSync(sessionTaskDir, { recursive: true });
const markdown = String.raw`# 季度经营报告

本报告为预览回归样例，用于核对文字、公式、表格和图表的阅读效果。

## 经营概览

| 指标 | 本期 | 上期 |
| --- | ---: | ---: |
| 收入 | 128.4 亿元 | 112.3 亿元 |
| 利润率 | $\frac{34.6}{128.4} \times 100\%$ | 25.3% |

行内公式 $E = mc^2$ 与 \(a^2 + b^2 = c^2\) 均应排版。

$$
\mathrm{NPV} = \sum_{t=1}^{n} \frac{CF_t}{(1+r)^t} - I_0
$$

收入 - 成本 = 128.4 - 93.8 = 34.6

## 趋势图

{图1}

## 插图

![内嵌示意图](chart.png)

{图2}

## 代码保持原样

~~~js
const formula = '$x^2$'; // {图1}
~~~

[图表数据]
- {图1}: {"chart":"line","option":{"backgroundColor":"#FFFFFF","title":{"text":"季度收入与利润","link":"javascript:alert(1)"},"tooltip":{"trigger":"axis","formatter":function(p){return '<script>bad</script>'; }},"legend":{"top":32},"grid":{"top":85,"bottom":40,"left":55,"right":30},"xAxis":{"type":"category","data":["Q1","Q2","Q3","Q4"]},"yAxis":{"type":"value"},"series":[{"name":"收入","type":"bar","data":[80,96,112,128]},{"name":"利润","type":"line","data":[12,18,26,34]}]}} 季度收入与利润
- {图2}: {"url":"chart.png"} 图片图表

[参考资料]
这是保留在图表数据之后的参考说明。
`;
writeFileSync(join(sessionTaskDir, 'report.md'), markdown);
writeFileSync(join(sessionTaskDir, 'chart.png'), readFileSync(new URL('../../src/web/public/logo.png', import.meta.url)));
writeFileSync(join(sessionTaskDir, 'data.json'), '{}');
const config = { workspaceDir, sessionTaskDir, sessionId: 'preview-session' };
startArtifactRun(config, 'preview-run');
const delivered = await new FileDelivery({ getConfig: () => config }).prepare([
  { path: 'tasks/preview-session/report.md' }, { path: 'tasks/preview-session/data.json' },
], 'explicit');
assert.deepEqual(delivered.errors, []);
mkdirSync(getSessionsDir(), { recursive: true });
writeFileSync(join(getSessionsDir(), 'preview-session.jsonl'), JSON.stringify({ type: 'custom', customType: 'hogagent.file-delivery', data: delivered }) + '\n');
const mock = join(runtime, 'agent.mjs'); writeFileSync(mock, 'process.stdin.resume();');
const server = await startWebServer({ port: 0, defaultWorkspace: workspaceDir, hogagentPath: mock });
const browser = await chromium.launch({ executablePath: process.env.HOGAGENT_BROWSER_EXECUTABLE || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.WebSocket = class { static OPEN = 1; readyState = 1; constructor() { setTimeout(() => this.onopen?.(), 0); } send() {} close() {} };
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => document.querySelector('#lang-selector').options.length > 0);
  await page.evaluate(async () => { await userInitialization; await changeLanguage('zh-CN'); });
  await page.evaluate(files => handleRpcEvent({ type: 'session_switched', session_id: 'preview-session', messages: [], files }), delivered.files);
  assert.equal(await page.locator('.delivery-markdown-preview').count(), 1);
  assert.equal(await page.locator('.delivery-markdown-preview').evaluate(el => el.nextElementSibling.classList.contains('delivery-download')), true);
  await page.locator('.delivery-markdown-preview').click();
  const modal = page.locator('#markdown-preview-modal');
  const body = modal.locator('.markdown-preview-body');
  await page.waitForFunction(() => document.querySelector('.markdown-preview-body').getAttribute('aria-busy') === 'false');
  assert.equal(await body.locator('table').count(), 1);
  assert.ok(await body.locator('.katex').count() >= 4);
  assert.equal(await body.locator('pre code').textContent(), "const formula = '$x^2$'; // {图1}\n");
  assert.equal(await body.locator('.md-chart canvas').count(), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.markdown-preview-body img')].length === 2 && [...document.querySelectorAll('.markdown-preview-body img')].every(img => img.naturalWidth > 0));
  assert.equal(await body.locator('.md-chart-index li').count(), 2);
  assert.ok(!(await body.textContent()).includes('"series"'));
  assert.ok(!(await body.textContent()).includes('function(p)'));
  assert.ok((await body.textContent()).includes('这是保留在图表数据之后的参考说明'));
  assert.deepEqual(await body.locator('table').evaluate(table => ({
    top: getComputedStyle(table).borderTopWidth, bottom: getComputedStyle(table).borderBottomWidth,
    header: getComputedStyle(table.tHead).borderBottomWidth, cell: getComputedStyle(table.tBodies[0].rows[0].cells[0]).borderBottomWidth,
  })), { top: '2px', bottom: '2px', header: '1px', cell: '0px' });
  for (const theme of ['fintech', 'bloomberg']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(async () => {
      const echarts = await import('/preview-vendor/echarts.js');
      const chart = echarts.getInstanceByDom(document.querySelector('.md-chart'));
      return chart?.getOption().textStyle.color === getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();
    });
    assert.equal(await body.evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--bg-primary').trim().toLowerCase() === '#09090b' ? 'rgb(9, 9, 11)' : 'rgb(255, 255, 255)'));
    await body.evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: join(out, `${theme}.png`) });
  }
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await modal.locator('.modal').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    assert.equal(await body.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.screenshot({ path: join(out, `mobile-${width}.png`) });
  }
  await page.keyboard.press('Escape');
  assert.equal(await modal.isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('delivery-markdown-preview')), true);
  assert.equal(await body.locator('canvas, img').count(), 0);
  await page.locator('.delivery-markdown-preview').click();
  await page.waitForFunction(() => document.querySelector('.markdown-preview-body').getAttribute('aria-busy') === 'false');
  await modal.locator('.markdown-preview-close').click();

  // Untrusted HTML, math and chart payloads remain presentation data.
  const interceptedDocument = '**/api/download?**';
  await page.route(interceptedDocument, route => route.fulfill({ contentType: 'text/markdown', body: String.raw`# 安全样例

<script>window.previewXss = true</script>
<iframe srcdoc="<script>parent.previewXss = true</script>"></iframe>
<a href="javascript:window.previewXss=true" onclick="window.previewXss=true">不可信链接</a>

~~~math
\frac{1}{2} = 0.5
~~~

~~~echarts
{"xAxis":{"data":["A","B"]},"yAxis":{},"series":[{"type":"bar","data":[1,2]}]}
~~~

{图1}

[图表数据]
{图1}: {broken JSON
` }));
  await page.locator('.delivery-markdown-preview').click();
  await page.waitForFunction(() => document.querySelector('.markdown-preview-body').getAttribute('aria-busy') === 'false');
  assert.equal(await body.locator('script, iframe, [onclick], a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.previewXss), undefined);
  assert.equal(await body.locator('.katex').count(), 1);
  assert.equal(await body.locator('.md-chart canvas').count(), 1);
  assert.ok(!(await body.textContent()).includes('broken JSON'));
  await modal.locator('.markdown-preview-close').click();
  await page.unroute(interceptedDocument);

  await page.route(interceptedDocument, route => route.fulfill({ contentType: 'text/markdown', body: 'x'.repeat(2 * 1024 * 1024 + 1) }));
  await page.locator('.delivery-markdown-preview').click();
  await body.getByText('文档超过 2 MiB 预览上限，请下载后查看完整文件。').waitFor();
  await modal.locator('.markdown-preview-close').click();
  await page.unroute(interceptedDocument);

  let releaseRequest;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  await page.route(interceptedDocument, async route => {
    await new Promise(resolve => { releaseRequest = resolve; requestStarted(); });
    await route.fulfill({ contentType: 'text/markdown', body: '# 过期请求内容' }).catch(() => {});
  });
  await page.locator('.delivery-markdown-preview').click();
  await started;
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.delivery-markdown-preview').hasAttribute('aria-busy'));
  releaseRequest();
  await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await body.textContent(), '');
  await page.locator('.delivery-markdown-preview').click();
  await body.getByRole('heading', { name: '季度经营报告' }).waitFor();
  assert.ok(!(await body.textContent()).includes('过期请求内容'));
  await modal.locator('.markdown-preview-close').click();

  assert.equal(readFileSync(join(sessionTaskDir, 'report.md'), 'utf8'), markdown);
  writeFileSync(join(sessionTaskDir, 'report.md'), 'changed');
  await page.locator('.delivery-markdown-preview').click();
  await body.getByText('文件已更新，请重新交付后预览。').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', themes: 2, viewports: 3, screenshots: out }));
} finally { await browser.close(); await server.shutdown(); rmSync(runtime, { recursive: true, force: true }); }
