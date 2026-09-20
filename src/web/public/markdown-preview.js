import { marked, Renderer } from './preview-vendor/marked.js';
import DOMPurify from './preview-vendor/purify.js';
import katex from './preview-vendor/katex/katex.mjs';
import * as echarts from './preview-vendor/echarts.js';
import { parseBriefingChartData } from './preview-vendor/chart-data.js';
import { extractMarkdownChartSection, chartImageUrl } from './preview-vendor/markdown-document.js';

const mathStyles = document.createElement('link');
mathStyles.rel = 'stylesheet';
mathStyles.href = new URL('./preview-vendor/katex/katex.min.css', import.meta.url).href;
document.head.appendChild(mathStyles);

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const mathHtml = (text, display) => `<span class="md-math" data-display="${display}">${escapeHtml(text)}</span>`;
const renderer = new Renderer();

// Math is tokenized before Markdown can consume LaTeX escapes, underscores or pipes.
marked.use({
  gfm: true, headerIds: false, mangle: false,
  extensions: [
    {
      name: 'previewBlockMath', level: 'block',
      start: src => src.search(/\$\$|\\\[|\\begin\{(?:equation|align)\*?\}/),
      tokenizer(src) {
        const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(\\begin\{(equation\*?|align\*?)\}[\s\S]+?\\end\{\4\}))(?:\s*\n|$)/.exec(src);
        if (match) return { type: 'previewBlockMath', raw: match[0], text: match[1] || match[2] || match[3] };
        const calculation = /^([\p{L}\d_.,%() +*/^×÷−=＝-]+)(?:\n|$)/u.exec(src);
        if (calculation && /[=＝]/.test(calculation[1]) && /[\d+*/^×÷−-]/.test(calculation[1])) {
          const text = calculation[1].replace(/[\u3400-\u9fff]+/g, word => `\\text{${word}}`)
            .replace(/%/g, '\\%').replace(/×/g, '\\times ').replace(/÷/g, '\\div ').replace(/＝/g, '=').replace(/−/g, '-');
          return { type: 'previewBlockMath', raw: calculation[0], text };
        }
      },
      renderer: token => `<div class="md-equation">${mathHtml(token.text, true)}</div>`,
    },
    {
      name: 'previewInlineMath', level: 'inline',
      start: src => src.search(/\$|\\\(/),
      tokenizer(src) {
        const match = /^(?:\\\((.+?)\\\)|(?<![\\$])\$(?!\$|\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d))/.exec(src);
        if (match) return { type: 'previewInlineMath', raw: match[0], text: match[1] || match[2] };
      },
      renderer: token => mathHtml(token.text, false),
    },
  ],
  renderer: {
    code(code, language, escaped) {
      if (/^(math|latex|tex)$/i.test(language || '')) return `<div class="md-equation">${mathHtml(code, true)}</div>`;
      if (/^echarts$/i.test(language || '')) return `<pre class="md-chart-source">${escapeHtml(code)}</pre>`;
      return renderer.code(code, language, escaped);
    },
  },
});

function themeOptions(option) {
  const style = getComputedStyle(document.documentElement);
  const color = name => style.getPropertyValue(name).trim();
  // Report-supplied colors must not override the reader's selected theme.
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return typeof value === 'string' && value.startsWith('image://') ? undefined : value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(^color$|Color$|^fontFamily$|^link$|^sublink$|^formatter$|^graphic$|^toolbox$|^__proto__$|^constructor$|^prototype$)/.test(key))
      .map(([key, item]) => [key, clean(item)]));
  };
  const text = color('--text-primary'), muted = color('--text-secondary'), border = color('--border');
  const theme = {
    color: [color('--primary'), color('--success'), color('--warning'), color('--error'), color('--text-muted')],
    backgroundColor: 'transparent', textStyle: { color: text, fontFamily: style.fontFamily },
    title: { textStyle: { color: text }, subtextStyle: { color: muted } },
    legend: { textStyle: { color: muted } },
    categoryAxis: { axisLabel: { color: muted }, nameTextStyle: { color: muted }, axisLine: { lineStyle: { color: border } }, splitLine: { lineStyle: { color: border } } },
    valueAxis: { axisLabel: { color: muted }, nameTextStyle: { color: muted }, axisLine: { lineStyle: { color: border } }, splitLine: { lineStyle: { color: border } } },
    radar: { axisName: { color: muted }, splitLine: { lineStyle: { color: border } }, splitArea: { areaStyle: { color: [color('--bg-primary'), color('--bg-secondary')] } } },
  };
  const cleaned = clean(option);
  const tooltips = tooltip => ({ ...tooltip, renderMode: 'richText', confine: true, backgroundColor: color('--bg-elevated'), borderColor: border, textStyle: { color: text } });
  cleaned.tooltip = Array.isArray(cleaned.tooltip) ? cleaned.tooltip.map(tooltips) : tooltips(cleaned.tooltip);
  cleaned.animation = false;
  return { theme, option: cleaned };
}

