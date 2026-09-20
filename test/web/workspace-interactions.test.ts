import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { configModelToAgentModel } from '../../src/model-utils.ts';
import { getSupportedThinkingLevels } from '../../src/vendor/ai/models.ts';

const publicDir = resolve('src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const source = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
let dom: JSDOM;
let commands: Record<string, unknown>[];

beforeEach(async () => {
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
  dom = new JSDOM(html.replace('<head>', `<head><meta name="hogagent-web-token" content="${token}">`), {
    url: 'http://localhost:9108', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  commands = [];
  const { window } = dom;
  Object.assign(window, { Headers, Request });
  window.fetch = vi.fn(async (input: string) => {
    const path = new URL(input, window.location.href).pathname;
    const data = path.startsWith('/i18n/')
      ? JSON.parse(readFileSync(resolve(publicDir, path.slice(1)), 'utf8'))
      : path === '/api/users' ? { users: [{ id: 'default' }], selectedUser: 'default' }
      : path === '/api/user-theme' ? { theme: 'fintech' } : {};
    return { ok: true, status: 200, json: async () => data } as Response;
  }) as typeof window.fetch;
  Object.assign(window, {
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      send(message: string) { commands.push(JSON.parse(message)); }
      close() {}
    },
  });
  window.eval(source + '\nwindow.__ready = userInitialization; window.__state = state;');
  await window.eval('window.__ready');
  await window.eval('changeLanguage("zh-CN")');
  window.eval('setConnectionStatus("connected")');
  commands.length = 0;
});

afterEach(() => dom.window.close());

it('restores saved audit fields after cancelling edits and reopening settings', () => {
  dom.window.eval(`
    handleRpcEvent({type:'ready',capabilities:{llmProvider:{provider:'hedgehog',apiKey:'main-key'},currentModel:'main',auditModel:{configured:true,provider:'custom',apiKey:'audit-key',baseUrl:'http://localhost:11434/v1',modelId:'audit',minPassScore:81,maxIterations:0}}});
    document.getElementById('settings-btn').click();
    document.getElementById('audit-api-key-input').value = 'unsaved-key';
    document.getElementById('audit-base-url-input').value = 'https://unsaved.test';
    document.getElementById('close-settings').click();
    document.getElementById('settings-btn').click();
  `);
  const input = (id: string) => (dom.window.document.getElementById(id) as HTMLInputElement).value;
  expect(input('audit-api-key-input')).toBe('audit-key');
  expect(input('audit-base-url-input')).toBe('http://localhost:11434/v1');
  expect(input('audit-max-iterations')).toBe('0');
});

it('does not cache failed saves and accepts the authoritative saved settings snapshot', () => {
  dom.window.eval(`
    handleRpcEvent({type:'ready',capabilities:{llmProvider:{provider:'hedgehog',apiKey:'saved-key'},currentModel:'saved-model'}});
    document.getElementById('settings-btn').click();
    document.getElementById('api-key-input').value = 'draft-key';
    document.getElementById('save-settings').click();
    handleRpcEvent({type:'error',command_type:'save_settings',error:'EPERM'});
  `);
  expect(dom.window.eval('window.__state.providerApiKeys.hedgehog')).toBe('saved-key');
  dom.window.eval(`
    document.getElementById('save-settings').click();
    handleRpcEvent({type:'settings_saved',success:true,settings:{provider:'hedgehog',apiKey:'confirmed-key',modelId:'confirmed-model',baseUrl:'https://confirmed.test/v1',providerApiKeys:{hedgehog:'confirmed-key'},audit:{provider:'close'}}});
    document.getElementById('settings-btn').click();
  `);
  expect(dom.window.eval('window.__state.currentApiKey')).toBe('confirmed-key');
  expect(dom.window.eval('window.__state.currentModel')).toBe('confirmed-model');
  expect((dom.window.document.getElementById('audit-provider-select') as HTMLSelectElement).value).toBe('');
});

it('keeps the configured audit model available after model discovery fails', () => {
  dom.window.eval(`
    handleRpcEvent({type:'ready',capabilities:{auditModel:{configured:true,provider:'hedgehog',apiKey:'key',modelId:'saved-audit'}}});
    document.getElementById('settings-btn').click();
    refreshAuditModels('hedgehog','','key');
    handleRpcEvent({type:'error',target:'audit',provider:'hedgehog',error:'offline'});
  `);
  const document = dom.window.document;
  expect((document.getElementById('custom-audit-model-input') as HTMLInputElement).value
    || (document.getElementById('audit-model-select') as HTMLSelectElement).value).toBe('saved-audit');
});

it.each(['xai', 'groq', 'openrouter'])('prefills and submits the Gateway-supported %s provider', provider => {
  dom.window.eval(`handleRpcEvent(${JSON.stringify({ type: 'ready', capabilities: { llmProvider: { provider, apiKey: 'provider-key', baseUrl: 'https://fixture.test/v1' }, currentModel: 'manual-model' } })}); document.getElementById('settings-btn').click(); document.getElementById('save-settings').click();`);
  expect(commands.at(-1)?.command).toMatchObject({ type: 'save_settings', provider, apiKey: 'provider-key', modelId: 'manual-model' });
});

it('sends explicit empty main and audit keys when the user clears credential fields', () => {
  dom.window.eval(`
    document.getElementById('provider-select').value = 'hedgehog';
    document.getElementById('custom-model-input').value = 'main-model';
    document.getElementById('api-key-input').value = '';
    document.getElementById('api-key-input').dispatchEvent(new Event('input'));
    document.getElementById('audit-provider-select').value = 'hedgehog';
    document.getElementById('custom-audit-model-input').value = 'audit-model';
    document.getElementById('audit-api-key-input').value = '';
    document.getElementById('audit-api-key-input').dispatchEvent(new Event('input'));
    window.__state.auditUserModified = true;
    document.getElementById('save-settings').click();
  `);
  expect(commands.at(-1)).toMatchObject({ type: 'rpc_command', command: {
    type: 'save_settings', provider: 'hedgehog', apiKey: '', audit: { provider: 'hedgehog', apiKey: '' },
  } });
});

it('preserves omitted environment credentials but clears explicitly empty credentials received on ready', () => {
  dom.window.eval(`
    document.getElementById('provider-select').value = 'hedgehog';
    document.getElementById('custom-model-input').value = 'main-model';
    document.getElementById('save-settings').click();
  `);
  expect(commands.at(-1)?.command).not.toHaveProperty('apiKey');
  dom.window.eval(`handleRpcEvent({ type:'ready', capabilities:{llmProvider:{provider:'hedgehog',apiKey:'old',baseUrl:'https://old.test/v1'}} });`);
  dom.window.eval(`handleRpcEvent({ type:'ready', capabilities:{llmProvider:{provider:'hedgehog',apiKey:'',baseUrl:''}} });`);
  expect(dom.window.eval('window.__state.currentApiKey')).toBe('');
  expect(dom.window.eval('window.__state.currentBaseUrl')).toBe('');
  expect(dom.window.eval('window.__state.providerApiKeys')).not.toHaveProperty('hedgehog');
});

it('keeps the Long Task final answer outside thinking during streaming and history replay', () => {
  const emit = (event: object) => dom.window.eval(`handleRpcEvent(${JSON.stringify(event)})`);
  emit({ type: 'session_switched', session_id: 'long-task', mode: 'long_task', messages: [] });
  emit({ type: 'internal_mode', active: true });
  emit({ type: 'thinking_start', role: 'assistant' });
  emit({ type: 'thinking', role: 'assistant', delta: '执行过程' });
  emit({ type: 'thinking_end', role: 'assistant' });
  emit({ type: 'internal_mode', active: false });
  emit({ type: 'message_start', role: 'assistant' });
  emit({ type: 'thinking', role: 'assistant', delta: '摘要前的推理' });
  emit({ type: 'message_update', role: 'assistant', delta: '最终答复\n{"type":"delivery_decision"}' });
  emit({ type: 'message_end', role: 'assistant' });
  emit({ type: 'turn_end', content: '最终答复', delivery_decision: { mode: 'none' } });
  const assertAnswer = () => {
    const answer = dom.window.document.querySelector('.message.assistant .message-content');
    expect(answer?.textContent?.trim()).toBe('最终答复');
    expect(answer?.closest('.thinking-section')).toBeNull();
    expect(dom.window.document.querySelector('.thinking-section')?.textContent).not.toContain('最终答复');
  };
  assertAnswer();
  emit({ type: 'session_switched', session_id: 'long-task', mode: 'long_task', messages: [
    { role: 'assistant', content: '执行过程', type: 'thinking' },
    { role: 'assistant', content: '最终答复', type: 'message' },
  ] });
  assertAnswer();
});

it('normalizes main/sub-agent/audit tokens and ignores late audit events from another session', () => {
  const { window } = dom;
  window.eval('window.__state.sessionId = "current"; resetUsage(); accumulateUsage({ input: 10.9, output: -5, cacheRead: 2 });');
  const emit = (event: object) => window.eval(`handleRpcEvent(${JSON.stringify(event)})`);
  const sub = { type: 'sub_agent_completed', session_id: 'current', sub_agent_id: 'sub-1', usage: { input: 3, output: 2 } };
  emit(sub); emit(sub);
  emit({ type: 'thinking_end', source: 'audit', session_id: 'old', usage: { totalTokens: 999 } });
  emit({ type: 'thinking_end', source: 'audit', session_id: 'current', usage: { input: 4, output: 1 } });
  expect(window.eval('getCombinedTotals().totalTokens')).toBe(17);
  expect(window.eval('window.__state.subAgentUsage.length')).toBe(1);
  expect(window.eval('window.__state.auditUsage.totalTokens')).toBe(5);
});

it.each(['settings_saved', 'config_reloaded'])('refreshes the actual tool inventory after %s', type => {
  dom.window.eval('window.__state.capabilities = { builtin_tools: ["read", "get_tool_details", "query_tool_result"] }');
  dom.window.eval(`handleRpcEvent(${JSON.stringify({type, success:true, builtin_tools:['read']})})`);
  expect(Array.from(dom.window.eval('window.__state.capabilities.builtin_tools') as string[])).toEqual(['read']);
  expect(dom.window.document.getElementById('capabilities')?.textContent).toContain('1');
});

it('refreshes tool capabilities after reconnect, including a removal received while offline', () => {
  dom.window.eval('window.__state.capabilities = { builtin_tools: ["read", "get_tool_details"], supports_compaction: true }');
  dom.window.eval('handleRpcEvent({type:"ready", _reconnect:true, capabilities:{builtin_tools:["read"]}})');
  expect(Array.from(dom.window.eval('window.__state.capabilities.builtin_tools') as string[])).toEqual(['read']);
  expect(dom.window.eval('window.__state.capabilities.supports_compaction')).toBe(true);
});

it.each(['ready', 'settings_saved', 'config_reloaded'])('restores saved compression controls independently of live tools on %s', type => {
  const systemConfig = { compressorEnabled: true, compressThreshold: 6000, explicitCache: true };
  const event = type === 'ready'
    ? { type, _reconnect: true, capabilities: { builtin_tools: ['read'], systemConfig } }
    : { type, success: true, builtin_tools: ['read'], systemConfig };
  dom.window.eval(`handleRpcEvent(${JSON.stringify(event)})`);
  const input = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  expect(input('compressor-enabled-toggle').checked).toBe(true);
  expect(input('compress-threshold').value).toBe('6000');
  expect(input('explicit-cache-toggle').checked).toBe(true);
  expect(Array.from(dom.window.eval('window.__state.capabilities.builtin_tools') as string[])).toEqual(['read']);
  dom.window.eval('handleRpcEvent({type:"ready", _reconnect:true, capabilities:{systemConfig:{compressorEnabled:false}}})');
  expect(input('compressor-enabled-toggle').checked).toBe(false);
});

it('switches MCP transport fields without reading fields from the next transport too early', () => {
  const { window } = dom;
  (window.document.getElementById('add-mcp-server') as HTMLElement).click();
  const name = window.document.querySelector('[data-mcp-field="name"]') as HTMLInputElement;
  name.value = 'fixture-service';
  for (const type of ['stdio', 'http']) {
    const select = window.document.querySelector('[data-mcp-field="transportType"]') as HTMLSelectElement;
    select.value = type;
    select.dispatchEvent(new window.Event('change'));
    expect(window.document.querySelector(`[data-mcp-field="${type === 'stdio' ? 'command' : 'url'}"]`)).not.toBeNull();
    expect((window.document.querySelector('[data-mcp-field="name"]') as HTMLInputElement).value).toBe('fixture-service');
  }
});

it('blocks new-session actions while disconnected and during a pending switch', () => {
  dom.window.eval('setConnectionStatus("disconnected")');
  commands.length = 0;
  dom.window.eval('sendNewSession()');
  expect(commands).toEqual([]);
  expect((dom.window.document.getElementById('new-session-btn') as HTMLButtonElement).disabled).toBe(true);
  dom.window.eval('setConnectionStatus("connected")');
  commands.length = 0;
  dom.window.eval('sendNewSession(); sendNewSession();');
  expect(commands).toEqual([{ type: 'new_session' }]);
  expect((dom.window.document.getElementById('new-session-btn') as HTMLButtonElement).disabled).toBe(true);
  dom.window.eval('handleServerMessage({type:"connection_status", status:"connected"})');
  dom.window.eval('handleRpcEvent({type:"ready", session_id:"new-session", capabilities:{}})');
  expect((dom.window.document.getElementById('new-session-btn') as HTMLButtonElement).disabled).toBe(false);
});

it('does not reopen stale slash suggestions on Enter after sending a command', () => {
  const { window } = dom;
  const input = window.document.getElementById('message-input') as HTMLTextAreaElement;
  input.value = '/model';
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new window.Event('input'));
  expect(window.document.getElementById('slash-autocomplete')?.style.display).toBe('block');
  (window.document.getElementById('send-btn') as HTMLElement).click();
  expect(input.value).toBe('');
  expect(window.document.getElementById('slash-autocomplete')?.style.display).toBe('none');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(input.value).toBe('');
});

it('closes skill menus when switching to quick mode', () => {
  const { window } = dom;
  (window.document.getElementById('skill-btn') as HTMLElement).click();
  const mode = window.document.getElementById('mode-selector') as HTMLSelectElement;
  mode.value = 'quick';
  mode.dispatchEvent(new window.Event('change'));
  expect(window.document.getElementById('skill-menu')?.classList.contains('open')).toBe(false);
});

it('updates the composer model and thinking level from ready and change events', () => {
  dom.window.eval('handleRpcEvent({type:"ready", session_id:"current", capabilities:{currentModel:"test-model", thinkingLevel:"high"}})');
  expect(dom.window.document.getElementById('model-indicator')?.textContent).toBe('test-model · high');
  dom.window.eval('handleRpcEvent({type:"thinking_level_changed", level:"low"})');
  expect(dom.window.document.getElementById('model-indicator')?.textContent).toBe('test-model · low');
});

it('shows audit-only token consumption instead of the empty statistics view', () => {
  dom.window.eval('handleRpcEvent({type:"thinking_end", source:"audit", usage:{input:40, output:10, totalTokens:50}})');
  (dom.window.document.getElementById('token-stats-btn') as HTMLElement).click();
  expect(dom.window.document.querySelector('.token-audit-line')?.textContent).toContain('50');
  expect(dom.window.document.querySelector('.token-stats-empty')).toBeNull();
});

it('only displays saved LLM configuration after acknowledgement, and permits retry after failure', () => {
  const { window } = dom;
  window.eval('handleRpcEvent({type:"state", model:"original", thinking_level:"medium"})');
  (window.document.getElementById('settings-btn') as HTMLElement).click();
  (window.document.getElementById('custom-model-input') as HTMLInputElement).value = 'replacement';
  (window.document.getElementById('thinking-level') as HTMLInputElement).value = '4';
  (window.document.getElementById('save-settings') as HTMLElement).click();
  expect(window.document.getElementById('model-indicator')?.textContent).toBe('original · medium');
  expect((window.document.getElementById('save-settings') as HTMLButtonElement).disabled).toBe(true);
  window.eval('handleRpcEvent({type:"error", error:"Could not save settings"})');
  expect((window.document.getElementById('save-settings') as HTMLButtonElement).disabled).toBe(false);
  expect(window.document.getElementById('model-indicator')?.textContent).toBe('original · medium');
  (window.document.getElementById('save-settings') as HTMLElement).click();
  window.eval('handleRpcEvent({type:"settings_saved", success:true, provider:"hedgehog", modelId:"replacement"})');
  expect(window.document.getElementById('model-indicator')?.textContent).toBe('replacement · high');
});

it('opens inline controls and requests only the active provider, independently from settings drafts', () => {
  const { window } = dom;
  const { document } = window;
  window.eval('handleRpcEvent({type:"ready",session_id:"current",capabilities:{llmProvider:{provider:"custom",apiKey:"active-key",baseUrl:"https://active.test/v1"},currentModel:"qwen3-test"}})');
  commands.length = 0;
  (document.getElementById('provider-select') as HTMLSelectElement).value = 'openai';
  (document.getElementById('base-url-input') as HTMLInputElement).value = 'https://unsaved.test/v1';
  (document.getElementById('model-indicator') as HTMLElement).click();
  expect(document.getElementById('settings-modal')?.classList.contains('open')).toBe(false);
  expect(document.getElementById('composer-model-panel')?.hidden).toBe(false);
  const command = commands.at(-1)?.command as Record<string, unknown>;
  expect(command).toEqual({ type: 'refresh_models', provider: 'custom', apiKey: 'active-key', baseUrl: 'https://active.test/v1', target: expect.stringMatching(/^composer-models-/) });
  window.eval(`handleRpcEvent(${JSON.stringify({type:'models_refreshed', provider:'custom', target:command.target, models:[{id:'qwen3-test'}, {id:'plain-model'}]})})`);
  expect([...(document.getElementById('composer-model-select') as HTMLSelectElement).options].map(option => option.value)).toEqual(['qwen3-test', 'plain-model']);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  expect(document.getElementById('composer-model-panel')?.hidden).toBe(true);
  expect(document.activeElement?.id).toBe('model-indicator');
});

function receiveComposerModels(models: {id: string}[] = [{id:'qwen3-test'}, {id:'plain-model'}]) {
  const command = commands.at(-1)?.command as Record<string, unknown>;
  dom.window.eval(`handleRpcEvent(${JSON.stringify({type:'models_refreshed', provider:command.provider, target:command.target, models})})`);
}

it('submits inline changes once and updates active values only after successful acknowledgement', () => {
  const { window } = dom;
  window.eval('handleRpcEvent({type:"state",model:"qwen3-old",thinking_level:"low"})');
  (window.document.getElementById('model-indicator') as HTMLElement).click();
  receiveComposerModels();
  const slider = window.document.getElementById('composer-thinking-level') as HTMLInputElement;
  slider.value = '4';
  slider.dispatchEvent(new window.Event('input'));
  const apply = window.document.getElementById('apply-composer-model') as HTMLButtonElement;
  apply.click(); apply.click();
  expect(commands.filter(item => (item.command as Record<string, unknown>)?.type === 'save_settings')).toEqual([
    {type:'rpc_command',command:{type:'save_settings',provider:'hedgehog',modelId:'qwen3-test',thinkingLevel:'high'}},
  ]);
  expect(window.document.getElementById('model-indicator')?.textContent).not.toContain('qwen3-test');
  window.eval('handleRpcEvent({type:"error",error:"Save failed"})');
  expect(window.document.getElementById('composer-model-status')?.textContent).toBe('Save failed');
  expect(apply.disabled).toBe(false);
  apply.click();
  window.eval('handleRpcEvent({type:"settings_saved",success:true,provider:"hedgehog",modelId:"qwen3-test"})');
  expect(window.document.getElementById('model-indicator')?.textContent).toBe('qwen3-test · high');
  expect(window.document.getElementById('composer-model-panel')?.hidden).toBe(true);
});

it('locks unavailable model lists to auto without saving until explicitly applied', () => {
  const { window } = dom;
  (window.document.getElementById('model-indicator') as HTMLElement).click();
  const command = commands.at(-1)?.command as Record<string, unknown>;
  window.eval(`handleRpcEvent(${JSON.stringify({type:'error', provider:command.provider, target:command.target, error:'No models'})})`);
  const select = window.document.getElementById('composer-model-select') as HTMLSelectElement;
  expect(select.value).toBe('auto');
  expect(select.disabled).toBe(true);
  expect(select.options.length).toBe(1);
  expect((window.document.getElementById('composer-thinking-level') as HTMLInputElement).disabled).toBe(true);
  expect(commands.length).toBe(1);
  (window.document.getElementById('apply-composer-model') as HTMLElement).click();
  expect(commands.at(-1)).toEqual({type:'rpc_command',command:{type:'save_settings',provider:'hedgehog',modelId:'auto',thinkingLevel:'off'}});
});

it('ignores stale or other-provider model replies and prevents applying after the provider changes', () => {
  const { window } = dom;
  const toggle = window.document.getElementById('model-indicator') as HTMLElement;
  toggle.click();
  const first = commands.at(-1)?.command as Record<string, unknown>;
  toggle.click(); toggle.click();
  window.eval(`handleRpcEvent(${JSON.stringify({type:'models_refreshed',provider:'hedgehog',target:first.target,models:[{id:'stale'}]})})`);
  expect((window.document.getElementById('composer-model-select') as HTMLSelectElement).value).toBe('auto');
  receiveComposerModels();
  window.eval('handleRpcEvent({type:"state",provider:"openai",model:"o3-test"})');
  const count = commands.length;
  (window.document.getElementById('apply-composer-model') as HTMLElement).click();
  expect(commands.length).toBe(count);
  expect(window.document.getElementById('composer-model-panel')?.hidden).toBe(true);
});

it('matches inline thinking options to the current runtime model conversion and resets unsupported choices', () => {
  for (const provider of ['hedgehog','openai','anthropic','google','deepseek','mistral','custom']) {
    for (const id of ['qwen3.8-flash','qwq-32b','deepseek-reasoner','o3-mini','gpt-4o','claude-sonnet-4','gemini-2.5-pro','auto']) {
      const model = configModelToAgentModel({id,name:id,contextWindow:64000}, provider, 'https://fixture.test/v1');
      expect(dom.window.eval(`composerThinkingLevels(${JSON.stringify(provider)}, ${JSON.stringify(id)})`)).toEqual(getSupportedThinkingLevels(model));
    }
  }
  const { window } = dom;
  window.eval('handleRpcEvent({type:"thinking_level_changed",level:"xhigh"})');
  (window.document.getElementById('model-indicator') as HTMLElement).click();
  receiveComposerModels();
  const slider = window.document.getElementById('composer-thinking-level') as HTMLInputElement;
  expect(slider.max).toBe('4');
  expect(slider.value).toBe('4');
  const select = window.document.getElementById('composer-model-select') as HTMLSelectElement;
  select.value = 'plain-model';
  select.dispatchEvent(new window.Event('change'));
  expect(slider.disabled).toBe(true);
  expect(slider.max).toBe('0');
  expect(window.document.getElementById('composer-thinking-value')?.textContent).toBe('关闭');
});

it('keeps navigation available on mobile management pages and closes the drawer explicitly', () => {
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  window.dispatchEvent(new window.Event('resize'));
  const toggle = window.document.getElementById('sidebar-toggle') as HTMLElement;
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(window.document.querySelector('main')?.inert).toBe(true);
  (window.document.querySelector('[data-panel="skills"].nav-item') as HTMLElement).click();
  expect(window.document.getElementById('skills-page')?.style.display).toBe('flex');
  expect(window.document.querySelector<HTMLElement>('.chat-header')?.style.display).not.toBe('none');
  expect(window.document.querySelector('main')?.inert).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  toggle.click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('switches historical sessions by keyboard using the original WS request', () => {
  dom.window.eval(`renderSessionList([{ id: 'history', title: '财报分析', createdAt: 0 }], 'current')`);
  dom.window.document.querySelector('[data-session="history"]')?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(commands).toEqual([{ type: 'rpc_command', command: { type: 'switch_session', session_id: 'history' } }]);
  dom.window.eval('setConnectionStatus("disconnected")');
  expect(dom.window.document.querySelector('.session-item.active .session-status')?.textContent).toBe('未连接');
});

it('returns to chat and restores the welcome view when the new session is ready', () => {
  const { window } = dom;
  window.eval('switchPanel("tools")');
  (window.document.getElementById('new-session-btn') as HTMLElement).click();
  expect(commands).toContainEqual({ type: 'new_session' });
  window.eval('handleServerMessage({type:"connection_status", status:"connected"})');
  window.eval('handleRpcEvent({type:"ready", session_id:"new-session", capabilities:{}})');
  expect(window.document.querySelector<HTMLElement>('.input-area')?.style.display).not.toBe('none');
  expect(window.document.querySelector('#messages-container .welcome-message h1')?.textContent).toBe('今天想一起完成什么？');
});

it('preserves prompt mode and IME/Shift+Enter behavior in the rearranged composer', () => {
  const { window } = dom;
  const input = window.document.getElementById('message-input') as HTMLTextAreaElement;
  const mode = window.document.getElementById('mode-selector') as HTMLSelectElement;
  expect([...mode.options].map(option => option.value)).toEqual(['quick', 'standard', 'long_task']);
  mode.value = 'quick';
  mode.dispatchEvent(new window.Event('change'));
  input.value = '分析财报';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  expect(commands).toEqual([]);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(commands).toContainEqual({ type: 'rpc_command', command: { type: 'prompt', text: '分析财报', mode: 'quick' } });
});

it('freezes a resumed send and dispatches its original text, files and mode exactly once', () => {
  const { window } = dom;
  window.eval(`Object.assign(window.__state, {
    sessionId: "history", isReadOnly: true, conversationMode: "standard",
    uploadedFiles: [{path:"/workspace/original.pdf",name:"original.pdf",size:12}]
  })`);
  window.eval('sendPrompt("original question")');
  expect(commands.filter(item => (item.command as any)?.type === 'resume_session')).toEqual([
    { type: 'rpc_command', command: { type: 'resume_session', session_id: 'history', mode: 'standard' } },
  ]);
  window.eval(`window.__state.conversationMode = "quick";
    window.__state.uploadedFiles = [{path:"/workspace/replaced.txt",name:"replaced.txt",size:1}];
    document.getElementById("message-input").value = "next draft";`);
  window.eval('handleRpcEvent({type:"ready",session_id:"history",_resumed:true,mode:"quick",capabilities:{}})');
  window.eval('handleRpcEvent({type:"ready",session_id:"history",_resumed:true,mode:"quick",capabilities:{}})');
  expect(commands.filter(item => (item.command as any)?.type === 'prompt')).toEqual([
    { type: 'rpc_command', command: {
      type: 'prompt',
      text: '[attached files: /workspace/original.pdf]\noriginal question',
      mode: 'standard',
    } },
  ]);
  expect((window.document.getElementById('message-input') as HTMLTextAreaElement).value).toBe('next draft');
  expect(window.eval('window.__state.uploadedFiles.map(file => file.path)')).toEqual(['/workspace/replaced.txt']);
});

it('restores read-only history and preserves the composer when resume fails', () => {
  const { window } = dom;
  const input = window.document.getElementById('message-input') as HTMLTextAreaElement;
  input.value = 'keep this draft';
  window.eval(`Object.assign(window.__state, {
    sessionId: "missing", isReadOnly: true, conversationMode: "standard",
    uploadedFiles: [{path:"/workspace/keep.pdf",name:"keep.pdf",size:12}]
  })`);
  window.eval('sendPrompt("keep this draft")');
  window.eval('handleRpcEvent({type:"error",command_type:"resume_session",error:"Session not found"})');
  expect(window.eval('window.__state.isReadOnly')).toBe(true);
  expect(window.eval('window.__state.sessionTransition')).toBeNull();
  expect(window.eval('window.__state.uploadedFiles[0].path')).toBe('/workspace/keep.pdf');
  expect(input.value).toBe('keep this draft');
  expect(commands.some(item => (item.command as any)?.type === 'prompt')).toBe(false);
});

it('blocks Quick attachments without changing mode or clearing the draft', () => {
  const { window } = dom;
  const input = window.document.getElementById('message-input') as HTMLTextAreaElement;
  input.value = 'read the attachment';
  window.eval(`Object.assign(window.__state, {
    conversationMode: "quick",
    uploadedFiles: [{path:"/workspace/input.pdf",name:"input.pdf",size:12}]
  })`);
  (window.document.getElementById('send-btn') as HTMLElement).click();
  expect(commands.some(item => (item.command as any)?.type === 'prompt')).toBe(false);
  expect(input.value).toBe('read the attachment');
  expect(window.eval('window.__state.uploadedFiles.length')).toBe(1);
  expect(window.eval('window.__state.conversationMode')).toBe('quick');
  expect(window.document.getElementById('messages-container')?.textContent).toContain('请切换到 Standard');
});

it('consumes state.mode and restores refreshed history only after a reconnected run is idle', () => {
  const { window } = dom;
  window.eval('handleRpcEvent({type:"state",session_id:"business",model:"m",mode:"long_task"})');
  expect(window.eval('window.__state.conversationMode')).toBe('long_task');
  commands.length = 0;
  window.eval(`Object.assign(window.__state, {restoringPageConnection:true,reconnectTarget:"connection",pendingHistoryReplay:false});
    handleRpcEvent({type:"ready",session_id:"business",mode:"long_task",_reconnect:true,_web_connection_id:"connection",_web_busy:true,capabilities:{}})`);
  expect(commands.some(item => (item.command as any)?.type === 'switch_session')).toBe(false);
  window.eval('handleRpcEvent({type:"agent_end",session_id:"business",_web_busy:false})');
  expect(commands.filter(item => (item.command as any)?.type === 'switch_session')).toEqual([
    { type: 'rpc_command', command: { type: 'switch_session', session_id: 'business', read_only: true } },
  ]);
});

it('does not let the reconnect socket temporary child cancel page recovery', () => {
  const { window } = dom;
  commands.length = 0;
  window.eval(`Object.assign(window.__state, {
    webConnectionId: "stable", reconnectTarget: "stable", restoringPageConnection: true,
    pendingHistoryReplay: false, provisionalReconnectReady: null, sessionId: null,
    conversationMode: "standard"
  })`);
  window.eval(`handleRpcEvent({
    type:"ready",session_id:"temporary",mode:"quick",_web_connection_id:"temporary",capabilities:{}
  })`);
  expect(window.eval('window.__state.webConnectionId')).toBe('stable');
  expect(window.eval('window.__state.restoringPageConnection')).toBe(true);
  expect(window.eval('window.__state.sessionId')).toBeNull();
  expect(window.eval('window.__state.conversationMode')).toBe('standard');
  expect(commands).toEqual([]);

  window.eval(`handleRpcEvent({
    type:"ready",session_id:"business",mode:"long_task",_reconnect:true,
    _web_connection_id:"stable",_web_busy:true,capabilities:{}
  })`);
  expect(window.eval('window.__state.sessionId')).toBe('business');
  expect(window.eval('window.__state.restoringPageConnection')).toBe(false);
  expect(window.eval('window.__state.pendingHistoryReplay')).toBe(true);
});

it('accepts the explicitly marked fresh-session fallback after reconnect failure', () => {
  const { window } = dom;
  window.eval(`Object.assign(window.__state, {
    webConnectionId: "stale", reconnectTarget: "stale", restoringPageConnection: true,
    pendingHistoryReplay: false, provisionalReconnectReady: null, sessionId: null
  }); handleRpcEvent({
    type:"ready",session_id:"fresh",mode:null,_web_connection_id:"fresh",
    _web_reconnect_fallback:true,_web_busy:false,capabilities:{}
  })`);
  expect(window.eval('window.__state.webConnectionId')).toBe('fresh');
  expect(window.eval('window.__state.sessionId')).toBe('fresh');
  expect(window.eval('window.__state.restoringPageConnection')).toBe(false);
  expect(window.eval('window.__state.pendingHistoryReplay')).toBe(false);
});
