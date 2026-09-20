/** Offline browser regression: all HTTP and WS traffic uses in-memory fixtures. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile, mkdtemp } from 'node:fs/promises';
const root = fileURLToPath(new URL('../../src/web/public/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const out = await mkdtemp(join(tmpdir(), 'hogagent-webui-smoke-'));
const apiFixtures = {
    '/api/users': { users: [{ id: 'default', workspace: '/workspace' }], selectedUser: 'default' },
    '/api/user-theme': { theme: 'fintech' },
    '/api/skills': { skills: [{ name: 'financial-report', description: '解读财务报告与关键财务指标', version: '1.0', scope: 'system' }] },
    '/api/tools': { tools: ['read', 'write', 'bash', 'web_search'].map(name => ({ name })) },
    '/api/upload': { path: '/workspace/uploads/report.txt', name: 'report.txt', size: 18 },
    '/api/extensions': { extensions: [{ name: 'memory', scope: 'system' }] },
};
const browser = await chromium.launch({ executablePath: process.env.HOGAGENT_BROWSER_EXECUTABLE || undefined, headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.__commands = [];
        window.WebSocket = class {
            static OPEN = 1;
            readyState = 1;
            constructor() { window.__socket = this; setTimeout(() => this.onopen?.(), 0); }
            send(message) {
                const request = JSON.parse(message);
                window.__commands.push(request);
                if (request.command?.type === 'refresh_models' && request.command.target?.startsWith('composer-models-')) {
                    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'rpc_event', event: {
                        type: 'models_refreshed', provider: request.command.provider, target: request.command.target,
                        models: [{id:'qwen3.8-flash'}, {id:'o3-mini'}, {id:'gpt-4o'}],
                    } }) }), 0);
                }
            }
            close() { }
        };
    });
    await page.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/api/')) {
            requests.push({ path, method: route.request().method(), body: route.request().postData() });
            const data = apiFixtures[path] || {};
            if (path === '/api/download')
                return route.fulfill({ body: 'fixture file', contentType: 'text/plain' });
            return route.fulfill({ json: data });
        }
        let file = path === '/' ? '/index.html' : path;
        let body = await readFile(root + file);
        if (file === '/index.html') {
            const token = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
            body = Buffer.from(body.toString().replace('<head>', `<head><meta name="hogagent-web-token" content="${token}">`));
        }
        await route.fulfill({ body, contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'text/html' });
    });
    await page.goto('http://hogagent.test/');
    await page.waitForFunction(() => document.querySelector('#lang-selector').options.length > 0 && window.__socket);
    await page.evaluate(() => {
        handleRpcEvent({ type: 'state', model: 'qwen3.8-flash', thinking_level: 'high' });
        renderCapabilities({ installed_skills: ['financial-report', 'web-research'], builtin_tools: ['read', 'write', 'bash', 'web_search'], extensions: ['memory'], supports_compaction: true, supports_sub_agent: true });
        renderSessionList([
            { id: 'current', title: '', createdAt: Date.now() },
            ...['梳理新能源行业研究框架', '分析贵州茅台最新财报', '整理本周市场观察', '对比两家公司的现金流', '研究长期投资组合配置'].map((title, i) => ({ id: `session-${i}`, title, createdAt: Date.now() - 86400000 * (i + 1) }))
        ], 'current');
    });
    assert.equal(await page.locator('.logo-title .app-version').textContent(), `v${manifest.version}`);
    const welcomeInputHeight = await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height);
    assert.equal(welcomeInputHeight, 64);
    await page.screenshot({ animations: 'disabled', path: out + '/desktop.png' });
    await page.locator('#model-indicator').click();
    await page.waitForFunction(() => !document.querySelector('#composer-model-select').disabled);
    assert.equal(await page.locator('#settings-modal').evaluate(el => el.classList.contains('open')), false);
    await page.locator('#composer-model-select').selectOption('o3-mini');
    await page.locator('#composer-thinking-level').focus();
    await page.keyboard.press('ArrowLeft');
    await page.screenshot({ animations: 'disabled', path: out + '/inline-model.png' });
    await page.locator('#apply-composer-model').click();
    assert.deepEqual(await page.evaluate(() => window.__commands.at(-1).command), {type:'save_settings',provider:'hedgehog',modelId:'o3-mini',thinkingLevel:'medium'});
    await page.evaluate(() => handleRpcEvent({type:'settings_saved',success:true,provider:'hedgehog',modelId:'o3-mini'}));
    assert.equal(await page.locator('#model-indicator').textContent(), 'o3-mini · medium');
    assert.equal(await page.locator('#composer-model-panel').isVisible(), false);
    await page.locator('#settings-btn').click();
    await page.screenshot({ animations: 'disabled', path: out + '/settings.png' });
    await page.locator('#close-settings').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height), 56);
    await page.screenshot({ animations: 'disabled', path: out + '/mobile.png' });
    await page.locator('#sidebar-toggle').click();
    await page.screenshot({ animations: 'disabled', path: out + '/mobile-sidebar.png' });
    await page.locator('.nav-item[data-panel="skills"]').click();
    await page.locator('#skills-table-body .skill-ops button').first().waitFor();
    await page.screenshot({ animations: 'disabled', path: out + '/mobile-skills.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    // Verify the changed interactions against a real browser with mocked transport.
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('.nav-item[data-panel="chat"]').click();
    await page.locator('#sidebar-collapse-btn').click();
    assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('collapsed')), true);
    await page.evaluate(() => handleRpcEvent({ type: 'session_switched', session_id: 'history', messages: [{ role: 'user', content: '历史对话' }] }));
    assert.equal(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height), 28);
    await page.locator('#new-session-btn').click();
    assert.deepEqual(await page.evaluate(() => window.__commands.at(-1)), { type: 'new_session' });
    await page.evaluate(() => {
        handleServerMessage({ type: 'connection_status', status: 'connected' });
        handleRpcEvent({ type: 'ready', session_id: 'new', capabilities: {} });
    });
    assert.equal(await page.locator('.welcome-message').count(), 1);
    assert.equal(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height), welcomeInputHeight);
    await page.locator('#sidebar-collapse-btn').click();
    await page.locator('#model-indicator').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-modal').evaluate(el => el.classList.contains('open')), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model-indicator');
    await page.evaluate(() => {
        clearWelcomeMessage();
        addMessage('user', '请梳理一下这份研究报告的关键结论，并给出后续关注方向。');
        addMessage('assistant', '## 报告的三个关键结论\n\n行业需求保持稳健，但不同企业的增长质量出现分化。我们可以从下面三个方面继续观察。\n\n- **收入结构**：关注主营业务的持续性。\n- **现金流**：将利润与经营现金流放在一起分析。\n- **风险因素**：跟踪库存和资本开支的变化。\n\n下一步可以结合财务数据，逐项核对这些判断。');
    });
    await page.screenshot({ animations: 'disabled', path: out + '/conversation.png' });
    for (const theme of ['bloomberg', 'oldmoney', 'economist', 'saas', 'mist', 'twilight', 'parchment', 'azure', 'gravel', 'fintech']) {
        await page.selectOption('#theme-selector', theme);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        if (theme === 'bloomberg')
            await page.screenshot({ animations: 'disabled', path: out + '/dark.png' });
    }
    await page.evaluate(() => {
        // Populate the existing menu from a representative runtime capability.
        state.skillsData = [{ name: 'gen-chart', description: '图表生成' }];
    });
    for (const width of [320, 390, 768, 900, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await page.locator('#message-input').fill('');
        const singleLineHeight = await page.locator('#message-input').evaluate(el => {
            const height = el.getBoundingClientRect().height;
            const expected = parseFloat(getComputedStyle(el).lineHeight) + 4;
            if (Math.abs(height - expected) > 1) throw new Error(`Expected one input line: ${height} vs ${expected}`);
            return height;
        });
        await page.locator('#message-input').fill('第一行\n第二行\n第三行');
        assert.ok(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height) > singleLineHeight);
        await page.locator('#message-input').fill('');
        assert.equal(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height), singleLineHeight);
        await page.locator('#skill-btn').click();
        const box = await page.locator('#skill-menu').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `menu overflow at ${width}`);
        await page.locator('#skill-menu .skill-parent').click();
        const sub = await page.locator('#skill-submenu').boundingBox();
        assert.ok(sub.x >= 0 && sub.x + sub.width <= width && sub.y >= 0, `submenu overflow at ${width}`);
        await page.locator('#skill-submenu .skill-child').first().click();
        assert.match(await page.locator('#message-input').inputValue(), /^\/gen-chart:fintech /);
        const input = await page.locator('#message-input').boundingBox();
        const send = await page.locator('#send-btn').boundingBox();
        assert.ok(input.x >= 0 && input.x + input.width <= width && send.x + send.width <= width, `composer overflow at ${width}`);
        for (const selector of ['#token-stats-btn', '#compact-btn', '#abort-btn'])
            assert.ok(await page.locator(selector).isVisible());
        await page.locator('#model-indicator').click();
        await page.waitForFunction(() => !document.querySelector('#composer-model-select').disabled);
        const modelPanel = await page.locator('#composer-model-panel').boundingBox();
        assert.ok(modelPanel.x >= 0 && modelPanel.x + modelPanel.width <= width && modelPanel.y >= 0 && modelPanel.y + modelPanel.height <= 844, `model controls overflow at ${width}`);
        await page.locator('#composer-model-select').selectOption('gpt-4o');
        assert.equal(await page.locator('#composer-thinking-level').isDisabled(), true);
        await page.locator('#composer-model-select').selectOption('qwen3.8-flash');
        assert.equal(await page.locator('#composer-thinking-level').isDisabled(), false);
        if (width === 390) await page.screenshot({ animations:'disabled', path:out + '/mobile-inline-model.png' });
        await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#sidebar-toggle').click();
    await page.locator('#settings-btn').click();
    await page.screenshot({ animations: 'disabled', path: out + '/mobile-settings.png' });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('main').evaluate(el => el.inert), false);
    // Exercise HTTP controls and streamed events with the same payload shapes as production.
    await page.setViewportSize({ width: 1440, height: 960 });
    for (const [panel, expected] of [['skills', 'financial-report'], ['extensions', 'memory'], ['tools', 'read']]) {
        await page.locator(`.nav-item[data-panel="${panel}"]`).click();
        await page.waitForFunction(({ panel, expected }) => document.querySelector(`#${panel}-table-body`).textContent.includes(expected), { panel, expected });
    }
    await page.locator('.nav-item[data-panel="skills"]').click();
    await page.locator('#install-skill-page-btn').click();
    assert.ok(await page.locator('#skill-install-modal').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('#skills-table-body .skill-ops button').first().click();
    await page.locator('#save-skill-config').click();
    await page.waitForFunction(() => !document.querySelector('#skill-config-modal').classList.contains('open'));
    assert.ok(requests.some(request => request.path.endsWith('/config') && request.method === 'PUT'));
    await page.locator('.nav-item[data-panel="chat"]').click();
    await page.locator('#message-input').fill('请读取附件并概括内容');
    await page.locator('#file-input').setInputFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture report') });
    await page.locator('.file-chip').waitFor();
    await page.locator('#send-btn').click();
    assert.equal(await page.locator('#message-input').evaluate(el => el.getBoundingClientRect().height), 28);
    assert.ok((await page.evaluate(() => window.__commands)).some(item => item.command?.text?.includes('[attached files: /workspace/uploads/report.txt]')));
    assert.ok(await page.locator('#abort-btn').isEnabled());
    await page.locator('#abort-btn').click();
    assert.equal(await page.evaluate(() => window.__commands.at(-1).command.type), 'abort');
    await page.evaluate(() => handleRpcEvent({ type: 'aborted' }));
    await page.locator('#compact-btn').click();
    assert.equal(await page.evaluate(() => window.__commands.at(-1).command.type), 'compact');
    await page.evaluate(() => handleRpcEvent({ type: 'compact_completed' }));
    await page.evaluate(() => {
        handleRpcEvent({ type: 'message_start', role: 'assistant' });
        handleRpcEvent({ type: 'thinking_start' });
        handleRpcEvent({ type: 'thinking', delta: '正在核对附件中的内容。' });
        handleRpcEvent({ type: 'thinking_end', source: 'audit', usage: { input: 10, output: 5, totalTokens: 15 } });
        handleRpcEvent({ type: 'tool_execution_start', tool_call_id: 'fixture-tool', tool_name: 'read', args: { path: 'report.txt' } });
        handleRpcEvent({ type: 'tool_execution_update', tool_call_id: 'fixture-tool', output: 'Fixture report' });
        handleRpcEvent({ type: 'tool_execution_end', tool_call_id: 'fixture-tool' });
        handleRpcEvent({ type: 'message_update', role: 'assistant', delta: '## 附件概览\n\n这是一份测试报告。' });
        handleRpcEvent({ type: 'message_end', usage: { input: 100, output: 30, totalTokens: 130 } });
        handleRpcEvent({ type: 'sub_agent_completed', sub_agent_id: 'fixture-sub', status: 'completed', usage: { input: 20, output: 10, totalTokens: 30 } });
        handleRpcEvent({ type: 'agent_end' });
        handleRpcEvent({ type: 'delivery', id: 'receipt-fixture', run_id: 'fixture-run', path: 'report.txt', session_id: 'new', size: 12, description: '测试报告', mime_type: 'text/plain' });
    });
    assert.ok((await page.locator('.message.assistant').last().textContent()).includes('附件概览'));
    assert.ok(await page.locator('#fixture-tool').isVisible());
    await page.locator('.thinking-section-header').last().click();
    assert.ok(await page.locator('.thinking-section.expanded').isVisible());
    const cardCount = await page.locator('.delivery-card').count();
    await page.evaluate(() => {
        handleRpcEvent({ type: 'delivery', id: 'receipt-fixture', path: 'report.txt', session_id: 'new' });
        handleRpcEvent({ type: 'delivery', path: 'unregistered.txt', session_id: 'new' });
        handleRpcEvent({ type: 'delivery', id: 'other-session', path: 'wrong.txt', session_id: 'other' });
    });
    assert.equal(await page.locator('.delivery-card').count(), cardCount);
    assert.ok((await page.locator('.delivery-download').last().getAttribute('data-url')).includes('receipt=receipt-fixture'));
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.delivery-download').last().click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'report-new.txt');
    await download.delete();
    await page.locator('#token-stats-btn').click();
    assert.ok((await page.locator('.token-audit-line').textContent()).includes('15'));
    assert.ok((await page.locator('.token-subagent-table').textContent()).includes('fixture-sub'));
    await page.screenshot({ animations: 'disabled', path: out + '/token-stats.png' });
    await page.keyboard.press('Escape');
    await page.locator('#settings-btn').click();
    assert.equal(await page.locator('.settings-heading .app-version').textContent(), `HogAgent v${manifest.version}`);
    for (const tab of ['audit-llm', 'search', 'external-mcp', 'system']) {
        await page.locator(`.settings-tab[data-tab="${tab}"]`).click();
        assert.ok(await page.locator(`.settings-tab-panel[data-tab="${tab}"]`).isVisible());
    }
    await page.locator('#save-settings').click();
    assert.ok(await page.evaluate(() => window.__commands.at(-1).command.systemConfig));
    await page.evaluate(() => handleRpcEvent({ type: 'settings_saved', success: true }));
    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="search"]').click();
    await page.locator('#search-field-api_key').waitFor();
    await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/search-settings' && response.request().method() === 'POST'),
        page.locator('#save-settings').click(),
    ]);
    assert.ok(requests.some(request => request.path === '/api/search-settings' && request.method === 'POST'));
    await page.locator('.settings-tab[data-tab="external-mcp"]').click();
    await page.evaluate(() => handleRpcEvent({ type: 'mcp_servers', result: { systemConfig: { schemaVersion: 1, servers: [] } } }));
    await page.locator('#add-mcp-server').click();
    await page.locator('[data-mcp-field="transportType"]').selectOption('stdio');
    await page.locator('[data-mcp-field="command"]').fill('fixture-command');
    await page.locator('#save-settings').click();
    assert.equal(await page.evaluate(() => window.__commands.at(-1).command.type), 'save_mcp_servers');
    await page.keyboard.press('Escape');
    for (const lang of ['en', 'zh-CN', 'ja', 'de', 'ar']) {
        await page.locator('#lang-selector').selectOption(lang);
        const translations = JSON.parse(await readFile(join(root, `i18n/${lang}.json`), 'utf8'));
        await page.waitForFunction(expected => document.querySelector('#new-session-btn').textContent.includes(expected), translations.chat.newSession);
        assert.ok(!(await page.locator('#model-indicator').textContent()).includes('chat.model'));
    }
    await page.locator('#lang-selector').selectOption('zh-CN');
    await page.locator('#message-input').fill('');
    await page.screenshot({ animations: 'disabled', path: out + '/verified-chat.png' });
    // Use real scroll geometry/events: DOM-only tests cannot catch smooth-scroll races.
    const settleScroll = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const chatScroll = () => page.locator('#messages-container').evaluate(el => ({
        top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop,
    }));
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => handleRpcEvent({
            type: 'session_switched', session_id: 'scroll-history',
            messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `历史记录 ${i}\n第二行\n第三行` })),
        }));
        await settleScroll();
        assert.ok((await chatScroll()).gap <= 2, 'restored history opens at the bottom');
        await page.evaluate(() => {
            handleRpcEvent({ type: 'message_start', role: 'assistant' });
            handleRpcEvent({ type: 'message_update', delta: '流式内容\n'.repeat(40) });
        });
        await settleScroll();
        assert.ok((await chatScroll()).gap <= 2, 'large streamed updates keep following');

        await page.locator('#messages-container').hover();
        await page.mouse.wheel(0, -600);
        await page.waitForFunction(() => {
            const el = document.querySelector('#messages-container');
            return el.scrollHeight - el.clientHeight - el.scrollTop > 200;
        });
        await settleScroll();
        const readingTop = (await chatScroll()).top;
        await page.evaluate(() => {
            handleRpcEvent({ type: 'ready', session_id: 'scroll-history', _reconnect: true, capabilities: {} });
            handleRpcEvent({ type: 'thinking_start' });
            handleRpcEvent({ type: 'thinking', delta: '思考内容\n'.repeat(20) });
            handleRpcEvent({ type: 'thinking_end' });
            handleRpcEvent({ type: 'tool_execution_start', tool_call_id: 'scroll-tool', tool_name: 'read', args: {} });
            handleRpcEvent({ type: 'message_update', delta: '更多流式内容\n'.repeat(40) });
            handleRpcEvent({ type: 'message_end' });
            handleRpcEvent({ type: 'delivery', id: 'scroll-delivery', path: 'report.txt', session_id: 'scroll-history' });
            addStatusMessage('状态更新');
        });
        await settleScroll();
        assert.ok(Math.abs((await chatScroll()).top - readingTop) <= 2, 'streaming and reconnect preserve the reading position');

        await page.mouse.wheel(0, 100000);
        await page.waitForFunction(() => {
            const el = document.querySelector('#messages-container');
            return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
        });
        await settleScroll();
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => handleRpcEvent({ type: 'message_update', delta: '继续输出\n'.repeat(15) }));
            await settleScroll();
            assert.ok((await chatScroll()).gap <= 2, 'returning to the bottom resumes following across updates');
        }

        await page.mouse.wheel(0, -600);
        await settleScroll();
        if (width === 390) await page.locator('#sidebar-toggle').click();
        await page.locator('#new-session-btn').click();
        await page.evaluate(() => {
            handleRpcEvent({ type: 'ready', session_id: 'scroll-new', capabilities: {} });
            clearWelcomeMessage();
            handleRpcEvent({ type: 'message_start', role: 'assistant' });
            handleRpcEvent({ type: 'message_update', delta: '新会话\n'.repeat(80) });
        });
        await settleScroll();
        assert.ok((await chatScroll()).gap <= 2, 'new sessions reset paused following');
        await page.locator('#messages-container').evaluate(el => { el.scrollTop = 0; });
        await settleScroll();
    }
    assert.ok(requests.filter(request => request.path.startsWith('/api/')).length > 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', viewports: 5, themes: 10, screenshots: out }));
}
finally {
    await browser.close();
}