export function createMarkdownPreview({ overlay, fetchFile, t }) {
  const body = overlay.querySelector('.markdown-preview-body');
  const title = overlay.querySelector('h2');
  let current;
  const active = run => current === run && overlay.classList.contains('open');
  const message = (text, className = 'md-preview-message') => {
    const el = document.createElement('p'); el.className = className; el.textContent = text; return el;
  };

  function cleanup() {
    if (!current) return;
    current.controller.abort();
    current.resizeObserver.disconnect();
    for (const chart of current.charts) chart.instance?.dispose();
    for (const url of current.urls) URL.revokeObjectURL(url);
    current = undefined;
    body.replaceChildren();
  }

  function drawChart(chart) {
    chart.instance?.dispose();
    chart.element.replaceChildren();
    const themed = themeOptions(chart.option);
    try {
      chart.instance = echarts.init(chart.element, themed.theme, { renderer: 'canvas' });
      chart.instance.setOption(themed.option);
    } catch {
      chart.instance?.dispose(); chart.instance = undefined;
      chart.element.replaceChildren(message(t('delivery.chartUnavailable')));
    }
  }

  async function loadImage(image, reference, run) {
    image.removeAttribute('src');
    image.removeAttribute('srcset');
    image.referrerPolicy = 'no-referrer';
    const fail = () => {
      if (active(run)) image.replaceWith(message(`${image.alt || reference} · ${t('common.imageLoadFailed')}`, 'md-preview-message md-resource-error'));
    };
    image.onerror = fail;
    if (/^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(reference)) { image.src = reference; return; }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) { fail(); return; }
    try {
      const url = new URL(run.downloadUrl, location.href);
      url.searchParams.set('resource', reference);
      const response = await fetchFile(url.pathname + url.search, { signal: run.controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Unavailable image');
      const blob = await response.blob();
      if (!active(run)) return;
      const objectUrl = URL.createObjectURL(blob);
      run.urls.push(objectUrl);
      image.src = objectUrl;
    } catch (error) { if (error.name !== 'AbortError') fail(); }
  }

  function chartFigure(reference, run) {
    const figure = document.createElement('span');
    figure.className = 'md-figure'; figure.setAttribute('role', 'figure');
    const caption = document.createElement('span'); caption.className = 'md-caption';
    caption.textContent = [reference.id, reference.description].filter(Boolean).join(' · ');
    const url = chartImageUrl(reference.json);
    if (url) {
      const image = document.createElement('img'); image.alt = caption.textContent;
      figure.append(image); run.images.push({ image, reference: url });
    } else {
      const chartData = parseBriefingChartData(reference.json);
      if (chartData?.option?.series) {
        const element = document.createElement('span'); element.className = 'md-chart';
        element.setAttribute('aria-label', caption.textContent || t('delivery.chart'));
        figure.append(element); run.charts.push({ element, option: chartData.option });
      } else figure.append(message(t('delivery.chartUnavailable')));
    }
    figure.append(caption);
    return figure;
  }

  function renderDocument(markdown, run) {
    const documentData = extractMarkdownChartSection(markdown);
    const fragment = DOMPurify.sanitize(marked.parse(documentData.body), {
      RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'track', 'link', 'meta'],
      FORBID_ATTR: ['style', 'srcset'],
    });
    for (const math of fragment.querySelectorAll('.md-math')) {
      try {
        katex.render(math.textContent, math, { displayMode: math.dataset.display === 'true', throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, macros: { '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\E': '\\mathbb{E}' } });
      } catch { math.classList.add('md-math-error'); }
    }
    for (const image of fragment.querySelectorAll('img')) {
      const reference = image.getAttribute('src'); image.removeAttribute('src');
      if (reference) run.images.push({ image, reference });
    }
    for (const link of fragment.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (/^https?:\/\//i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else if (!href.startsWith('#') && !href.startsWith('mailto:')) link.removeAttribute('href');
    }
    for (const source of fragment.querySelectorAll('.md-chart-source')) {
      source.replaceWith(chartFigure({ json: source.textContent, description: '', id: '' }, run));
    }
    const charts = new Map(documentData.charts.map(chart => [chart.id, chart]));
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('pre, code, a, .md-math, .md-figure') && /\{图\d+\}/.test(node.textContent)) nodes.push(node);
    }
    for (const node of nodes) {
      const replacement = document.createDocumentFragment();
      for (const part of node.textContent.split(/(\{图\d+\})/)) {
        if (/^\{图\d+\}$/.test(part)) replacement.append(chartFigure(charts.get(part) || { id: part, json: '', description: '' }, run));
        else replacement.append(document.createTextNode(part));
      }
      node.replaceWith(replacement);
    }
    if (documentData.charts.length) {
      const section = document.createElement('section'); section.className = 'md-chart-index';
      const heading = document.createElement('h2'); heading.textContent = t('delivery.chartIndex');
      const list = document.createElement('ul');
      for (const chart of documentData.charts) {
        const item = document.createElement('li');
        item.textContent = [chart.id, chart.description].filter(Boolean).join(' · ');
        list.append(item);
      }
      section.append(heading, list); fragment.append(section);
    }
    for (const table of fragment.querySelectorAll('table')) {
      const wrapper = document.createElement('div'); wrapper.className = 'md-table-scroll';
      table.replaceWith(wrapper); wrapper.append(table);
    }
    body.replaceChildren(fragment);
    for (const chart of run.charts) { drawChart(chart); run.resizeObserver.observe(chart.element); }
    for (const image of run.images) void loadImage(image.image, image.reference, run);
  }

  overlay.querySelector('.markdown-preview-close').addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', event => { if (event.target === overlay) overlay.classList.remove('open'); });
  new MutationObserver(() => { if (!overlay.classList.contains('open')) cleanup(); }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => { if (current) for (const chart of current.charts) drawChart(chart); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    async open({ downloadUrl, name }) {
      cleanup();
      const run = { downloadUrl, controller: new AbortController(), charts: [], images: [], urls: [], resizeObserver: new ResizeObserver(() => { if (active(run)) for (const chart of run.charts) chart.instance?.resize(); }) };
      current = run;
      title.textContent = name;
      overlay.classList.add('open'); body.scrollTop = 0;
      body.replaceChildren(message(t('common.loading')));
      body.setAttribute('aria-busy', 'true');
      try {
        const response = await fetchFile(downloadUrl, { signal: run.controller.signal });
        if (!response.ok) throw new Error(response.status === 409 ? t('delivery.fileChanged') : `${t('delivery.previewFailed')} (HTTP ${response.status})`);
        if (Number(response.headers.get('content-length')) > MAX_DOCUMENT_BYTES) throw new Error(t('delivery.previewTooLarge'));
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(t('delivery.previewTooLarge'));
        if (!active(run)) return;
        renderDocument(new TextDecoder().decode(bytes), run);
      } catch (error) {
        if (active(run) && error.name !== 'AbortError') body.replaceChildren(message(error.message));
      } finally { if (active(run)) body.setAttribute('aria-busy', 'false'); }
    },
  };
}
