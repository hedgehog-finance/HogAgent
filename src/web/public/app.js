/**
 * HogAgent Web UI Client
 *
 * Manages WebSocket connection, renders chat messages, provides
 * session/skills/extensions navigation, LLM provider-model linkage,
 * and responsive sidebar collapse.
 */

// ─── WebUI Authentication ────────────────────────────────────────────────────

const WEB_AUTH_RELOAD_KEY = 'hogagent_web_auth_reload_failures';
const WEB_AUTH_RELOAD_WINDOW_MS = 60_000;
const webAuthMeta = document.querySelector('meta[name="hogagent-web-token"]');
const webAuthToken = webAuthMeta?.getAttribute('content') || '';
let webAuthReloading = false;
webAuthMeta?.remove();

function readWebAuthExpiry(token) {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return 0;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const claims = JSON.parse(atob(normalized + padding));
    return Number.isFinite(claims.exp) ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function showWebAuthError() {
  if (document.getElementById('web-auth-error')) return;
  const error = document.createElement('div');
  error.id = 'web-auth-error';
  error.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.92);color:#fff;font:16px/1.5 system-ui,sans-serif;padding:24px;text-align:center';
  error.textContent = 'WebUI authentication failed repeatedly. Restart HogAgent WebUI, then refresh this page.';
  document.body.appendChild(error);
}

function reloadForWebAuthFailure() {
  if (webAuthReloading) return;
  const now = Date.now();
  let failures = [];
  try {
    failures = JSON.parse(sessionStorage.getItem(WEB_AUTH_RELOAD_KEY) || '[]')
      .filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < WEB_AUTH_RELOAD_WINDOW_MS);
  } catch {
    failures = [];
  }
  if (failures.length >= 2) {
    showWebAuthError();
    return;
  }
  failures.push(now);
  sessionStorage.setItem(WEB_AUTH_RELOAD_KEY, JSON.stringify(failures));
  webAuthReloading = true;
  window.location.reload();
}

async function authenticatedFetch(input, init = {}) {
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('Authorization', `Bearer ${webAuthToken}`);
  const response = await window.fetch(input, { ...init, headers });
  if (response.status === 401) reloadForWebAuthFailure();
  return response;
}

async function handleWebSocketHandshakeFailure() {
  if (webAuthExpiry <= Date.now()) {
    reloadForWebAuthFailure();
    return;
  }
  try {
    const probe = await authenticatedFetch('/api/themes');
    if (probe.status === 401) return;
    // The HTTP server is reachable and accepted the same token, so a rejected
    // WebSocket handshake is most likely an Origin/auth configuration failure.
    reloadForWebAuthFailure();
    return;
  } catch {
    // A stopped server is a connection failure, not proof that the token failed.
  }
  attemptReconnect();
}

const webAuthExpiry = readWebAuthExpiry(webAuthToken);
if (!webAuthExpiry || webAuthExpiry <= Date.now()) {
  reloadForWebAuthFailure();
} else {
  setTimeout(reloadForWebAuthFailure, Math.max(0, webAuthExpiry - Date.now() + 50));
}

// ─── i18n Engine ──────────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ar', label: 'العربية' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
];

let currentLang = localStorage.getItem('hogagent_lang') || 'zh-CN';
const i18nCache = {};

async function loadTranslations(lang) {
  if (i18nCache[lang]) return i18nCache[lang];
  try {
    const resp = await fetch(`/i18n/${lang}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    i18nCache[lang] = await resp.json();
    return i18nCache[lang];
  } catch (err) {
    console.error(`Failed to load translations for ${lang}:`, err);
    if (lang !== 'en') return loadTranslations('en');
    return {};
  }
}

function t(key, params) {
  const keys = key.split('.');
  let val = i18nCache[currentLang];
  for (const k of keys) { val = val?.[k]; }
  if (val === undefined && currentLang !== 'en') {
    val = i18nCache['en'];
    for (const k of keys) { val = val?.[k]; }
  }
  if (val === undefined) return key;
  if (params) {
    for (const [pk, pv] of Object.entries(params)) {
      val = val.replace(new RegExp(`\\{\\{${pk}\\}\\}`, 'g'), pv);
    }
  }
  return val;
}

// ─── Theme System ──────────────────────────────────────────────────────────────

const THEMES = [
  { key: 'fintech',   label: 'FinTech' },
  { key: 'oldmoney',  label: 'Old Money' },
  { key: 'bloomberg', label: 'Bloomberg' },
  { key: 'economist', label: 'Economist' },
  { key: 'saas',      label: 'SaaS' },
  { key: 'mist',      label: 'Mist' },
  { key: 'twilight',  label: 'Twilight' },
  { key: 'parchment', label: 'Parchment' },
  { key: 'azure',     label: 'Azure' },
  { key: 'gravel',    label: 'Gravel' },
];

// Theme color palettes for preview tooltips
const THEME_PALETTES = {
  fintech:   { primary: '#1D4ED8', bg: '#F8FAFC', text: '#1E293B', userBubble: '#1D4ED8', assistantBubble: '#F1F5F9', border: '#CBD5E1' },
  oldmoney:  { primary: '#0A2540', bg: '#FFFFFF', text: '#1A2332', userBubble: '#0A2540', assistantBubble: '#F7F8FA', border: '#D1D5DB' },
  bloomberg: { primary: '#10B981', bg: '#09090B', text: '#E4E4E7', userBubble: '#10B981', assistantBubble: '#18181B', border: '#3F3F46' },
  economist: { primary: '#0F2B5B', bg: '#F6F4F0', text: '#2D2A26', userBubble: '#0F2B5B', assistantBubble: '#EDEAE3', border: '#D4CFC4' },
  saas:      { primary: '#635BFF', bg: '#FFFFFF', text: '#1A1A2E', userBubble: '#635BFF', assistantBubble: '#F0EEF8', border: '#D8D6E8' },
  mist:      { primary: '#64748B', bg: '#F1F5F9', text: '#1E293B', userBubble: '#64748B', assistantBubble: '#E2E8F0', border: '#94A3B8' },
  twilight:  { primary: '#776B87', bg: '#F5F3F7', text: '#2D2438', userBubble: '#776B87', assistantBubble: '#EAE6EE', border: '#C0B5CE' },
  parchment: { primary: '#947E70', bg: '#F5F2EB', text: '#3A322B', userBubble: '#947E70', assistantBubble: '#EAE5D9', border: '#C4B1A3' },
  azure:     { primary: '#5E7B9E', bg: '#EAF2F8', text: '#1E2D3D', userBubble: '#5E7B9E', assistantBubble: '#D8E7F2', border: '#9BB1CD' },
  gravel:    { primary: '#73716D', bg: '#F0EFEA', text: '#2D2B28', userBubble: '#73716D', assistantBubble: '#E4E3DD', border: '#A9A7A2' },
};

const DEFAULT_THEME = 'fintech';
let currentTheme = DEFAULT_THEME;

function applyTheme(themeKey) {
  currentTheme = themeKey || DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', currentTheme);
}

async function loadUserTheme() {
  try {
    const resp = await authenticatedFetch(`/api/user-theme?user=${encodeURIComponent(state.user)}`);
    if (resp.ok) {
      const data = await resp.json();
      const themeKey = data.theme || DEFAULT_THEME;
      applyTheme(themeKey);
      const themeSelector = document.getElementById('theme-selector');
      if (themeSelector) themeSelector.value = themeKey;
    } else {
      applyTheme(DEFAULT_THEME);
    }
  } catch {
    applyTheme(DEFAULT_THEME);
  }
}

async function saveUserTheme(themeKey) {
  try {
    await authenticatedFetch('/api/user-theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: state.user, theme: themeKey }),
    });
  } catch (err) {
    console.error('Failed to save theme:', err);
  }
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text !== key) el.textContent = text;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const text = t(key);
    if (text !== key) { el.title = text; el.setAttribute('aria-label', text); }
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const text = t(key);
    if (text !== key) el.placeholder = text;
  });
  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-label');
    const text = t(key);
    if (text !== key) el.label = text;
  });
}

async function changeLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('hogagent_lang', lang);
  await loadTranslations(lang);
  if (lang !== 'en') await loadTranslations('en');
  applyI18n();
  updateChatTitle();
  updateIndicators();
  updateModeHint(state.conversationMode);
  syncSidebarAccessibility();
}

// ─── DOM Elements ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const messagesContainer = $("messages-container");
const messageInput = $("message-input");
const sendBtn = $("send-btn");
const abortBtn = $("abort-btn");
const compactBtn = $("compact-btn");
const newSessionBtn = $("new-session-btn");
const settingsBtn = $("settings-btn");
const settingsModal = $("settings-modal");
const closeSettingsBtn = $("close-settings");
const saveSettingsBtn = $("save-settings");
const modelSelect = $("model-select");
const thinkingLevelInput = $("thinking-level");
const modelIndicator = $("model-indicator");
const composerModelPanel = $("composer-model-panel");
const composerModelSelect = $("composer-model-select");
const composerThinkingInput = $("composer-thinking-level");
const composerModelStatus = $("composer-model-status");
const applyComposerModelBtn = $("apply-composer-model");
const capabilitiesContainer = $("capabilities");
const welcomeMessage = messagesContainer.querySelector(".welcome-message");
const sidebar = $("sidebar");
const sidebarToggle = $("sidebar-toggle");
const sidebarNav = $("sidebar-nav");
const providerSelect = $("provider-select");
const apiKeyInput = $("api-key-input");
const baseUrlInput = $("base-url-input");
const modelHint = $("model-hint");
const sidebarCollapseBtn = $("sidebar-collapse-btn");
const currentProviderValue = $("current-provider-value");
const skillsList = $("skills-list");
const extensionsList = $("extensions-list");
const refreshModelsBtn = $("refresh-models-btn");
const modelRefreshStatus = $("model-refresh-status");
const testApiKeyBtn = $("test-api-key-btn");
const apiKeyStatus = $("api-key-status");
const skillGitUrlInput = $("skill-git-url");
const installSkillBtn = $("install-skill-btn");
const skillConfigModal = $("skill-config-modal");
const skillConfigTitle = $("skill-config-title");
const skillConfigBody = $("skill-config-body");
const closeSkillConfigBtn = $("close-skill-config");
const saveSkillConfigBtn = $("save-skill-config");
const uploadBtn = $("upload-btn");
const fileInput = $("file-input");
const uploadPreview = $("upload-preview");
const dragOverlay = $("drag-overlay");
const skillBtn = $("skill-btn");
const skillMenu = $("skill-menu");
const skillSubmenu = $("skill-submenu");
const skillDropdown = $("skill-dropdown");
const themeTooltip = $("theme-preview-tooltip");
const slashAutocomplete = $("slash-autocomplete");
const modeSelector = $("mode-selector");
const modeHint = $("mode-hint");
const searchProviderSelect = $("search-provider-select");
const searchFieldsContainer = $("search-fields-container");
const currentSearchProviderValue = $("current-search-provider-value");
const mcpServerList = $("mcp-server-list");
const addMcpServerBtn = $("add-mcp-server");
const reloadMcpServersBtn = $("reload-mcp-servers");
const mcpSettingsStatus = $("mcp-settings-status");

// Mode hint i18n keys per mode
const MODE_HINT_KEYS = { quick: "chat.quickHint", standard: "chat.standardHint", long_task: "chat.longtaskHint" };
function updateModeHint(mode) {
  if (!modeHint) return;
  const key = MODE_HINT_KEYS[mode];
  if (key) {
    modeHint.textContent = t(key);
    modeHint.setAttribute("data-i18n", key);
  }
}

// Audit model DOM references
const auditProviderSelect = $("audit-provider-select");
const auditBaseUrlInput = $("audit-base-url-input");
const auditApiKeyInput = $("audit-api-key-input");
const auditModelSelect = $("audit-model-select");
const auditMinScore = $("audit-min-score");
const auditScoreValue = $("audit-score-value");
const auditMaxIterations = $("audit-max-iterations");
const refreshAuditModelsBtn = $("refresh-audit-models-btn");
const customModelInput = $("custom-model-input");
const customAuditModelInput = $("custom-audit-model-input");
const auditModelRefreshStatus = $("audit-model-refresh-status");

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  ws: null,
  connected: false,
  user: "default",
  sessionId: null,
  webConnectionId: null,
  reconnectTarget: null,
  restoringPageConnection: false,
  pendingHistoryReplay: false,
  provisionalReconnectReady: null,
  currentModel: null,
  currentThinkingLevel: "medium",
  currentProvider: "hedgehog",
  currentBaseUrl: "",
  currentApiKey: "",
  capabilities: null,
  messages: [],
  followLatestMessages: true,
  streamingMessageId: null,
  pendingAuthoritativeMessageId: null, // Last completed bubble awaiting structured turn_end correction
  streamingThinkingId: null,  // ID of the thinking content element
  thinkingIndicatorId: null,  // ID of the "thinking..." indicator element
  isBusy: false,  // True while agent is processing a request
  isCompacting: false, // Runtime-only context compaction lifecycle
  creatingSessionId: null,  // ID of "creating session..." status message
  currentSessionTitle: null,  // Auto-generated title for current session
  pendingToolCalls: new Map(),
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  activePanel: "chat",
  sidebarCollapsed: false,
  skillsData: [],       // Full skill info from server
  providerModels: {},   // Cache: provider → model list
  uploadedFiles: [],    // Array of { path, name, size }
  selectedSkill: null,  // { skill: string, theme?: string } or null
  conversationMode: "standard",  // "quick" | "standard" | "long_task"
  hasSentFirstMessage: false,
  needsNewSession: false,  // True when user clicked "new session" but hasn't sent first message yet
  awaitingNewSession: false, // True while new session is being created — blocks old session events
  pendingNewSessionUI: false,  // True after clicking "new session" — clears old UI on ready event
  pendingSend: null,         // Frozen { text, files, mode } waiting for a session transition
  sessionTransition: null,   // "new" | "resume" while a single transition owns pendingSend
  currentThinkingSection: null, // ID of current collapsible thinking section
  internalMode: false,         // True during Long Task / audit — messages go to thinking section
  isReadOnly: false,           // True after switch_session — auto-resumes on send
  allProviderConfigs: {},   // Cache: provider → { field_key: value } for all saved providers
  providerApiKeys: {},      // Cache: provider → api_key for all saved provider API keys
  auditConfigured: false,    // True when audit LLM is configured (from _serverInit or user save)
  auditUserModified: false,  // True when user touched audit fields in current settings modal session
  auditSettings: {},        // Last confirmed audit configuration, separate from form drafts
  pendingLlmSettings: null,  // Submitted values applied to UI state after settings_saved
  usageLog: [],             // Per-turn usage records: [{ turn, input, output, cacheRead, cacheWrite, totalTokens, cost }]
  usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 },
  subAgentUsage: [],        // Per-sub-agent stats: [{ id, status, input, output, cacheRead, cacheWrite, totalTokens }]; live-captured and restored on session switch
    auditUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, // Audit LLM cumulative usage
  turnCount: 0,             // Current turn counter (reset per session)
  mcpConfig: { schemaVersion: 1, servers: [] },
  mcpEffectiveViews: [],
  mcpCatalogs: {},
  pendingMcpProbe: null,
  mcpRequestCounter: 0,
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_LABELS = { off: "thinkingOff", minimal: "thinkingMin", low: "thinkingLow", medium: "thinkingMid", high: "thinkingHigh", xhigh: "thinkingExtreme" };
const composerModelState = { requestId: 0, target: null, scope: null, models: [], loaded: false, thinkingLevels: ["off"] };

const PROVIDER_DEFAULTS = {
  hedgehog: { baseUrl: "https://api.ciweiai.com/api/llm/v1", modelId: "qwen3.8-flash" },
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  deepseek: { baseUrl: "https://api.deepseek.com" },
  mistral: { baseUrl: "https://api.mistral.ai/v1" },
  xai: { baseUrl: "https://api.x.ai/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  custom: { baseUrl: "" },
};

const FALLBACK_MODELS = [
  { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", contextWindow: 500000 },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 500000 },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 500000 },
  { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1047576 },
  { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1048576 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1048576 },
  { id: "deepseek-r1", name: "DeepSeek R1", contextWindow: 65536 },
  { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 65536 },
];

const SEARCH_PROVIDER_FIELDS = {
  brave:      [{ key: "api_key", label: "API Key", type: "password", placeholder: "Enter Brave Search API Key" }],
  you:        [{ key: "api_key", label: "API Key", type: "password", placeholder: "Enter You.com API Key" }],
  tavily:     [{ key: "api_key", label: "API Key", type: "password", placeholder: "Enter Tavily API Key" }],
  serpapi:    [{ key: "api_key", label: "API Key", type: "password", placeholder: "Enter SerpAPI Key" }],
  bing:       [{ key: "api_key", label: "API Key", type: "password", placeholder: "Enter Bing Search Key" }],
  google:     [
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter Google API Key" },
    { key: "cx", label: "Custom Search Engine ID (CX)", type: "text", placeholder: "Enter CX ID" },
  ],
  custom:     [
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter API Key" },
    { key: "endpoint", label: "Search API Endpoint", type: "text", placeholder: "https://your-search-api.com/search" },
  ],
  bocha:      [
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter Bocha API Key" },
    { key: "endpoint", label: "Endpoint (optional)", type: "text", placeholder: "Leave empty for default" },
    { key: "freshness", label: "Freshness (optional)", type: "select",
      options: [
        { value: "noLimit", label: "No limit" },
        { value: "oneDay", label: "Past day" },
        { value: "oneWeek", label: "Past week" },
        { value: "oneMonth", label: "Past month" },
        { value: "oneYear", label: "Past year" },
      ], default: "noLimit" },
    { key: "categories", label: "Categories (optional, comma-separated)", type: "text", placeholder: "e.g. finance,technology" },
  ],
  metaso:     [
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter Metaso API Key" },
    { key: "mode", label: "Search mode (optional)", type: "select",
      options: [
        { value: "simple", label: "Simple" },
        { value: "deep", label: "Deep" },
        { value: "research", label: "Research" },
      ], default: "simple" },
    { key: "range", label: "Search scope (optional)", type: "select",
      options: [
        { value: "all_web", label: "All web" },
        { value: "academic", label: "Academic" },
      ], default: "all_web" },
    { key: "endpoint", label: "Endpoint (optional)", type: "text", placeholder: "Leave empty for default" },
  ],
  zhipu:      [
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter Zhipu API Key" },
    { key: "model", label: "Model (optional)", type: "text", placeholder: "Default: glm-4-flash" },
    { key: "base_url", label: "Base URL (optional)", type: "text", placeholder: "Leave empty for default" },
  ],
  volcengine: [
    { key: "api_key", label: "API Key", type: "password", placeholder: "Enter Volcengine API Key" },
    { key: "model", label: "Model (optional)", type: "text", placeholder: "Default: doubao-pro-latest" },
    { key: "endpoint", label: "Endpoint (optional)", type: "text", placeholder: "Leave empty for default" },
  ],
};

// ─── Markdown Renderer ────────────────────────────────────────────────────────

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/```([\w]*)(?:\n|$)([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="language-${lang || "text"}">${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/~~(.*?)~~/g, "<del>$1</del>");
  html = html.replace(/^\> (.*$)/gim, "<blockquote>$1</blockquote>");
  html = html.replace(/^(\s*)[-*] (.*$)/gim, (_, indent, content) => `${indent}<li>${content}</li>`);
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function updateActivityControls() {
  const transitioning = state.sessionTransition !== null;
  newSessionBtn.disabled = !state.connected || state.awaitingNewSession || state.pendingNewSessionUI || transitioning;
  sendBtn.disabled = !state.connected || state.isBusy || state.isCompacting || transitioning;
  abortBtn.disabled = !state.isBusy || state.isCompacting;
  compactBtn.disabled = !state.connected || state.isBusy || state.isCompacting || state.isReadOnly;
  if (uploadBtn) uploadBtn.disabled = !state.connected || state.isBusy || state.isCompacting || transitioning;
  if (modeSelector) modeSelector.disabled = transitioning;
  updateComposerModelControls();
}

function setConnectionStatus(status) {
  state.connected = status === "connected";
  if (!state.connected) {
    state.isCompacting = false;
    resetPendingSettings(t('chat.disconnected'));
    closeComposerModelPanel();
  }
  const sessionStatus = document.querySelector('.session-item.active .session-status');
  if (sessionStatus) {
    sessionStatus.textContent = state.connected ? t('chat.connected') : t('chat.disconnected');
    sessionStatus.className = `session-status ${state.connected ? 'connected' : 'disconnected'}`;
  }
  updateActivityControls();
  loadSessionList();
}

function updateIndicators() {
  modelIndicator.textContent = `${state.currentModel || t("chat.model")} · ${state.currentThinkingLevel}`;
  modelIndicator.title = `${t("settings.quickModel")} · ${modelIndicator.textContent}`;
  modelIndicator.setAttribute("aria-label", modelIndicator.title);
  if (!composerModelPanel.hidden && composerModelState.scope !== currentModelScope()) closeComposerModelPanel();
}

function updateCurrentProviderDisplay() {
  if (!currentProviderValue) return;
  const provider = state.currentProvider || "unknown";
  const baseUrl = state.currentBaseUrl || "";
  let text = provider;
  if (baseUrl) {
    try { text += ` · ${new URL(baseUrl).hostname}`; } catch { text += ` · ${baseUrl}`; }
  }
  currentProviderValue.textContent = text;
}

messagesContainer.addEventListener("scroll", () => {
  // Allow only rounding tolerance: reading above the bottom pauses following.
  state.followLatestMessages = messagesContainer.scrollHeight - messagesContainer.clientHeight - messagesContainer.scrollTop <= 2;
}, { passive: true });

function autoScroll() {
  if (state.followLatestMessages) messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function createElement(tag, className = "", innerHTML = "") {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (innerHTML) el.innerHTML = innerHTML;
  return el;
}

function addMessage(role, content, id = null) {
  const messageId = id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const messageEl = createElement("div", `message ${role}`);
  messageEl.dataset.id = messageId;
  messageEl.appendChild(createElement("div", "message-meta", role === "user" ? t('chat.you') : "HogAgent"));
  messageEl.appendChild(createElement("div", "message-content", renderMarkdown(content)));
  messagesContainer.appendChild(messageEl);
  autoScroll();
  state.messages.push({ id: messageId, role, content });
  return messageId;
}

function updateMessage(messageId, delta) {
  const messageEl = messagesContainer.querySelector(`[data-id="${messageId}"]`);
  if (!messageEl) return;
  const contentEl = messageEl.querySelector(".message-content");
  const existing = state.messages.find((m) => m.id === messageId);
  if (existing) {
    existing.content += delta;
    contentEl.innerHTML = renderMarkdown(existing.content);
    autoScroll();
  }
}

function replaceMessageContent(messageId, content) {
  const messageEl = messagesContainer.querySelector(`[data-id="${messageId}"]`);
  const existing = state.messages.find((m) => m.id === messageId);
  if (!messageEl || !existing) return;

  if (typeof content !== "string" || !content.trim()) {
    messageEl.remove();
    state.messages = state.messages.filter((m) => m.id !== messageId);
    return;
  }

  const contentEl = messageEl.querySelector(".message-content");
  if (!contentEl) return;
  existing.content = content;
  contentEl.innerHTML = renderMarkdown(content);
  autoScroll();
}

// ─── Thinking Block ──────────────────────────────────────────────────────────

function addThinkingBlock() {
  const thinkingId = `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const thinkingEl = createElement("div", "thinking-block");
  thinkingEl.id = thinkingId;
  thinkingEl.innerHTML = `
    <div class="thinking-header">
      <span class="thinking-icon">💭</span>
      <span class="thinking-title">${t('chat.thinkingProcess')}</span>
      <span class="thinking-toggle">▼</span>
    </div>
    <div class="thinking-content"></div>
  `;
  // Add click handler to toggle collapse
  const header = thinkingEl.querySelector(".thinking-header");
  header.addEventListener("click", () => {
    thinkingEl.classList.toggle("collapsed");
    const toggle = thinkingEl.querySelector(".thinking-toggle");
    toggle.textContent = thinkingEl.classList.contains("collapsed") ? "▶" : "▼";
  });
  messagesContainer.appendChild(thinkingEl);
  autoScroll();
  return thinkingId;
}

function updateThinkingBlock(thinkingId, delta) {
  const thinkingEl = document.getElementById(thinkingId);
  if (!thinkingEl) return;
  const contentEl = thinkingEl.querySelector(".thinking-content");
  const existing = contentEl.textContent || "";
  contentEl.textContent = existing + delta;
  autoScroll();
}

function addToolActivity(toolCallId, toolName, args, status = "running") {
  const existing = document.getElementById(toolCallId);
  if (existing) {
    existing.querySelector(".tool-status").textContent = status === "running" ? t('common.running') + '...' : status;
    existing.querySelector(".tool-status").className = `tool-status ${status}`;
    return;
  }
  const toolEl = createElement("div", "tool-activity");
  toolEl.id = toolCallId;
  const headerEl = createElement("div", "tool-header");
  headerEl.innerHTML = `<span class="tool-name">🔧 ${escapeHtml(toolName || t('common.tool'))}</span>
    <span class="tool-status ${status}">${status === "running" ? t('common.running') + '...' : status}</span>`;
  headerEl.addEventListener("click", () => toolEl.classList.toggle("open"));
  const bodyEl = createElement("div", "tool-body");
  bodyEl.innerHTML = `<pre>${escapeHtml(JSON.stringify(args || {}, null, 2))}</pre>`;
  toolEl.appendChild(headerEl);
  toolEl.appendChild(bodyEl);
  messagesContainer.appendChild(toolEl);
  autoScroll();
}

function updateToolStatus(toolCallId, status) {
  const toolEl = document.getElementById(toolCallId);
  if (!toolEl) return;
  const statusEl = toolEl.querySelector(".tool-status");
  statusEl.className = `tool-status ${status}`;
  statusEl.textContent = status === "running" ? t('common.running') + '...' : status;
}

function addStatusMessage(text, withSpinner = false) {
  const id = `status-${Date.now()}`;
  const el = createElement("div", "status-message");
  el.id = id;
  el.innerHTML = withSpinner
    ? `<div class="spinner"></div><span>${escapeHtml(text)}</span>`
    : escapeHtml(text);
  messagesContainer.appendChild(el);
  autoScroll();
  return id;
}

function addWarningMessage(text) {
  if (!text) return;
  const el = createElement("div", "warning-message");
  el.style.cssText = 'padding:8px 12px;margin:6px 0;font-size:13px;color:#e8a040;background:#2a2520;border-radius:8px;border-left:3px solid #e8a040;';
  el.textContent = '⚠️ ' + text;
  messagesContainer.appendChild(el);
  autoScroll();
}

function removeStatusMessage(id) { const el = document.getElementById(id); if (el) el.remove(); }
function clearWelcomeMessage() { const w = messagesContainer.querySelector(".welcome-message"); if (w) w.remove(); }

function renderCapabilities(capabilities) {
  if (!capabilities) return;
  const items = [];
  if (capabilities.installed_skills?.length) items.push(`${t('nav.skills')}: ${capabilities.installed_skills.length}`);
  if (capabilities.builtin_tools?.length) items.push(`${t('nav.tools')}: ${capabilities.builtin_tools.length}`);
  if (capabilities.extensions?.length) items.push(`${t('nav.extensions')}: ${capabilities.extensions.length}`);
  if (capabilities.supports_compaction) items.push(t('chat.contextCompression'));
  if (capabilities.supports_sub_agent) items.push(t('chat.subAgent'));
  capabilitiesContainer.innerHTML = items.map((i) => `<span class="capability">${escapeHtml(i)}</span>`).join("");
}

// ─── Thinking Section Helper ─────────────────────────────────────────────────

/**
 * Append text to the current collapsible thinking section, creating one if needed.
 * Used during internal_mode to show audit/orchestration process.
 */
function appendThinkingSection(text, title) {
  let section = state.currentThinkingSection;
  if (!section || !document.getElementById(section)) {
    const id = `thinking-${Date.now()}`;
    const el = document.createElement("div");
    el.id = id;
    el.className = "thinking-section";
    el.innerHTML = `<div class="thinking-section-header"><span class="thinking-section-arrow">▶</span><span>${title || t('chat.thinkingProcess')}</span></div><div class="thinking-section-body"></div>`;
    el.querySelector(".thinking-section-header").addEventListener("click", () => {
      el.classList.toggle("expanded");
    });
    messagesContainer.appendChild(el);
    autoScroll();
    state.currentThinkingSection = id;
    section = id;
  }
  const body = document.querySelector(`#${section} .thinking-section-body`);
  if (body) {
    body.textContent += (body.textContent ? "" : "") + text;
    body.scrollTop = body.scrollHeight;
  }
}

// ─── Search Settings ─────────────────────────────────────────────────────────────

function renderSearchFields(providerName) {
  if (!searchFieldsContainer) return;
  const fields = SEARCH_PROVIDER_FIELDS[providerName] || [];
  searchFieldsContainer.innerHTML = "";

  // Get saved config for this provider from cache
  const savedConfig = state.allProviderConfigs[providerName] || {};

  for (const field of fields) {
    const group = document.createElement("div");
    group.className = "setting-group";
    group.dataset.fieldKey = field.key;

    const label = document.createElement("label");
    label.textContent = field.label;
    label.setAttribute("for", `search-field-${field.key}`);
    group.appendChild(label);

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      input.id = `search-field-${field.key}`;
      for (const opt of field.options) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        input.appendChild(option);
      }
      // Use saved value, or default, or field.default
      if (savedConfig[field.key] !== undefined) {
        input.value = String(savedConfig[field.key]);
      } else if (field.default) {
        input.value = field.default;
      }
    } else {
      input = document.createElement("input");
      input.type = field.type;  // "text" or "password"
      input.id = `search-field-${field.key}`;
      if (field.placeholder) input.placeholder = field.placeholder;
      input.className = "skill-git-input";
      // Use saved value if available
      if (savedConfig[field.key] !== undefined) {
        input.value = String(savedConfig[field.key]);
      }
    }
    input.autocomplete = "off";
    group.appendChild(input);

    searchFieldsContainer.appendChild(group);
  }
}

async function loadSearchSettings() {
  try {
    const resp = await authenticatedFetch("/api/search-settings");
    const data = await resp.json();
    const settings = data.settings || {};
    const provider = settings.provider || "brave";
    const activeProvider = settings.active_provider || provider;

    // Cache all provider configs
    state.allProviderConfigs = {};
    const providers = settings.providers || {};
    for (const [pName, pConfig] of Object.entries(providers)) {
      state.allProviderConfigs[pName] = { ...pConfig };
    }

    // Set the active provider selector
    const activeProviderSelect = document.getElementById("active-search-provider-select");
    if (activeProviderSelect) activeProviderSelect.value = activeProvider;

    // Set the editing provider selector
    if (searchProviderSelect) searchProviderSelect.value = provider;
    renderSearchFields(provider);

    // Update current provider display
    if (currentSearchProviderValue) {
      currentSearchProviderValue.textContent = activeProvider;
    }
  } catch (err) {
    console.error("Failed to load search settings:", err);
  }
}

async function saveSearchSettings() {
  const provider = searchProviderSelect?.value || "brave";
  const fields = {};
  const fieldDefs = SEARCH_PROVIDER_FIELDS[provider] || [];

  for (const field of fieldDefs) {
    const input = document.getElementById(`search-field-${field.key}`);
    if (input) {
      fields[field.key] = input.value.trim();
    }
  }

  // Update local cache
  state.allProviderConfigs[provider] = { ...fields };

  try {
    const resp = await authenticatedFetch("/api/search-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, fields }),
    });
    const result = await resp.json();
    if (result.error) {
    addStatusMessage(`${t('settings.searchSaveFailed')}: ${result.error}`);
      return;
    }
    if (currentSearchProviderValue) {
      // Show the active provider (which is the one we just saved)
      currentSearchProviderValue.textContent = provider;
    }
    addStatusMessage(`${t('settings.searchSaved')} · ${provider}`);
  } catch (err) {
    addStatusMessage(`${t('settings.searchSaveFailed')}: ${err.message}`);
  }
}

async function setActiveSearchProvider(activeProvider) {
  try {
    const resp = await authenticatedFetch("/api/active-search-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_provider: activeProvider }),
    });
    const result = await resp.json();
    if (result.error) {
      addStatusMessage(`${t('settings.switchSearchFailed')}: ${result.error}`);
      return;
    }
    if (currentSearchProviderValue) {
      currentSearchProviderValue.textContent = activeProvider;
    }
    addStatusMessage(`${t('settings.switchedSearch')} · ${activeProvider}`);
  } catch (err) {
    addStatusMessage(`${t('settings.switchSearchFailed')}: ${err.message}`);
  }
}

// ─── External MCP Settings ────────────────────────────────────────────────────

function nextMcpRequestId() {
  state.mcpRequestCounter += 1;
  return `web-mcp-${Date.now()}-${state.mcpRequestCounter}`;
}

function defaultMcpServer() {
  return {
    name: `external-${state.mcpConfig.servers.length + 1}`,
    description: "",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:3000/mcp", headersFromEnv: {} },
    exposure: { allowedTools: [], directTools: [], resourceUriPrefixes: [], allowedPrompts: [] },
    timeouts: { connectMs: 10000, callMs: 60000, taskForegroundMs: 30000 },
    maxConcurrency: 4,
  };
}

function commaList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseMcpJsonField(value, fallback, label) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error(`${label}: ${t("mcp.validJsonRequired")}`); }
  return parsed;
}

function collectMcpConfig() {
  if (!mcpServerList) return state.mcpConfig;
  const servers = [...mcpServerList.querySelectorAll(".mcp-server-card")].map((card) => {
    const field = (name) => card.querySelector(`[data-mcp-field="${name}"]`);
    // Collect the fields currently rendered before the change handler replaces them.
    const type = card.dataset.transportType;
    const transport = type === "stdio"
      ? {
          type: "stdio",
          command: field("command").value.trim(),
          args: parseMcpJsonField(field("args").value, [], t("mcp.args")),
          ...(field("cwd").value.trim() ? { cwd: field("cwd").value.trim() } : {}),
          envFromHost: parseMcpJsonField(field("envFromHost").value, {}, t("mcp.envMapping")),
        }
      : {
          type: "http",
          url: field("url").value.trim(),
          ...(field("bearerTokenEnv").value.trim() ? { bearerTokenEnv: field("bearerTokenEnv").value.trim() } : {}),
          headersFromEnv: parseMcpJsonField(field("headersFromEnv").value, {}, t("mcp.headerMapping")),
        };
    return {
      name: field("name").value.trim(),
      ...(field("description").value.trim() ? { description: field("description").value.trim() } : {}),
      enabled: field("enabled").checked,
      transport,
      exposure: {
        allowedTools: commaList(field("allowedTools").value),
        directTools: commaList(field("directTools").value),
        resourceUriPrefixes: commaList(field("resourceUriPrefixes").value),
        allowedPrompts: commaList(field("allowedPrompts").value),
      },
      timeouts: {
        connectMs: Number(field("connectMs").value),
        callMs: Number(field("callMs").value),
        taskForegroundMs: Number(field("taskForegroundMs").value),
      },
      maxConcurrency: Number(field("maxConcurrency").value),
    };
  });
  state.mcpConfig = { schemaVersion: 1, servers };
  return state.mcpConfig;
}

function mcpField(label, name, value, options = {}) {
  const group = document.createElement("div");
  group.className = `setting-group${options.wide ? " mcp-wide" : ""}`;
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  group.appendChild(labelEl);
  const input = options.multiline ? document.createElement("textarea") : document.createElement("input");
  if (!options.multiline) input.type = options.type || "text";
  input.dataset.mcpField = name;
  input.value = value ?? "";
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.step !== undefined) input.step = String(options.step);
  input.autocomplete = "off";
  group.appendChild(input);
  if (options.hint) {
    const hint = document.createElement("div");
    hint.className = "setting-hint";
    hint.textContent = options.hint;
    group.appendChild(hint);
  }
  return group;
}

function setCommaValue(input, value, checked) {
  const values = new Set(commaList(input.value));
  if (checked) values.add(value); else values.delete(value);
  input.value = [...values].join(", ");
}

function renderMcpCatalog(card, server, catalog) {
  if (!catalog) return;
  const details = document.createElement("details");
  details.className = "mcp-catalog";
  const summary = document.createElement("summary");
  summary.textContent = `${t("mcp.catalog")} · ${catalog.tools?.length || 0} ${t("mcp.tools")} · ${catalog.resources?.length || 0} ${t("mcp.resources")} · ${catalog.prompts?.length || 0} ${t("mcp.prompts")}`;
  details.appendChild(summary);
  const allowedToolsInput = card.querySelector('[data-mcp-field="allowedTools"]');
  const directToolsInput = card.querySelector('[data-mcp-field="directTools"]');
  const resourceInput = card.querySelector('[data-mcp-field="resourceUriPrefixes"]');
  const promptInput = card.querySelector('[data-mcp-field="allowedPrompts"]');
  const allowedTools = new Set(server.exposure.allowedTools || []);
  const directTools = new Set(server.exposure.directTools || []);
  const resourcePrefixes = new Set(server.exposure.resourceUriPrefixes || []);
  const prompts = new Set(server.exposure.allowedPrompts || []);

  const heading = (text) => {
    const el = document.createElement("div");
    el.className = "setting-hint";
    el.style.marginTop = "8px";
    el.textContent = text;
    details.appendChild(el);
  };
  heading(t("mcp.tools"));
  for (const tool of catalog.tools || []) {
    const row = document.createElement("div");
    row.className = "mcp-capability-row";
    const name = document.createElement("span");
    name.className = "mcp-capability-name";
    name.textContent = tool.name;
    const allow = document.createElement("label");
    const allowBox = document.createElement("input");
    allowBox.type = "checkbox";
    allowBox.checked = allowedTools.has("*") || allowedTools.has(tool.name);
    allow.append(allowBox, ` ${t("mcp.allow")}`);
    const direct = document.createElement("label");
    const directBox = document.createElement("input");
    directBox.type = "checkbox";
    directBox.checked = directTools.has(tool.name);
    direct.append(directBox, ` ${t("mcp.direct")}`);
    allowBox.addEventListener("change", () => {
      setCommaValue(allowedToolsInput, tool.name, allowBox.checked);
      if (!allowBox.checked) { directBox.checked = false; setCommaValue(directToolsInput, tool.name, false); }
    });
    directBox.addEventListener("change", () => {
      if (directBox.checked) { allowBox.checked = true; setCommaValue(allowedToolsInput, tool.name, true); }
      setCommaValue(directToolsInput, tool.name, directBox.checked);
    });
    row.append(name, allow, direct);
    details.appendChild(row);
  }

  heading(t("mcp.resourcesAndTemplates"));
  const resourceEntries = [
    ...(catalog.resources || []).map((item) => ({ name: item.name, value: item.uri })),
    ...(catalog.resourceTemplates || []).map((item) => ({ name: item.name, value: item.uriTemplate.split("{")[0] })),
  ];
  for (const item of resourceEntries) {
    const row = document.createElement("div");
    row.className = "mcp-capability-row";
    const name = document.createElement("span"); name.textContent = `${item.name} · ${item.value}`;
    const allow = document.createElement("label");
    const box = document.createElement("input"); box.type = "checkbox";
    box.checked = resourcePrefixes.has("*") || resourcePrefixes.has(item.value);
    box.addEventListener("change", () => setCommaValue(resourceInput, item.value, box.checked));
    allow.append(box, ` ${t("mcp.allow")}`);
    row.append(name, allow, document.createElement("span"));
    details.appendChild(row);
  }

  heading(t("mcp.prompts"));
  for (const prompt of catalog.prompts || []) {
    const row = document.createElement("div"); row.className = "mcp-capability-row";
    const name = document.createElement("span"); name.textContent = prompt.name;
    const allow = document.createElement("label");
    const box = document.createElement("input"); box.type = "checkbox";
    box.checked = prompts.has("*") || prompts.has(prompt.name);
    box.addEventListener("change", () => setCommaValue(promptInput, prompt.name, box.checked));
    allow.append(box, ` ${t("mcp.allow")}`);
    row.append(name, allow, document.createElement("span"));
    details.appendChild(row);
  }
  card.appendChild(details);
}

function renderMcpServers() {
  if (!mcpServerList) return;
  mcpServerList.innerHTML = "";
  const views = new Map((state.mcpEffectiveViews || []).map((view) => [view.config?.name, view]));
  (state.mcpConfig.servers || []).forEach((server, index) => {
    const view = views.get(server.name);
    const catalog = state.mcpCatalogs[server.name] || view?.catalog;
    const card = document.createElement("div");
    card.className = "mcp-server-card";
    card.dataset.index = String(index);
    card.dataset.transportType = server.transport.type;
    const header = document.createElement("div"); header.className = "mcp-server-card-header";
    const title = document.createElement("div"); title.className = "mcp-server-card-title";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = server.enabled !== false; enabled.dataset.mcpField = "enabled";
    const titleText = document.createElement("span"); titleText.textContent = server.name || `${t("mcp.server")} ${index + 1}`;
    const status = document.createElement("span"); status.className = `mcp-status-pill ${view?.status || "disconnected"}`; status.textContent = view?.status || t("mcp.notSaved");
    title.append(enabled, titleText, status);
    const actions = document.createElement("div"); actions.className = "mcp-card-actions";
    const probe = document.createElement("button"); probe.type = "button"; probe.className = "btn btn-ghost btn-sm"; probe.textContent = t("mcp.probe");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn btn-ghost btn-sm"; remove.textContent = t("common.delete");
    actions.append(probe, remove); header.append(title, actions); card.appendChild(header);

    const grid = document.createElement("div"); grid.className = "mcp-grid";
    grid.append(
      mcpField(t("mcp.name"), "name", server.name),
      mcpField(t("mcp.description"), "description", server.description || ""),
    );
    const transportGroup = document.createElement("div"); transportGroup.className = "setting-group";
    const transportLabel = document.createElement("label"); transportLabel.textContent = t("mcp.transport");
    const transportSelect = document.createElement("select"); transportSelect.dataset.mcpField = "transportType";
    transportSelect.innerHTML = '<option value="http">Streamable HTTP</option><option value="stdio">stdio</option>';
    transportSelect.value = server.transport.type;
    transportGroup.append(transportLabel, transportSelect); grid.appendChild(transportGroup);
    grid.appendChild(mcpField(t("mcp.maxConcurrency"), "maxConcurrency", server.maxConcurrency ?? 4, { type: "number", min: 1, max: 32 }));
    if (server.transport.type === "stdio") {
      grid.append(
        mcpField(t("mcp.command"), "command", server.transport.command || ""),
        mcpField(t("mcp.cwd"), "cwd", server.transport.cwd || ""),
        mcpField(t("mcp.args"), "args", JSON.stringify(server.transport.args || []), { wide: true }),
        mcpField(t("mcp.envMapping"), "envFromHost", JSON.stringify(server.transport.envFromHost || {}), { wide: true }),
      );
    } else {
      grid.append(
        mcpField(t("mcp.url"), "url", server.transport.url || "", { wide: true }),
        mcpField(t("mcp.bearerTokenEnv"), "bearerTokenEnv", server.transport.bearerTokenEnv || ""),
        mcpField(t("mcp.headerMapping"), "headersFromEnv", JSON.stringify(server.transport.headersFromEnv || {})),
      );
    }
    grid.append(
      mcpField(t("mcp.allowedTools"), "allowedTools", (server.exposure.allowedTools || []).join(", "), { wide: true }),
      mcpField(t("mcp.directTools"), "directTools", (server.exposure.directTools || []).join(", "), { wide: true }),
      mcpField(t("mcp.resourcePrefixes"), "resourceUriPrefixes", (server.exposure.resourceUriPrefixes || []).join(", "), { wide: true }),
      mcpField(t("mcp.allowedPrompts"), "allowedPrompts", (server.exposure.allowedPrompts || []).join(", "), { wide: true }),
      mcpField(t("mcp.connectTimeout"), "connectMs", server.timeouts?.connectMs ?? 10000, { type: "number", min: 100 }),
      mcpField(t("mcp.callTimeout"), "callMs", server.timeouts?.callMs ?? 60000, { type: "number", min: 100 }),
      mcpField(t("mcp.taskForegroundTimeout"), "taskForegroundMs", server.timeouts?.taskForegroundMs ?? 30000, { type: "number", min: 0 }),
    );
    card.appendChild(grid);
    if (view?.error) { const error = document.createElement("div"); error.className = "setting-hint"; error.textContent = view.error; card.appendChild(error); }
    renderMcpCatalog(card, server, catalog);
    transportSelect.addEventListener("change", () => {
      try { collectMcpConfig(); } catch (error) { addStatusMessage(error.message); return; }
      const current = state.mcpConfig.servers[index];
      current.transport = transportSelect.value === "stdio"
        ? { type: "stdio", command: "", args: [], envFromHost: {} }
        : { type: "http", url: "http://127.0.0.1:3000/mcp", headersFromEnv: {} };
      renderMcpServers();
    });
    remove.addEventListener("click", () => {
      try { collectMcpConfig(); } catch (error) { addStatusMessage(error.message); return; }
      state.mcpConfig.servers.splice(index, 1); renderMcpServers();
    });
    probe.addEventListener("click", () => {
      try { collectMcpConfig(); } catch (error) { addStatusMessage(error.message); return; }
      state.pendingMcpProbe = state.mcpConfig.servers[index]?.name;
      if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.savingBeforeProbe");
      sendCommand({ type: "save_mcp_servers", request_id: nextMcpRequestId(), config: state.mcpConfig });
    });
    mcpServerList.appendChild(card);
  });
}

function loadMcpServers() {
  if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("common.loading");
  sendCommand({ type: "get_mcp_servers", request_id: nextMcpRequestId() });
}

function saveMcpServers() {
  try {
    const config = collectMcpConfig();
    if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.saving");
    sendCommand({ type: "save_mcp_servers", request_id: nextMcpRequestId(), config });
  } catch (error) {
    if (mcpSettingsStatus) mcpSettingsStatus.textContent = error.message;
    addStatusMessage(`${t("mcp.saveFailed")}: ${error.message}`);
  }
}

// ─── File Upload ────────────────────────────────────────────────────────────────

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function uploadFiles(files) {
  for (const file of files) {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const resp = await authenticatedFetch(`/api/upload?user=${encodeURIComponent(state.user)}`, { method: "POST", body: formData });
      const result = await resp.json();
      if (result.error) {
        addStatusMessage(`${t('common.uploadFailed')}: ${result.error}`);
        continue;
      }
      state.uploadedFiles.push(result);
      renderUploadPreview();
    } catch (err) {
      addStatusMessage(`${t('common.uploadFailed')}: ${file.name}`);
    }
  }
}

function renderUploadPreview() {
  if (!uploadPreview) return;
  uploadPreview.innerHTML = "";
  if (state.uploadedFiles.length === 0) {
    uploadPreview.style.display = "none";
    return;
  }
  uploadPreview.style.display = "flex";
  for (const f of state.uploadedFiles) {
    const chip = createElement("span", "file-chip",
      `${escapeHtml(f.name)} <span class="file-size">(${formatFileSize(f.size)})</span>`);
    const removeBtn = createElement("button", "file-chip-remove", "×");
    removeBtn.dataset.path = f.path;
    removeBtn.addEventListener("click", () => {
      state.uploadedFiles = state.uploadedFiles.filter(x => x.path !== f.path);
      renderUploadPreview();
    });
    chip.appendChild(removeBtn);
    uploadPreview.appendChild(chip);
  }
}

// Drag & drop on messages container
messagesContainer.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  if (dragOverlay) dragOverlay.classList.add("active");
});
messagesContainer.addEventListener("dragleave", (e) => {
  if (!messagesContainer.contains(e.relatedTarget)) {
    if (dragOverlay) dragOverlay.classList.remove("active");
  }
});
messagesContainer.addEventListener("drop", (e) => {
  e.preventDefault();
  if (dragOverlay) dragOverlay.classList.remove("active");
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

// Upload button + file input
if (uploadBtn) {
  uploadBtn.addEventListener("click", () => { if (fileInput) fileInput.click(); });
}
if (fileInput) {
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) uploadFiles(fileInput.files);
    fileInput.value = "";  // Reset for re-selection
  });
}

// ── Skill Dropdown (Floating menu + theme level-2 + tooltip) ───────────────────────

const THEME_SKILLS = ['gen-chart', 'gen-ppt', 'doc-convert'];

const BUILTIN_TOOLS = [
  { command: 'math_calc', label: 'math_calc', desc: 'commands.mathCalc' },
  { command: 'web_fetch', label: 'web_fetch', desc: 'commands.webFetch' },
  { command: 'web_search', label: 'web_search', desc: 'commands.webSearch' },
];

function renderSkillMenu() {
  if (!skillMenu) return;
  skillMenu.innerHTML = '';

  // Tools group
  const toolsLabel = document.createElement('div');
  toolsLabel.className = 'skill-menu-group-label';
  toolsLabel.textContent = t('commands.toolsGroup');
  skillMenu.appendChild(toolsLabel);
  for (const tool of BUILTIN_TOOLS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'skill-item';
    if (state.selectedSkill && state.selectedSkill.command === tool.command) item.classList.add('selected');
    item.dataset.command = tool.command;
    item.innerHTML = `<span>/${tool.label}</span>`;
    item.addEventListener('click', () => selectSkillItem(tool.command));
    item.addEventListener('mouseenter', () => hideSubmenu());
    skillMenu.appendChild(item);
  }

  // Skills group
  const skills = state.skillsData || [];
  if (skills.length > 0) {
    const skillsLabel = document.createElement('div');
    skillsLabel.className = 'skill-menu-group-label';
    skillsLabel.textContent = t('commands.skillsGroup');
    skillMenu.appendChild(skillsLabel);
    for (const skill of skills) {
      const name = typeof skill === 'string' ? skill : skill.name || '';
      if (!name) continue;
      const isThemeSkill = THEME_SKILLS.includes(name);
      if (isThemeSkill) {
        // Theme skill: hover, click, or keyboard activation opens the theme submenu
        const parent = document.createElement('button');
        parent.type = 'button';
        parent.className = 'skill-item skill-parent';
        if (state.selectedSkill && state.selectedSkill.command === name) parent.classList.add('selected');
        parent.innerHTML = `<span>/${escapeHtml(name)}</span><span class="arrow">\u25B6</span>`;
        parent.addEventListener('click', () => { cancelHideSubmenu(); showSubmenu(name, parent); });
        parent.addEventListener('mouseenter', () => { cancelHideSubmenu(); showSubmenu(name, parent); });
        parent.addEventListener('mouseleave', () => scheduleHideSubmenu());
        skillMenu.appendChild(parent);
      } else {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'skill-item';
        if (state.selectedSkill && state.selectedSkill.command === name) item.classList.add('selected');
        item.textContent = '/' + name;
        item.addEventListener('click', () => selectSkillItem(name));
        item.addEventListener('mouseenter', () => hideSubmenu());
        skillMenu.appendChild(item);
      }
    }
  }
}

function showSubmenu(skillName, parentEl) {
  if (!skillSubmenu) return;
  skillSubmenu.innerHTML = '';
  for (const th of THEMES) {
    const child = document.createElement('button');
    child.type = 'button';
    child.className = 'skill-child';
    if (state.selectedSkill && state.selectedSkill.command === skillName && state.selectedSkill.theme === th.key) child.classList.add('selected');
    child.textContent = th.label;
    child.addEventListener('click', (e) => { e.stopPropagation(); selectSkillItem(skillName, th.key); });
    child.addEventListener('mouseenter', (e) => showThemeTooltip(th.key, th.label, e.target));
    child.addEventListener('mouseleave', () => hideThemeTooltip());
    skillSubmenu.appendChild(child);
  }
  // Keep the submenu beside its parent and within the viewport
  const parentRect = parentEl.getBoundingClientRect();
  const dropdownRect = skillDropdown.getBoundingClientRect();
  skillSubmenu.classList.add('open');
  const width = skillSubmenu.offsetWidth;
  const left = parentRect.right + width + 12 <= window.innerWidth
    ? parentRect.right + 4 : Math.max(8, parentRect.left - width - 4);
  const top = Math.max(8, Math.min(parentRect.bottom - skillSubmenu.offsetHeight, window.innerHeight - skillSubmenu.offsetHeight - 8));
  skillSubmenu.style.left = (left - dropdownRect.left) + 'px';
  skillSubmenu.style.bottom = 'auto';
  skillSubmenu.style.top = (top - dropdownRect.top) + 'px';
}

function hideSubmenu() {
  cancelHideSubmenu();
  if (skillSubmenu) skillSubmenu.classList.remove('open');
  hideThemeTooltip();
}

// Delayed hide: keeps the submenu open while the mouse crosses the gap
// between the parent item and the submenu, then hides it on mouse-out
let submenuHideTimer = null;
function scheduleHideSubmenu() {
  cancelHideSubmenu();
  submenuHideTimer = setTimeout(() => { submenuHideTimer = null; hideSubmenu(); }, 150);
}
function cancelHideSubmenu() {
  if (submenuHideTimer) { clearTimeout(submenuHideTimer); submenuHideTimer = null; }
}
if (skillSubmenu) {
  skillSubmenu.addEventListener('mouseenter', () => cancelHideSubmenu());
  skillSubmenu.addEventListener('mouseleave', () => scheduleHideSubmenu());
}

function selectSkillItem(command, theme) {
  if (theme) {
    state.selectedSkill = { command, theme };
  } else {
    state.selectedSkill = { command };
  }
  updateSkillTag();
  updateSkillBtnState();
  closeSkillMenu();
  messageInput.focus();
}

function updateSkillTag() {
  const input = messageInput;
  if (!input) return;
  input.value = input.value.replace(/^\/[\w-]+(?::[\w-]+)?\s*/, '');
  if (state.selectedSkill) {
    const { command, theme } = state.selectedSkill;
    input.value = `/${command}${theme ? ':' + theme : ''} ` + input.value;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
}

function updateSkillBtnState() {
  if (!skillBtn) return;
  const isQuick = state.conversationMode === 'quick';
  skillBtn.disabled = isQuick;
  if (state.selectedSkill) {
    skillBtn.classList.add('active');
    skillBtn.title = '/' + state.selectedSkill.command + (state.selectedSkill.theme ? ':' + state.selectedSkill.theme : '');
  } else {
    skillBtn.classList.remove('active');
    skillBtn.title = t('commands.selectToolOrSkill');
  }
  if (isQuick && state.selectedSkill) {
    state.selectedSkill = null;
    updateSkillTag();
    skillBtn.classList.remove('active');
  }
}

// Theme color preview Tooltip
function showThemeTooltip(themeKey, label, targetEl) {
  if (!themeTooltip) return;
  const palette = THEME_PALETTES[themeKey];
  if (!palette) return;
  const swatchKeys = ['primary', 'bg', 'text', 'userBubble', 'border'];
  const swatchLabels = ['Primary', 'BG', 'Text', 'User', 'Border'];
  themeTooltip.innerHTML = `<div class="tp-title">${escapeHtml(label)}</div>` +
    `<div class="tp-swatches">${swatchKeys.map((k, i) => `<div class="tp-swatch" style="background:${palette[k]}" title="${swatchLabels[i]}: ${palette[k]}"></div>`).join('')}</div>` +
    `<div class="tp-label">${swatchLabels.join(' · ')}</div>`;
  const rect = targetEl.getBoundingClientRect();
  themeTooltip.classList.add('visible');
  const width = themeTooltip.offsetWidth;
  const left = rect.right + width + 16 <= window.innerWidth ? rect.right + 8 : Math.max(8, rect.left - width - 8);
  themeTooltip.style.left = left + 'px';
  themeTooltip.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - themeTooltip.offsetHeight - 8)) + 'px';
}

function hideThemeTooltip() {
  if (themeTooltip) themeTooltip.classList.remove('visible');
}

// Menu toggle
function toggleSkillMenu() {
  if (!skillMenu) return;
  const isOpen = skillMenu.classList.contains('open');
  if (isOpen) { closeSkillMenu(); } else { openSkillMenu(); }
}
function openSkillMenu() {
  if (!skillMenu) return;
  renderSkillMenu();
  skillMenu.classList.add('open');
  skillBtn.setAttribute('aria-expanded', 'true');
}
function closeSkillMenu() {
  if (!skillMenu) return;
  skillMenu.classList.remove('open');
  skillBtn.setAttribute('aria-expanded', 'false');
  hideSubmenu();
  hideThemeTooltip();
}

function closeComposerMenus() {
  closeSkillMenu();
  slashAutocomplete.style.display = 'none';
  closeComposerModelPanel(false);
}

// Button click
if (skillBtn) {
  skillBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSkillMenu(); });
}
skillDropdown.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeSkillMenu(); skillBtn.focus(); }
});
// Click outside to close
document.addEventListener('click', (e) => {
  if (skillDropdown && !skillDropdown.contains(e.target)) { closeSkillMenu(); }
});

// ─── Skills & Extensions ──────────────────────────────────────────────────────

function renderSkills(capabilities) {
  const skills = capabilities?.installed_skills || [];
  state.skillsData = skills;
  if (!skillsList) { renderSkillMenu(); return; }
  if (skills.length === 0) {
    const hasChildReady = state.capabilities?.builtin_tools?.length > 0;
    if (!hasChildReady) {
      skillsList.innerHTML = `<li class="empty-hint">${t('skills.waitForLoad')}</li>`;
    } else {
      skillsList.innerHTML = `<li class="empty-hint">${t('skills.empty')}</li>`;
    }
    renderSkillMenu();
    return;
  }
  skillsList.innerHTML = "";
  for (const skill of skills) {
    const name = typeof skill === "string" ? skill : skill.name || skill;
    const desc = typeof skill === "object" ? skill.description || "" : "";
    const needsConfig = typeof skill === "object" ? skill.needsConfig : false;
    const li = document.createElement("li");
    li.className = "skill-item";
    li.innerHTML = `
      <div class="skill-item-name">${escapeHtml(name)}</div>
      ${desc ? `<div class="skill-item-desc">${escapeHtml(desc)}</div>` : ""}
      ${needsConfig ? `<div class="skill-item-actions"><button class="btn btn-ghost btn-sm skill-config-btn" data-skill="${escapeHtml(name)}">${t('skills.config')}</button></div>` : ""}
    `;
    skillsList.appendChild(li);
  }
  skillsList.querySelectorAll(".skill-config-btn").forEach((btn) => {
    btn.addEventListener("click", () => openSkillConfig(btn.dataset.skill));
  });
  renderSkillMenu();
}

function renderExtensions(capabilities) {
  if (!extensionsList) return;
  const extensions = capabilities?.extensions || [];
  if (extensions.length === 0) {
    extensionsList.innerHTML = `<li class="empty-hint">${t('extensions.empty')}</li>`;
    return;
  }
  extensionsList.innerHTML = "";
  for (const ext of extensions) {
    const name = typeof ext === "string" ? ext : ext.name || ext;
    const li = document.createElement("li");
    li.textContent = name;
    li.className = "active-item";
    extensionsList.appendChild(li);
  }
}

// ─── Page View: Skills Management ─────────────────────────────────────────────

async function loadSkillsPage() {
  const tbody = document.getElementById('skills-table-body');
  const empty = document.getElementById('skills-empty');
  const table = document.getElementById('skills-table');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center">${t('common.loading')}...</td></tr>`;
  try {
    const resp = await authenticatedFetch(`/api/skills?user=${encodeURIComponent(state.user)}`);
    const data = await resp.json();
    const skills = data.skills || [];
    if (skills.length === 0) {
      tbody.innerHTML = '';
      if (table) table.style.display = 'none';
      if (empty) empty.style.display = '';
      return;
    }
    if (table) table.style.display = '';
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = '';
    for (const skill of skills) {
      const tr = document.createElement('tr');
      const scopeClass = skill.scope === 'system' ? 'system' : 'user';
      const scopeLabel = skill.scope === 'system' ? t('skills.scopeSystem') : t('skills.scopeUser');
      tr.innerHTML = `
        <td>${escapeHtml(skill.name)}</td>
        <td>${escapeHtml(skill.description || '-')}</td>
        <td>${escapeHtml(skill.version || '-')}</td>
        <td><span class="scope-badge ${scopeClass}">${scopeLabel}</span></td>
        <td class="skill-ops"></td>
      `;
      const opsTd = tr.querySelector('.skill-ops');
      // Config button
      const configBtn = document.createElement('button');
      configBtn.className = 'btn btn-ghost btn-sm';
      configBtn.textContent = t('skills.config');
      configBtn.addEventListener('click', () => openSkillConfigPage(skill.name));
      opsTd.appendChild(configBtn);
      // Delete button — available for all skills (system and user scope)
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost btn-sm';
      delBtn.style.color = '#ef4444';
      delBtn.textContent = t('common.delete');
      delBtn.addEventListener('click', () => deleteSkill(skill.name, skill.scope));
      opsTd.appendChild(delBtn);
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444">${t('common.error')}: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function openSkillConfigPage(skillName) {
  if (!skillConfigModal || !skillConfigTitle || !skillConfigBody) return;
  skillConfigTitle.textContent = `${t('skills.config')}: ${skillName}`;
  skillConfigBody.innerHTML = `
    <div class="setting-group">
      <label><input type="checkbox" id="skill-config-has-apikey"> API Key</label>
      <input type="password" id="skill-config-apikey" placeholder="API Key..." autocomplete="off" class="skill-git-input" style="display:none;margin-top:8px">
    </div>
    <div id="skill-custom-configs"></div>
    <button class="btn btn-ghost btn-sm btn-add-config" id="add-config-row">+ ${t('skills.addConfig')}</button>
  `;
  // Toggle API key input
  const hasApikeyCb = document.getElementById('skill-config-has-apikey');
  const apikeyInput = document.getElementById('skill-config-apikey');
  hasApikeyCb?.addEventListener('change', () => {
    if (apikeyInput) apikeyInput.style.display = hasApikeyCb.checked ? '' : 'none';
  });
  // Add custom config row
  document.getElementById('add-config-row')?.addEventListener('click', () => addConfigRow());
  // Load existing config
  authenticatedFetch(`/api/skills/${encodeURIComponent(skillName)}/config?user=${encodeURIComponent(state.user)}`)
    .then(r => r.json())
    .then(data => {
      const config = data.config || {};
      if (config['api-key']) {
        hasApikeyCb.checked = true;
        if (apikeyInput) { apikeyInput.style.display = ''; apikeyInput.value = config['api-key']; }
        delete config['api-key'];
      }
      const container = document.getElementById('skill-custom-configs');
      for (const [k, v] of Object.entries(config)) {
        addConfigRow(container, k, v);
      }
    }).catch(() => {});
  skillConfigModal.classList.add('open');
  skillConfigModal.dataset.skillName = skillName;
}

function addConfigRow(container, key = '', value = '') {
  if (!container) container = document.getElementById('skill-custom-configs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'config-row';
  row.innerHTML = `
    <input type="text" placeholder="Key" class="config-key skill-git-input" value="${escapeHtml(key)}">
    <input type="text" placeholder="Value" class="config-value skill-git-input" value="${escapeHtml(value)}">
    <button class="btn btn-ghost btn-sm btn-remove-config">✕</button>
  `;
  row.querySelector('.btn-remove-config')?.addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function deleteSkill(name, scope) {
  const scopeLabel = scope === 'system' ? 'system' : 'user';
  if (!confirm(`${t('skills.confirmDelete')}: ${name} (${scopeLabel})?`)) return;
  try {
    const resp = await authenticatedFetch(`/api/skills/${encodeURIComponent(name)}?user=${encodeURIComponent(state.user)}&scope=${scope}`, { method: 'DELETE' });
    const result = await resp.json();
    if (result.error) { addStatusMessage(`${t('common.error')}: ${result.error}`); return; }
    addStatusMessage(`${t('skills.deleted')}: ${name}`);
    loadSkillsPage();
  } catch (err) {
    addStatusMessage(`${t('common.error')}: ${err.message}`);
  }
}

// ─── Page View: Extensions ────────────────────────────────────────────────────

async function loadExtensionsPage() {
  const tbody = document.getElementById('extensions-table-body');
  const empty = document.getElementById('extensions-empty');
  const table = document.getElementById('extensions-table');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="2" style="text-align:center">${t('common.loading')}...</td></tr>`;
  try {
    const resp = await authenticatedFetch(`/api/extensions?user=${encodeURIComponent(state.user)}`);
    const data = await resp.json();
    const exts = data.extensions || [];
    if (exts.length === 0) {
      tbody.innerHTML = '';
      if (table) table.style.display = 'none';
      if (empty) empty.style.display = '';
      return;
    }
    if (table) table.style.display = '';
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = '';
    for (const ext of exts) {
      const tr = document.createElement('tr');
      const scopeClass = ext.scope === 'system' ? 'system' : 'user';
      const scopeLabel = ext.scope === 'system' ? t('skills.scopeSystem') : t('skills.scopeUser');
      tr.innerHTML = `
        <td>${escapeHtml(ext.name)}</td>
        <td><span class="scope-badge ${scopeClass}">${scopeLabel}</span></td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;color:#ef4444">${t('common.error')}: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ─── Page View: Tools ─────────────────────────────────────────────────────────

// Tool type categorization
const TOOL_CATEGORIES = {
  builtin: new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']),
  enhanced: new Set(['math_calc', 'web_search', 'web_fetch']),
};
function getToolCategory(name) {
  if (TOOL_CATEGORIES.builtin.has(name)) return 'builtin';
  if (TOOL_CATEGORIES.enhanced.has(name)) return 'enhanced';
  return 'extension';
}
function getToolCategoryLabel(cat) {
  const map = {
    builtin: t('tools.category.builtin'),
    enhanced: t('tools.category.enhanced'),
    extension: t('tools.category.extension'),
  };
  return map[cat] || cat;
}

async function loadToolsPage() {
  const tbody = document.getElementById('tools-table-body');
  const empty = document.getElementById('tools-empty');
  const table = document.getElementById('tools-table');
  const sidebarList = document.getElementById('tools-sidebar-list');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="2" style="text-align:center">${t('common.loading')}...</td></tr>`;
  try {
    const resp = await authenticatedFetch('/api/tools');
    const data = await resp.json();
    const tools = data.tools || [];
    if (tools.length === 0) {
      tbody.innerHTML = '';
      if (table) table.style.display = 'none';
      if (empty) empty.style.display = '';
      return;
    }
    if (table) table.style.display = '';
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = '';
    for (const tool of tools) {
      const cat = getToolCategory(tool.name);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(tool.name)}</td><td><span class="tool-type-badge ${cat}">${getToolCategoryLabel(cat)}</span></td>`;
      tbody.appendChild(tr);
    }
    // Also populate sidebar summary list
    if (sidebarList) {
      sidebarList.innerHTML = '';
      for (const tool of tools) {
        const li = document.createElement('li');
        li.className = 'active-item';
        li.textContent = tool.name;
        sidebarList.appendChild(li);
      }
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;color:#ef4444">${t('common.error')}: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// ─── Skill Install Modal ──────────────────────────────────────────────────────

const skillInstallModal = $('skill-install-modal');
const installSkillPageBtn = $('install-skill-page-btn');
const closeSkillInstallBtn = $('close-skill-install');
const confirmInstallBtn = $('confirm-install-skill');

if (installSkillPageBtn) {
  installSkillPageBtn.addEventListener('click', () => {
    if (skillInstallModal) skillInstallModal.classList.add('open');
  });
}
if (closeSkillInstallBtn) {
  closeSkillInstallBtn.addEventListener('click', () => {
    if (skillInstallModal) skillInstallModal.classList.remove('open');
  });
}
if (skillInstallModal) {
  skillInstallModal.addEventListener('click', (e) => {
    if (e.target === skillInstallModal) skillInstallModal.classList.remove('open');
  });
}

// Tab switching in install modal
document.querySelectorAll('.tab-btn[data-install-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.installTab;
    document.querySelectorAll('.tab-btn[data-install-tab]').forEach(b => b.classList.toggle('active', b.dataset.installTab === tab));
    document.querySelectorAll('.install-tab-panel').forEach(p => {
      p.style.display = p.dataset.installTab === tab ? '' : 'none';
    });
  });
});

if (confirmInstallBtn) {
  confirmInstallBtn.addEventListener('click', async () => {
    const scope = document.querySelector('input[name="install-scope"]:checked')?.value || 'user';
    const activeTab = document.querySelector('.tab-btn.active[data-install-tab]')?.dataset.installTab || 'git';

    if (activeTab === 'git') {
      const url = document.getElementById('install-git-url')?.value?.trim();
      if (!url) return;
      confirmInstallBtn.disabled = true;
      confirmInstallBtn.textContent = t('common.loading') + '...';
      try {
        const resp = await authenticatedFetch('/api/skills/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'git', url, scope, user: state.user }),
        });
        const result = await resp.json();
        if (result.error) { addStatusMessage(`${t('common.error')}: ${result.error}`); return; }
        addStatusMessage(`${t('skills.installed')}: ${result.name}`);
        if (skillInstallModal) skillInstallModal.classList.remove('open');
        loadSkillsPage();
      } catch (err) {
        addStatusMessage(`${t('common.error')}: ${err.message}`);
      } finally {
        confirmInstallBtn.disabled = false;
        confirmInstallBtn.textContent = t('skills.install');
      }
    } else {
      const fileInput = document.getElementById('install-zip-file');
      const file = fileInput?.files?.[0];
      if (!file) return;
      confirmInstallBtn.disabled = true;
      confirmInstallBtn.textContent = t('common.loading') + '...';
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('scope', scope);
        formData.append('user', state.user);
        const resp = await authenticatedFetch('/api/skills/install', { method: 'POST', body: formData });
        const result = await resp.json();
        if (result.error) { addStatusMessage(`${t('common.error')}: ${result.error}`); return; }
        addStatusMessage(`${t('skills.installed')}: ${result.name}`);
        if (skillInstallModal) skillInstallModal.classList.remove('open');
        loadSkillsPage();
      } catch (err) {
        addStatusMessage(`${t('common.error')}: ${err.message}`);
      } finally {
        confirmInstallBtn.disabled = false;
        confirmInstallBtn.textContent = t('skills.install');
      }
    }
  });
}

function openSkillConfig(skillName) {
  if (!skillConfigModal || !skillConfigTitle || !skillConfigBody) return;
  skillConfigTitle.textContent = `${t('skills.config')}: ${skillName}`;
  skillConfigBody.innerHTML = `
    <div class="setting-group">
      <label><input type="checkbox" id="skill-config-has-apikey"> API Key</label>
      <input type="password" id="skill-config-apikey" placeholder="API Key..." autocomplete="off" class="skill-git-input" style="display:none;margin-top:8px">
    </div>
    <div id="skill-custom-configs"></div>
    <button class="btn btn-ghost btn-sm btn-add-config" id="add-config-row">+ ${t('skills.addConfig')}</button>
  `;
  const hasApikeyCb = document.getElementById('skill-config-has-apikey');
  const apikeyInput = document.getElementById('skill-config-apikey');
  hasApikeyCb?.addEventListener('change', () => {
    if (apikeyInput) apikeyInput.style.display = hasApikeyCb.checked ? '' : 'none';
  });
  document.getElementById('add-config-row')?.addEventListener('click', () => addConfigRow());
  // Load existing config
  authenticatedFetch(`/api/skills/${encodeURIComponent(skillName)}/config?user=${encodeURIComponent(state.user)}`)
    .then(r => r.json())
    .then(data => {
      const config = data.config || {};
      if (config['api-key']) {
        hasApikeyCb.checked = true;
        if (apikeyInput) { apikeyInput.style.display = ''; apikeyInput.value = config['api-key']; }
        delete config['api-key'];
      }
      const container = document.getElementById('skill-custom-configs');
      for (const [k, v] of Object.entries(config)) {
        addConfigRow(container, k, v);
      }
    }).catch(() => {});
  skillConfigModal.classList.add('open');
  skillConfigModal.dataset.skillName = skillName;
}

// ─── Model Management ─────────────────────────────────────────────────────────

function currentModelScope() {
  return JSON.stringify([state.sessionId, state.currentProvider, state.currentBaseUrl, state.currentApiKey]);
}

// Mirror model-utils.ts conversion + vendor getSupportedThinkingLevels. The WebUI
// must not offer levels the running adapter clamps away. A parity test guards this.
function composerThinkingLevels(provider, modelId) {
  const id = (modelId || '').toLowerCase();
  const reasoning = /^(qwen3|qwq|deepseek-r1|deepseek-reasoner|o[134]-)/.test(id);
  return provider && reasoning ? THINKING_LEVELS.slice(0, -1) : ['off'];
}

function updateComposerModelControls() {
  const unavailable = !state.connected || state.isBusy || state.isCompacting
    || state.awaitingNewSession || state.pendingNewSessionUI || saveSettingsBtn.disabled;
  modelIndicator.disabled = !state.connected || state.awaitingNewSession || state.pendingNewSessionUI;
  composerModelSelect.disabled = unavailable || !composerModelState.loaded || composerModelState.models.length === 0;
  composerThinkingInput.disabled = unavailable || !composerModelState.loaded || composerModelState.thinkingLevels.length < 2;
  applyComposerModelBtn.disabled = unavailable || !composerModelState.loaded;
}

function positionComposerModelPanel() {
  if (composerModelPanel.hidden) return;
  const anchor = modelIndicator.getBoundingClientRect();
  composerModelPanel.style.left = `${Math.max(12, Math.min(anchor.right - composerModelPanel.offsetWidth, window.innerWidth - composerModelPanel.offsetWidth - 12))}px`;
  composerModelPanel.style.top = `${Math.max(12, Math.min(anchor.top - composerModelPanel.offsetHeight - 10, window.innerHeight - composerModelPanel.offsetHeight - 12))}px`;
}

function closeComposerModelPanel(restoreFocus = true) {
  if (composerModelPanel.hidden) return;
  const hadFocus = composerModelPanel.contains(document.activeElement);
  composerModelPanel.hidden = true;
  composerModelState.target = null;
  modelIndicator.setAttribute('aria-expanded', 'false');
  if (restoreFocus && hadFocus) modelIndicator.focus();
}

function updateComposerThinking(preferredLevel = state.currentThinkingLevel) {
  const levels = composerThinkingLevels(state.currentProvider, composerModelSelect.value);
  composerModelState.thinkingLevels = levels;
  const preferredIndex = THINKING_LEVELS.indexOf(preferredLevel);
  const chosenLevel = levels.includes(preferredLevel) ? preferredLevel
    : levels.find(level => THINKING_LEVELS.indexOf(level) >= preferredIndex) || levels.at(-1);
  composerThinkingInput.max = String(levels.length - 1);
  composerThinkingInput.value = String(levels.indexOf(chosenLevel));
  $('composer-thinking-labels').replaceChildren(...levels.map(level => {
    const label = document.createElement('span');
    label.textContent = t(`settings.${THINKING_LABELS[level]}`);
    return label;
  }));
  updateComposerThinkingValue();
  updateComposerModelControls();
}

function updateComposerThinkingValue() {
  const level = composerModelState.thinkingLevels[Number(composerThinkingInput.value)] || 'off';
  const label = t(`settings.${THINKING_LABELS[level]}`);
  $('composer-thinking-value').textContent = label;
  composerThinkingInput.setAttribute('aria-valuetext', label);
}

function renderComposerModels(models) {
  const seen = new Set();
  composerModelState.models = (models || []).filter(model => {
    if (typeof model.id !== 'string' || !model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  const choices = composerModelState.models.length ? composerModelState.models : [{ id: 'auto' }];
  composerModelSelect.replaceChildren(...choices.map(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.id;
    return option;
  }));
  if (seen.has(state.currentModel)) composerModelSelect.value = state.currentModel;
  updateComposerThinking();
  positionComposerModelPanel();
}

function openComposerModelPanel() {
  if (!state.connected || state.pendingLlmSettings || saveSettingsBtn.disabled) return;
  closeComposerMenus();
  composerModelState.scope = currentModelScope();
  composerModelState.loaded = false;
  composerModelState.target = `composer-models-${++composerModelState.requestId}`;
  composerModelPanel.hidden = false;
  modelIndicator.setAttribute('aria-expanded', 'true');
  $('composer-provider').textContent = state.currentProvider;
  composerModelStatus.textContent = t('settings.fetchingModels');
  renderComposerModels([]);
  // Existing free-form target is echoed by refresh_models; isolate active-provider
  // responses from the main/audit settings drafts and from earlier popover opens.
  sendCommand({ type: 'refresh_models', provider: state.currentProvider,
    apiKey: state.currentApiKey, baseUrl: state.currentBaseUrl || PROVIDER_DEFAULTS[state.currentProvider]?.baseUrl || '',
    target: composerModelState.target });
}

function handleComposerModels(event) {
  if (typeof event.target !== 'string' || !event.target.startsWith('composer-models-')) return false;
  if (event.target !== composerModelState.target || event.provider !== state.currentProvider
      || composerModelState.scope !== currentModelScope()) return true;
  composerModelState.target = null;
  composerModelState.loaded = true;
  renderComposerModels(event.type === 'models_refreshed' ? event.models : []);
  composerModelStatus.textContent = composerModelState.models.length ? '' : t('settings.autoModelOnly');
  if (composerModelState.models.length && composerModelState.thinkingLevels.length === 1) {
    composerModelStatus.textContent = t('settings.thinkingUnavailable');
  }
  positionComposerModelPanel();
  return true;
}

function resetPendingSettings(error = '') {
  if (state.pendingLlmSettings?.source === 'composer') composerModelStatus.textContent = error;
  state.pendingLlmSettings = null;
  saveSettingsBtn.disabled = false;
  updateComposerModelControls();
}

applyComposerModelBtn.addEventListener('click', () => {
  updateComposerModelControls();
  if (applyComposerModelBtn.disabled || composerModelState.scope !== currentModelScope()) return;
  const modelId = composerModelSelect.value;
  const thinkingLevel = composerModelState.thinkingLevels[Number(composerThinkingInput.value)];
  state.pendingLlmSettings = { source: 'composer', provider: state.currentProvider,
    apiKey: state.currentApiKey, baseUrl: state.currentBaseUrl, modelId, thinkingLevel };
  saveSettingsBtn.disabled = true;
  composerModelStatus.textContent = t('settings.applyingModel');
  updateComposerModelControls();
  // The existing save_settings command applies both values and persists them.
  // Preserve provider credentials, audit, and system settings by omitting them.
  sendCommand({ type: 'save_settings', provider: state.currentProvider, modelId, thinkingLevel });
});
composerModelSelect.addEventListener('change', () => {
  updateComposerThinking();
  composerModelStatus.textContent = composerModelState.thinkingLevels.length === 1 ? t('settings.thinkingUnavailable') : '';
  positionComposerModelPanel();
});
composerThinkingInput.addEventListener('input', updateComposerThinkingValue);
document.addEventListener('click', (event) => {
  if (!composerModelPanel.contains(event.target) && !modelIndicator.contains(event.target)) closeComposerModelPanel(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !composerModelPanel.hidden) {
    event.preventDefault();
    closeComposerModelPanel();
    modelIndicator.focus();
  }
});
window.addEventListener('resize', positionComposerModelPanel);

function populateModelSelect(models, sourceLabel, options = {}) {
  if (modelHint) delete modelHint.dataset.i18n;
  const preserveCurrentModel = options.preserveCurrentModel !== false;
  modelSelect.innerHTML = "";
  modelSelect.disabled = !models || models.length === 0;
  if (!models || models.length === 0) {
    modelSelect.innerHTML = `<option value="">${t('settings.noModels')}</option>`;
    if (modelHint) modelHint.textContent = "";
    return;
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    const ctx = model.contextWindow ? ` (${model.contextWindow.toLocaleString()})` : "";
    option.textContent = `${model.name}${ctx}`;
    modelSelect.appendChild(option);
  }
  const preferredModel = customModelInput?.value?.trim() || state.currentModel;
  if (preserveCurrentModel && preferredModel) {
    const hasModel = Array.from(modelSelect.options).some((o) => o.value === preferredModel);
    if (!hasModel) {
      // Current model not in list — add it so it remains selectable
      const customOpt = document.createElement("option");
      customOpt.value = preferredModel;
      customOpt.textContent = `${preferredModel} (custom)`;
      modelSelect.insertBefore(customOpt, modelSelect.firstChild);
    }
    modelSelect.value = preferredModel;
    // Pre-fill custom model input if current model is not in the standard list
    if (customModelInput && !hasModel) {
      customModelInput.value = preferredModel;
    } else if (customModelInput) {
      customModelInput.value = "";
    }
  } else if (!preserveCurrentModel) {
    // Provider switched — clear stale custom model value
    if (customModelInput) customModelInput.value = "";
  }
  if (modelHint && sourceLabel) {
    modelHint.textContent = sourceLabel;
    modelHint.className = sourceLabel.startsWith("⚠") ? "setting-hint warning" : "setting-hint";
  }
}

function refreshModelsForProvider(provider) {
  if (!refreshModelsBtn || !modelRefreshStatus) return;

  // Providers that require API key for model listing
  const requiresApiKey = ["openai", "anthropic", "deepseek", "mistral", "google"];
  const apiKey = apiKeyInput?.value?.trim() || "";
  const baseUrl = baseUrlInput?.value?.trim() || PROVIDER_DEFAULTS[provider]?.baseUrl || "";

  if (requiresApiKey.includes(provider) && !apiKey) {
    modelRefreshStatus.textContent = `${provider}: ${t('settings.needApiKey')}`;
    modelRefreshStatus.className = "model-refresh-status error";
    setTimeout(() => { modelRefreshStatus.textContent = ""; }, 4000);
    return;
  }

  modelRefreshStatus.textContent = t('settings.fetchingModels') + '...';
  modelRefreshStatus.className = "model-refresh-status loading";
  refreshModelsBtn.disabled = true;

  sendCommand({ type: "refresh_models", provider, apiKey, baseUrl });
}

// ─── Sidebar Navigation & Page Views ──────────────────────────────────────────

function updateChatTitle() {
  const title = $("chat-title");
  title.textContent = state.activePanel === 'chat'
    ? state.currentSessionTitle || t('nav.chat')
    : t(`nav.${state.activePanel}`);
  title.title = title.textContent;
  // Dynamic session titles must survive language changes.
  title.removeAttribute('data-i18n');
}

function switchPanel(panelName) {
  state.activePanel = panelName;
  updateChatTitle();
  closeComposerMenus();
  sidebarNav.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.panel === panelName);
    btn.setAttribute("aria-current", btn.dataset.panel === panelName ? "page" : "false");
  });
  document.querySelectorAll("#sidebar-panels .panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === panelName);
  });

  // Page view handling
  const pageViews = ['skills', 'extensions', 'tools'];
  const chatElements = [
    document.querySelector('.header-actions'),
    document.getElementById('readonly-hint'),
    messagesContainer,
    document.querySelector('.input-area'),
    dragOverlay
  ].filter(Boolean);

  if (pageViews.includes(panelName)) {
    // Hide chat elements, show page view
    chatElements.forEach(el => el.style.display = 'none');
    pageViews.forEach(p => {
      const pv = document.getElementById(`${p}-page`);
      if (pv) pv.style.display = p === panelName ? 'flex' : 'none';
    });
    // Trigger data load
    if (panelName === 'skills') loadSkillsPage();
    else if (panelName === 'extensions') loadExtensionsPage();
    else if (panelName === 'tools') loadToolsPage();
  } else {
    // Show chat elements, hide page views
    chatElements.forEach(el => el.style.display = '');
    pageViews.forEach(p => {
      const pv = document.getElementById(`${p}-page`);
      if (pv) pv.style.display = 'none';
    });
  }
}

sidebarNav.addEventListener("click", (e) => {
  const navItem = e.target.closest(".nav-item");
  if (!navItem) return;
  const panel = navItem.dataset.panel;
  if (panel) switchPanel(panel);
  if (isVerySmallScreen()) collapseSidebar();
});

// ─── Sidebar Collapse/Expand ──────────────────────────────────────────────────

function isSmallScreen() { return window.innerWidth <= 1024; }
function isVerySmallScreen() { return window.innerWidth <= 768; }

function syncSidebarAccessibility() {
  const expanded = !state.sidebarCollapsed;
  for (const button of [sidebarToggle, sidebarCollapseBtn]) {
    button.setAttribute('aria-expanded', String(expanded));
    button.title = t(expanded ? 'nav.collapse' : 'nav.expand');
    button.setAttribute('aria-label', button.title);
  }
  document.querySelector('.main').inert = isVerySmallScreen() && expanded;
}

function collapseSidebar() {
  const hadFocus = sidebar.contains(document.activeElement);
  state.sidebarCollapsed = true;
  if (isSmallScreen()) sidebar.classList.remove("expanded");
  else sidebar.classList.add("collapsed");
  syncSidebarAccessibility();
  if (hadFocus) (isVerySmallScreen() ? sidebarToggle : sidebarCollapseBtn).focus();
}

function expandSidebar() {
  state.sidebarCollapsed = false;
  if (isSmallScreen()) sidebar.classList.add("expanded");
  else sidebar.classList.remove("collapsed");
  syncSidebarAccessibility();
  if (isVerySmallScreen()) sidebarCollapseBtn.focus();
}

function toggleSidebar() { state.sidebarCollapsed ? expandSidebar() : collapseSidebar(); }

let sidebarViewport = '';
function checkResponsive() {
  const viewport = isVerySmallScreen() ? 'mobile' : isSmallScreen() ? 'tablet' : 'desktop';
  // Keyboard appearance and small resizes must not dismiss an open drawer.
  if (viewport !== sidebarViewport) {
    sidebarViewport = viewport;
    sidebar.classList.remove("collapsed", "expanded");
    state.sidebarCollapsed = isSmallScreen();
  }
  syncSidebarAccessibility();
}

window.addEventListener("resize", checkResponsive);
checkResponsive();
sidebarCollapseBtn.addEventListener("click", toggleSidebar);
sidebarToggle.addEventListener("click", toggleSidebar);
$("sidebar-backdrop").addEventListener("click", collapseSidebar);

// Preserve the existing edge swipe while making dismissal deliberate.
let touchStartX = 0;
let touchStartY = 0;
document.addEventListener('touchstart', (event) => {
  touchStartX = event.touches[0].clientX;
  touchStartY = event.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchmove', (event) => {
  if (!isVerySmallScreen() || !state.sidebarCollapsed || touchStartX >= 24) return;
  if (event.touches[0].clientX - touchStartX > 50 && Math.abs(event.touches[0].clientY - touchStartY) < 100) expandSidebar();
}, { passive: true });

document.addEventListener('keydown', (event) => {
  if (document.querySelector('.modal-overlay.open')) return;
  if (event.key === 'Escape' && isVerySmallScreen() && !state.sidebarCollapsed) collapseSidebar();
  if (event.key !== 'Tab' || !isVerySmallScreen() || state.sidebarCollapsed) return;
  const controls = [...sidebar.querySelectorAll('button:not(:disabled), select, [tabindex="0"]')].filter(el => el.getClientRects().length);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

// ─── WebSocket Communication ──────────────────────────────────────────────────

const WEB_CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function webConnectionStorageKey() {
  return `hogagent_web_connection:${state.user}`;
}

function restoreWebConnectionId() {
  try {
    const stored = sessionStorage.getItem(webConnectionStorageKey());
    if (stored && WEB_CONNECTION_ID_RE.test(stored)) {
      state.webConnectionId = stored;
      state.reconnectTarget = stored;
      state.restoringPageConnection = true;
    }
  } catch { /* sessionStorage may be unavailable in restricted browsers */ }
}

function persistWebConnectionId(connectionId) {
  if (!WEB_CONNECTION_ID_RE.test(connectionId || '')) return;
  state.webConnectionId = connectionId;
  try { sessionStorage.setItem(webConnectionStorageKey(), connectionId); }
  catch { /* keep the in-memory reconnect path */ }
}

function requestRefreshHistoryReplay() {
  if (!state.pendingHistoryReplay || state.isBusy || !state.sessionId) return;
  state.pendingHistoryReplay = false;
  sendCommand({ type: "switch_session", session_id: state.sessionId, read_only: true });
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (state.ws) { try { state.ws.close(); } catch {} }
  const wsUrl = `${protocol}//${window.location.host}?user=${encodeURIComponent(state.user)}&token=${encodeURIComponent(webAuthToken)}`;
  let opened = false;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    opened = true;
    state.connected = true;
    state.reconnectAttempts = 0;
    setConnectionStatus("connected");
    // Reconnect by the stable Web process connection ID, never by the child’s
    // currently selected business Session ID.
    if (state.webConnectionId) {
      state.reconnectTarget = state.webConnectionId;
      state.ws.send(JSON.stringify({ type: "reconnect", session_id: state.webConnectionId }));
    }
    sendCommand({ type: "get_state" });
  };
  state.ws.onmessage = (event) => {
    try { handleServerMessage(JSON.parse(event.data)); }
    catch (err) { console.error("Invalid message:", event.data); }
  };
  state.ws.onclose = () => {
    state.connected = false;
    setConnectionStatus("disconnected");
    if (webAuthExpiry <= Date.now()) {
      reloadForWebAuthFailure();
      return;
    }
    if (!opened) {
      void handleWebSocketHandshakeFailure();
      return;
    }
    attemptReconnect();
  };
  state.ws.onerror = () => console.error("WebSocket connection error");
}

function attemptReconnect() {
  if (state.reconnectAttempts >= state.maxReconnectAttempts) {
    addStatusMessage(t('chat.disconnected'));
    return;
  }
  state.reconnectAttempts += 1;
  addStatusMessage(`${t('chat.reconnecting')} (${state.reconnectAttempts}/${state.maxReconnectAttempts})`);
  setTimeout(() => connect(), state.reconnectDelay * state.reconnectAttempts);
}

function sendCommand(command) {
  if (!state.connected || !state.ws) return;
  state.ws.send(JSON.stringify({ type: "rpc_command", command }));
}

function createPendingSend(text) {
  const files = state.uploadedFiles.map(file => Object.freeze({ ...file }));
  const mode = ["quick", "standard", "long_task"].includes(state.conversationMode)
    ? state.conversationMode
    : "standard";
  return Object.freeze({ text, files: Object.freeze(files), mode });
}

function rejectQuickAttachments(files = state.uploadedFiles) {
  if (state.conversationMode !== "quick" || files.length === 0) return false;
  addStatusMessage(t('chat.quickAttachmentsRequireStandard'));
  return true;
}

function sendPrompt(text) {
  // Allow sending with files even if text is empty.
  if (!text.trim() && state.uploadedFiles.length === 0) return;
  if (state.sessionTransition !== null) return;
  if (rejectQuickAttachments()) return;

  const pending = createPendingSend(text);
  clearWelcomeMessage();

  // If in read-only mode (historical session), auto-resume the session.
  if (state.isReadOnly && state.sessionId) {
    state.pendingSend = pending;
    state.sessionTransition = "resume";
    state.isReadOnly = false;
    updateReadOnlyIndicator(false);
    if (state.ws) {
      state.ws.send(JSON.stringify({ type: "rpc_command", command: { type: "resume_session", session_id: state.sessionId, mode: pending.mode } }));
      state.creatingSessionId = addStatusMessage(t('chat.resumingSession'), true);
    }
    updateActivityControls();
    return;
  }

  // If new session is still initializing, retain the immutable send snapshot.
  if (state.pendingNewSessionUI) {
    state.pendingSend = pending;
    state.sessionTransition = "new";
    updateActivityControls();
    return;
  }

  // Fallback: if needsNewSession flag is set (shouldn't happen with immediate send).
  if (state.needsNewSession) {
    state.needsNewSession = false;
    state.pendingSend = pending;
    state.sessionTransition = "new";
    if (state.ws) {
      state.ws.send(JSON.stringify({ type: "new_session" }));
      state.creatingSessionId = addStatusMessage(t('chat.creatingSession'), true);
    }
    updateActivityControls();
    return;
  }

  doSendPrompt(pending);
}

function doSendPrompt(pending) {
  const { text, files, mode } = pending;
  // Build final prompt text with file paths
  let finalText = text;
  if (files.length > 0) {
    const filePaths = files.map(f => f.path).join(", ");
    finalText = `[attached files: ${filePaths}]\n${text}`;
  }

  // Show original text in user bubble with attachment indicator
  let displayText = text.trim();
  if (files.length > 0) {
    const fileNames = files.map(f => f.name).join(", ");
    const attachmentLine = `\n\n📎 ${fileNames}`;
    displayText = displayText ? displayText + attachmentLine : `📎 ${fileNames}`;
  }
  addMessage("user", displayText);

  // Preserve the mode selected at the original send boundary.
  sendCommand({ type: "prompt", text: finalText, mode });

  // Consume only the snapshot that was sent. Draft text or attachments added
  // while a Session transition was resolving belong to the next message.
  const composerStillMatches = messageInput.value === text;
  if (composerStillMatches) {
    messageInput.value = "";
    messageInput.style.height = "auto";
  }
  const sentPaths = new Set(files.map(file => file.path));
  state.uploadedFiles = state.uploadedFiles.filter(file => !sentPaths.has(file.path));
  renderUploadPreview();
  // The selected Skill is encoded in text, so preserve a newer draft's tag.
  if (composerStillMatches) state.selectedSkill = null;
  updateSkillBtnState();

  state.isBusy = true;
  updateActivityControls();

  // Auto-generate session title from first meaningful message (>= 2 chars)
  if (!state.currentSessionTitle && text.trim().length >= 2) {
    state.currentSessionTitle = text.trim().slice(0, 30);
    loadSessionList();  // Refresh to show new title
  }
  if (state.activePanel !== "chat") switchPanel("chat");
}

function sendNewSession() {
  if (!state.connected || !state.ws || state.awaitingNewSession || state.pendingNewSessionUI || state.sessionTransition !== null) return;
  switchPanel("chat");
  if (isVerySmallScreen()) collapseSidebar();
  // Immediately notify server to kill old session and spawn new one
  if (state.ws) {
    state.ws.send(JSON.stringify({ type: "new_session" }));
    state.creatingSessionId = addStatusMessage(t('chat.creatingSession'), true);
  }
  // Block old session events from rendering while transition is in progress
  state.awaitingNewSession = true;
  state.pendingNewSessionUI = true; // Mark that we need to clear UI on next ready
  state.sessionTransition = "new";
  state.needsNewSession = false;
  updateActivityControls();
  // Keep old UI visible briefly; will clear on 'ready' event
}

// ─── Read-Only Indicator ─────────────────────────────────────────────────────

function updateReadOnlyIndicator(isReadOnly) {
  const inputArea = document.querySelector('.input-area');
  const hint = document.getElementById('readonly-hint');
  if (isReadOnly) {
    if (!hint && inputArea) {
      const el = document.createElement('div');
      el.id = 'readonly-hint';
      el.style.cssText = 'text-align:center;padding:4px 8px;font-size:12px;color:#e8a040;background:#f5f0e8;border-radius:6px 6px 0 0;';
      el.textContent = '📖 ' + t('chat.readOnlyMode');
      inputArea.parentNode.insertBefore(el, inputArea);
    }
  } else {
    if (hint) hint.remove();
  }
  updateActivityControls();
}

// ─── Session List ─────────────────────────────────────────────────────────────

function loadSessionList() {
  sendCommand({ type: "list_sessions" });
}

function switchToSession(sessionId) {
  switchPanel("chat");
  if (isVerySmallScreen()) collapseSidebar();
  if (sessionId === state.sessionId) return;  // Already on this session
  sendCommand({ type: "switch_session", session_id: sessionId });
}

function renderSessionList(sessions, currentSessionId) {
  const sessionList = document.getElementById("session-list");
  if (!sessionList) return;
  sessionList.innerHTML = "";
  // Find current session's title from server data
  const currentSessionData = sessions.find(s => s.id === currentSessionId);
  if (currentSessionData?.title && !state.currentSessionTitle) {
    state.currentSessionTitle = currentSessionData.title;
  }
  // Current session first
  const currentLi = document.createElement("li");
  currentLi.className = "session-item active";
  currentLi.dataset.session = "current";
  currentLi.setAttribute("aria-current", "true");
  const currentName = state.currentSessionTitle || currentSessionData?.title || `${t('chat.currentSession')} (${currentSessionId?.slice(0, 8) || "..."})`;
  currentLi.innerHTML = `<span class="session-name" title="${escapeHtml(currentName)}">${escapeHtml(currentName)}</span><span class="session-status ${state.connected ? 'connected' : 'disconnected'}">${state.connected ? t('chat.connected') : t('chat.disconnected')}</span>`;
  sessionList.appendChild(currentLi);
  updateChatTitle();
  // History sessions
  for (const s of sessions) {
    if (s.id === currentSessionId) continue;  // Skip current session
    const li = document.createElement("li");
    li.className = "session-item";
    li.dataset.session = s.id;
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const title = s.title || `${t('chat.session')} ${s.id.slice(0, 8)}`;
    const time = new Date(s.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    li.innerHTML = `<span class="session-name" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="session-time">${time}</span>`;
    // Click handler to switch session
    li.addEventListener("click", () => switchToSession(s.id));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        switchToSession(s.id);
      }
    });
    sessionList.appendChild(li);
  }
}

// ─── RPC Event Handling ───────────────────────────────────────────────────────

function buildDownloadFilename(filePath, sessionId) {
  const parts = filePath.split('/');
  const base = parts[parts.length - 1] || 'download';
  const dotIdx = base.lastIndexOf('.');
  const name = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx) : '';
  const sessionPrefix = sessionId ? sessionId.slice(0, 8) : '';
  return sessionPrefix ? `${name}-${sessionPrefix}${ext}` : base;
}

let markdownPreviewLoader;
async function openMarkdownDeliveryPreview(downloadUrl, name) {
  markdownPreviewLoader ||= import('./markdown-preview.js').then(module => module.createMarkdownPreview({
    overlay: document.getElementById('markdown-preview-modal'), fetchFile: authenticatedFetch, t,
  })).catch(error => { markdownPreviewLoader = undefined; throw error; });
  const preview = await markdownPreviewLoader;
  await preview.open({ downloadUrl, name });
}

function renderDeliveryCard(filePath, sessionId, fileSize, description, mimeType, receiptId) {
  if (!filePath) return;
  if (receiptId && Array.from(messagesContainer.querySelectorAll(".delivery-card")).some(card => card.dataset.receiptId === receiptId)) return;
  const downloadUrl = `/api/download?user=${encodeURIComponent(state.user)}&session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}${receiptId ? `&receipt=${encodeURIComponent(receiptId)}` : ""}`;
  const isImage = mimeType.startsWith("image/");
  const isMarkdown = /\.(md|markdown)$/i.test(filePath);
  const deliveryEl = createElement("div", "delivery-card");
  if (receiptId) deliveryEl.dataset.receiptId = receiptId;
  let previewHtml = "";
  if (isImage) {
    previewHtml = `<div class="delivery-preview"><img alt="${escapeHtml(filePath)}" class="delivery-image" /><div style="display:none;color:var(--text-muted);font-size:0.85rem;padding:0.5rem">${t('common.imageLoadFailed')}</div></div>`;
  }
  deliveryEl.innerHTML = `
    ${previewHtml}
    <div class="delivery-header">
      <span class="delivery-icon">${isImage ? "🖼️" : "📄"}</span>
      <div class="delivery-info">
        <div class="delivery-name">${escapeHtml(description !== filePath ? description : filePath)}</div>
        <div class="delivery-desc">${escapeHtml(description)}</div>
        <div class="delivery-size">${formatFileSize(fileSize)}</div>
      </div>
      ${isMarkdown ? `<button class="btn btn-ghost btn-sm delivery-markdown-preview">${t('delivery.preview')}</button>` : ''}
      <button class="btn btn-ghost btn-sm delivery-download" data-url="${downloadUrl}" data-filename="${escapeHtml(buildDownloadFilename(filePath, sessionId))}">${t('common.download')}</button>
    </div>
  `;
  const previewBtn = deliveryEl.querySelector('.delivery-markdown-preview');
  previewBtn?.addEventListener('click', async () => {
    if (previewBtn.getAttribute('aria-busy') === 'true') return;
    previewBtn.setAttribute('aria-busy', 'true');
    try { await openMarkdownDeliveryPreview(downloadUrl, filePath.split('/').pop()); }
    catch (error) { alert(`${t('delivery.previewFailed')}: ${error.message}`); }
    finally { previewBtn.removeAttribute('aria-busy'); }
  });
  const previewImage = deliveryEl.querySelector(".delivery-image");
  if (previewImage) {
    const showPreviewError = () => {
      previewImage.style.display = "none";
      if (previewImage.nextElementSibling) previewImage.nextElementSibling.style.display = "block";
    };
    authenticatedFetch(downloadUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        previewImage.onload = () => URL.revokeObjectURL(blobUrl);
        previewImage.onerror = () => { URL.revokeObjectURL(blobUrl); showPreviewError(); };
        previewImage.src = blobUrl;
      })
      .catch(showPreviewError);
  }
  const downloadBtn = deliveryEl.querySelector(".delivery-download");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const url = downloadBtn.getAttribute("data-url");
      const filename = downloadBtn.getAttribute("data-filename") || "download";
      authenticatedFetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => {
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
        })
        .catch((err) => {
          console.error("Download failed:", err);
          alert(`${t('common.downloadFailed')}: ${err.message}`);
        });
    });
  }
  messagesContainer.appendChild(deliveryEl);
}

function handleServerMessage(message) {
  // During session transition, discard old session's events to prevent content bleed
  if (state.awaitingNewSession && message.type === "rpc_event") return;
  switch (message.type) {
    case "rpc_event": handleRpcEvent(message.event || {}); break;
    case "connection_status":
      setConnectionStatus(message.status);
      if (message.status === "disconnected" && !state.awaitingNewSession) addStatusMessage(t('chat.connectionLost'));
      // connected arrives after old child is killed — lift event block so new child's ready can pass
      if (message.status === "connected" && state.awaitingNewSession) {
        state.awaitingNewSession = false;
      }
      break;
    case "error":
      if (state.reconnectTarget) {
        const provisionalReady = state.provisionalReconnectReady;
        state.reconnectTarget = null;
        state.restoringPageConnection = false;
        state.pendingHistoryReplay = false;
        state.provisionalReconnectReady = null;
        if (provisionalReady) {
          handleRpcEvent({ ...provisionalReady, _web_reconnect_fallback: true });
        }
      }
      if (state.sessionTransition === "resume") {
        state.isReadOnly = true;
        updateReadOnlyIndicator(true);
      }
      if (state.sessionTransition !== null) {
        state.sessionTransition = null;
        state.pendingSend = null;
        state.pendingNewSessionUI = false;
        state.awaitingNewSession = false;
        if (state.creatingSessionId) {
          removeStatusMessage(state.creatingSessionId);
          state.creatingSessionId = null;
        }
        updateActivityControls();
      }
      resetPendingSettings(message.error);
      addStatusMessage(`${t('common.error')}: ${message.error}`);
      break;
  }
}

// ─── Token Usage Tracking ─────────────────────────────────────────────────────

function resetUsage() {
  state.usageLog = [];
  state.usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
  state.subAgentUsage = [];
  state.auditUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  state.turnCount = 0;
}

function normalizeUsage(usage) {
  const count = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  const input = count(usage?.input), output = count(usage?.output);
  const cacheRead = count(usage?.cacheRead), cacheWrite = count(usage?.cacheWrite);
  return { input, output, cacheRead, cacheWrite,
    totalTokens: Math.max(count(usage?.totalTokens), input + output + cacheRead + cacheWrite) };
}

function accumulateAuditUsage(usage) {
  const normalized = normalizeUsage(usage);
  for (const key of Object.keys(normalized)) state.auditUsage[key] += normalized[key];
}

function accumulateUsage(usage) {
  state.turnCount++;
  const record = {
    turn: state.turnCount,
    ...normalizeUsage(usage),
    cost: (typeof usage.cost === "object" ? usage.cost?.total : usage.cost) || 0,
  };
  state.usageLog.push(record);
  state.usageTotals.input += record.input;
  state.usageTotals.output += record.output;
  state.usageTotals.cacheRead += record.cacheRead;
  state.usageTotals.cacheWrite += record.cacheWrite;
  state.usageTotals.totalTokens += record.totalTokens;
  state.usageTotals.totalCost += record.cost;
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// Combined totals: main-agent usage plus all sub-agent usage
function getCombinedTotals() {
  const m = state.usageTotals;
  const c = {
    input: m.input,
    output: m.output,
    cacheRead: m.cacheRead,
    cacheWrite: m.cacheWrite,
    totalTokens: m.totalTokens,
    totalCost: m.totalCost,
  };
  for (const s of state.subAgentUsage) {
    c.input += s.input || 0;
    c.output += s.output || 0;
    c.cacheRead += s.cacheRead || 0;
    c.cacheWrite += s.cacheWrite || 0;
    c.totalTokens += s.totalTokens || 0;
  }
  return c;
}

function renderTokenStatsModal() {
  const body = document.getElementById("token-stats-body");
  if (!body) return;
  if (state.usageLog.length === 0 && state.subAgentUsage.length === 0 && state.auditUsage.totalTokens === 0) {
    body.innerHTML = `<div class="token-stats-empty">${t('chat.tokenNoData')}</div>`;
    return;
  }
  const totals = getCombinedTotals();
  const showCache = true; // Always show cache when user explicitly opens modal
  // Cache hit rate: cacheRead / (input + cacheWrite + cacheRead)
  const inputBase = totals.input + totals.cacheWrite + totals.cacheRead;
  const hitRate = inputBase > 0 ? (totals.cacheRead / inputBase * 100).toFixed(1) : '0.0';
  const summaryHtml = `
    <div class="token-stats-summary">
      <div class="token-stat-item"><span class="token-stat-label">${t('chat.tokenInput')}</span><span class="token-stat-value">${formatTokenCount(totals.input)}</span></div>
      <div class="token-stat-item"><span class="token-stat-label">${t('chat.tokenCacheWrite')}</span><span class="token-stat-value">${formatTokenCount(totals.cacheWrite)}</span></div>
      <div class="token-stat-item"><span class="token-stat-label">${t('chat.tokenCacheRead')}</span><span class="token-stat-value">${formatTokenCount(totals.cacheRead)}</span></div>
      <div class="token-stat-item"><span class="token-stat-label">${t('chat.tokenOutput')}</span><span class="token-stat-value">${formatTokenCount(totals.output)}</span></div>
      <div class="token-stat-item"><span class="token-stat-label">${t('chat.tokenTotal')}</span><span class="token-stat-value token-stat-total">${formatTokenCount(totals.totalTokens)}</span></div>
      <div class="token-stat-item"><span class="token-stat-label">${t('chat.tokenCacheHitRate')}</span><span class="token-stat-value token-stat-hitrate">${hitRate}%</span></div>
    </div>`;
  // Formula notes: how each aggregate metric is derived
  const formulaHtml = `
    <div class="token-formula-note">
      <div>${t('chat.tokenFormulaTotalInput')}</div>
      <div>${t('chat.tokenFormulaHitRate')}</div>
      <div>${t('chat.tokenFormulaTotalTokens')}</div>
      <div>${t('chat.tokenFormulaCost')}</div>
    </div>`;
  const rows = state.usageLog.map(r => {
    const rInputBase = r.input + r.cacheWrite + r.cacheRead;
    const rHitRate = rInputBase > 0 ? (r.cacheRead / rInputBase * 100).toFixed(1) + '%' : '-';
    return `<tr><td>${r.turn}</td><td>${formatTokenCount(r.input)}</td><td>${formatTokenCount(r.cacheWrite)}</td>` +
    (showCache ? `<td>${formatTokenCount(r.cacheRead)}</td><td>${formatTokenCount(r.output)}</td>` : '') +
    `<td>${formatTokenCount(r.totalTokens)}</td><td>${rHitRate}</td></tr>`;
  }).join('');
  const tableHtml = `
    <table class="data-table token-stats-table">
      <thead><tr>
        <th>${t('chat.tokenTurn')}</th>
        <th>${t('chat.tokenInput')}</th>
        <th>${t('chat.tokenCacheWrite')}</th>
        ${showCache ? `<th>${t('chat.tokenCacheRead')}</th><th>${t('chat.tokenOutput')}</th>` : ''}
        <th>${t('chat.tokenTotal')}</th>
        <th>${t('chat.tokenCacheHitRate')}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  // Per-sub-agent usage tables below the main detail table
  let subAgentHtml = '';
  if (state.subAgentUsage.length > 0) {
    subAgentHtml = `<div class="token-subagent-title">${t('chat.tokenSubAgentTitle')}</div>`;
    subAgentHtml += `
    <table class="data-table token-stats-table token-subagent-table">
      <thead><tr>
        <th>${t('chat.tokenSubAgent')}</th>
        <th>${t('chat.tokenInput')}</th>
        <th>${t('chat.tokenCacheWrite')}</th>
        <th>${t('chat.tokenCacheRead')}</th>
        <th>${t('chat.tokenOutput')}</th>
        <th>${t('chat.tokenTotal')}</th>
        <th>${t('chat.tokenCacheHitRate')}</th>
      </tr></thead>
      <tbody>${state.subAgentUsage.map(s => {
        const sBase = s.input + s.cacheWrite + s.cacheRead;
        const sRate = sBase > 0 ? (s.cacheRead / sBase * 100).toFixed(1) + '%' : '-';
        // Shorten long ids (e.g. UUIDs) to "first8...last8" to keep the column narrow
        const shortId = s.id.length > 19 ? s.id.slice(0, 8) + '...' + s.id.slice(-8) : s.id;
        return `<tr><td title="${escapeHtml(s.id)}">${escapeHtml(shortId)}</td><td>${formatTokenCount(s.input)}</td><td>${formatTokenCount(s.cacheWrite)}</td>` +
          `<td>${formatTokenCount(s.cacheRead)}</td><td>${formatTokenCount(s.output)}</td>` +
          `<td>${formatTokenCount(s.totalTokens)}</td><td>${sRate}</td></tr>`;
      }).join('')}</tbody>
    </table>`;
  }
  // Audit LLM usage summary line
  let auditHtml = '';
  if (state.auditUsage.totalTokens > 0) {
    const au = state.auditUsage;
    const auBase = au.input + au.cacheWrite + au.cacheRead;
    const auHitRate = auBase > 0 ? (au.cacheRead / auBase * 100).toFixed(1) : '0.0';
    auditHtml = `<div class="token-audit-line" style="margin-top:12px;font-size:11px;color:#64748b;">${t('chat.tokenAuditLLM')}: ${t('chat.tokenInput')} ${formatTokenCount(au.input)} ${t('chat.tokenCacheWrite')} ${formatTokenCount(au.cacheWrite)} ${t('chat.tokenCacheRead')} ${formatTokenCount(au.cacheRead)} ${t('chat.tokenOutput')} ${formatTokenCount(au.output)} ${t('chat.tokenTotal')} ${formatTokenCount(au.totalTokens)} ${t('chat.tokenCacheHitRate')} ${auHitRate}%</div>`;
  }
  body.innerHTML = summaryHtml + formulaHtml + auditHtml + tableHtml + subAgentHtml;
}

// Token stats modal events
const tokenStatsBtn = $("token-stats-btn");
const tokenStatsModal = $("token-stats-modal");
const closeTokenStatsBtn = $("close-token-stats");
if (tokenStatsBtn) {
  tokenStatsBtn.addEventListener("click", () => {
    renderTokenStatsModal();
    if (tokenStatsModal) tokenStatsModal.classList.add("open");
  });
}
if (closeTokenStatsBtn) {
  closeTokenStatsBtn.addEventListener("click", () => {
    if (tokenStatsModal) tokenStatsModal.classList.remove("open");
  });
}
if (tokenStatsModal) {
  tokenStatsModal.addEventListener("click", (e) => {
    if (e.target === tokenStatsModal) tokenStatsModal.classList.remove("open");
  });
}

function updateToolCapabilities(tools) {
  if (!Array.isArray(tools)) return;
  state.capabilities = { ...state.capabilities, builtin_tools: tools };
  renderCapabilities(state.capabilities);
}

function updateSystemConfigControls(capabilities) {
  if (!capabilities) return;
  state.capabilities = { ...state.capabilities, ...(capabilities.systemConfig ? { systemConfig: capabilities.systemConfig } : {}) };
  if (capabilities?.systemConfig?.explicitCache !== undefined || capabilities?.explicitCache !== undefined) {
    const toggle = document.getElementById("explicit-cache-toggle");
    if (toggle) toggle.checked = capabilities.systemConfig?.explicitCache ?? capabilities.explicitCache;
  }
  if (capabilities?.systemConfig) {
    const sysCfg = capabilities.systemConfig;
    const sandboxModeSelect = document.getElementById("sandbox-mode-select");
    if (sandboxModeSelect && sysCfg.sandboxMode !== undefined) {
      sandboxModeSelect.value = sysCfg.sandboxMode;
    }
    const cacheStatsToggle = document.getElementById("show-cache-stats-toggle");
    if (cacheStatsToggle && sysCfg.showCacheStats !== undefined) {
      cacheStatsToggle.checked = sysCfg.showCacheStats;
    }
    const compressorToggle = document.getElementById("compressor-enabled-toggle");
    if (compressorToggle && sysCfg.compressorEnabled !== undefined) {
      compressorToggle.checked = sysCfg.compressorEnabled;
    }
    const thresholdInput = document.getElementById("compress-threshold");
    if (thresholdInput && sysCfg.compressThreshold !== undefined) {
      thresholdInput.value = String(sysCfg.compressThreshold);
    }
    const maxTurnsInput = document.getElementById("subagent-max-turns");
    if (maxTurnsInput && sysCfg.subagentMaxTurns !== undefined) {
      maxTurnsInput.value = String(sysCfg.subagentMaxTurns);
    }
    const memoryToggle = document.getElementById("memory-enabled-toggle");
    if (memoryToggle && sysCfg.memoryEnabled !== undefined) {
      memoryToggle.checked = sysCfg.memoryEnabled;
    }
    const memoryUrlInput = document.getElementById("memory-mcp-kb-url");
    if (memoryUrlInput && sysCfg.memoryMcpKbUrl !== undefined) {
      memoryUrlInput.value = String(sysCfg.memoryMcpKbUrl);
    }
  }
}

function handleRpcEvent(event) {
  if (event.type === 'settings_saved' || event.type === 'config_reloaded') {
    updateToolCapabilities(event.builtin_tools);
    updateSystemConfigControls(event);
  }
  if (handleComposerModels(event)) return;
  switch (event.type) {
    case "ready": {
      // A reconnecting socket owns a short-lived child until the server accepts
      // or rejects the stable connection ID. Its ready event is provisional and
      // must not replace the stored ID or cancel full-page history recovery.
      const provisionalReconnect = !!state.reconnectTarget
        && !event._reconnect
        && event._web_reconnect_fallback !== true;
      if (provisionalReconnect) state.provisionalReconnectReady = event;
      if (!provisionalReconnect && event._web_connection_id) {
        persistWebConnectionId(event._web_connection_id);
      }
      if (event._reconnect) {
        const restoreHistory = state.restoringPageConnection;
        state.reconnectTarget = null;
        state.restoringPageConnection = false;
        state.provisionalReconnectReady = null;
        state.isBusy = event._web_busy === true;
        if (restoreHistory) state.pendingHistoryReplay = true;
      } else if (!provisionalReconnect && !event._serverInit) {
        // A normal child ready with a different connection ID is the existing
        // dead-process fallback. It intentionally starts a clean Session.
        state.reconnectTarget = null;
        state.restoringPageConnection = false;
        state.pendingHistoryReplay = false;
        state.provisionalReconnectReady = null;
        state.isBusy = event._web_busy === true;
      }
      // End the transition: new session is ready — clear old UI
      if (state.pendingNewSessionUI && !provisionalReconnect) {
        state.pendingNewSessionUI = false;
        state.followLatestMessages = true;
        messagesContainer.replaceChildren(welcomeMessage);
        applyI18n();
        state.messages = [];
        state.pendingAuthoritativeMessageId = null;
        state.currentSessionTitle = null;
        updateChatTitle();
        state.internalMode = false;
        state.isReadOnly = false;
        updateReadOnlyIndicator(false);
        state.hasSentFirstMessage = false;
        // Preserve user's selected conversation mode (don't force-reset to "standard")
        if (state.pendingSend === null) {
          state.uploadedFiles = [];
          renderUploadPreview();
        }
        state.isBusy = false;
        updateActivityControls();
        // Reset usage tracking for new session
        resetUsage();
      }
      if (!provisionalReconnect && event.session_id) state.sessionId = event.session_id;
      // On reconnect, preserve existing UI state (reconnect ready event has incomplete capabilities)
      if (event._reconnect) updateToolCapabilities(event.capabilities?.builtin_tools);
      if (!event._reconnect) {
        state.capabilities = event.capabilities;
        if (!provisionalReconnect) {
          state.internalMode = false;
          state.isReadOnly = false;
          updateReadOnlyIndicator(false);
        }
        renderCapabilities(event.capabilities);
        renderSkills(event.capabilities);
        renderExtensions(event.capabilities);
        if (event.capabilities?.llmProvider) {
        const lp = event.capabilities.llmProvider;
        state.currentProvider = lp.provider || state.currentProvider;
        // Only overwrite apiKey/baseUrl when the server actually provides them.
        // The HogAgent child process ready omits apiKey (for safety); using
        // `lp.apiKey || ""` would clobber the real key sent by _serverInit.
        // Also reject masked keys ("****xxxx") that old HogAgent builds may send.
        if (typeof lp.apiKey === "string" && !lp.apiKey.startsWith("****")) state.currentApiKey = lp.apiKey;
        if (typeof lp.baseUrl === "string") state.currentBaseUrl = lp.baseUrl;
        // Cache all provider API keys if provided
        if (lp.providerApiKeys) {
          state.providerApiKeys = { ...lp.providerApiKeys };
        }
        // The active key is authoritative even when an older settings file has
        // an empty/missing providerApiKeys cache.
        if (lp.provider && typeof lp.apiKey === "string" && !lp.apiKey.startsWith("****")) {
          if (lp.apiKey) state.providerApiKeys[lp.provider] = lp.apiKey;
          else delete state.providerApiKeys[lp.provider];
        }
        if (providerSelect && lp.provider) providerSelect.value = lp.provider;
        if (baseUrlInput && lp.baseUrl) baseUrlInput.placeholder = lp.baseUrl;
        updateCurrentProviderDisplay();
      }
      if (event.capabilities?.currentModel) {
        state.currentModel = event.capabilities.currentModel;
        const hasModel = Array.from(modelSelect.options).some((o) => o.value === state.currentModel);
        if (!hasModel && customModelInput) {
          customModelInput.value = state.currentModel;
        } else if (hasModel) {
          modelSelect.value = state.currentModel;
          if (customModelInput) customModelInput.value = "";
        }
      }
      if (event.capabilities?.thinkingLevel) {
        state.currentThinkingLevel = event.capabilities.thinkingLevel;
        const idx = THINKING_LEVELS.indexOf(event.capabilities.thinkingLevel);
        if (thinkingLevelInput && idx >= 0) thinkingLevelInput.value = String(idx);
      }
      // Populate audit model settings from capabilities
      if (event.capabilities?.auditModel) {
        const am = event.capabilities.auditModel;
        if (am.configured && am.provider && am.provider !== "close") {
          state.auditConfigured = true;
          const { apiKey, ...fields } = am;
          state.auditSettings = { ...(state.auditSettings.provider === am.provider ? state.auditSettings : {}), ...fields };
          if (typeof apiKey === "string" && !apiKey.startsWith("****")) state.auditSettings.apiKey = apiKey;
        } else {
          // Audit not configured — show provider selector only
          state.auditConfigured = false;
          state.auditSettings = {};
        }
        prefillAuditSettings();
      }
      } // end if (!event._reconnect)
      updateSystemConfigControls(event.capabilities);
      updateIndicators();
      if (!provisionalReconnect) addStatusMessage(`${t('chat.ready')} (${event.session_id?.slice(0, 8)}...)`);
      // Auto-fetch models from provider (no server-side cache)
      // Skip for _serverInit — the HogAgent child ready will trigger it with complete state
      if (!event._serverInit && !provisionalReconnect) autoFetchModelsOnReady();
      // Remove "creating/resuming session..." status message
      if (!provisionalReconnect && state.creatingSessionId) {
        removeStatusMessage(state.creatingSessionId);
        state.creatingSessionId = null;
      }
      // Load session list only when HogAgent child is truly ready
      // Skip for: server init, resume, and reconnect (each has its own list refresh path)
      if (!event._serverInit && !event._resumed && !event._reconnect && !provisionalReconnect) {
        loadSessionList();
      }
      // Restore mode selector state (from resume_session or reconnect ready event)
      // Skip if pendingSend exists — its frozen mode owns this transition.
      if (!provisionalReconnect && ["quick", "standard", "long_task"].includes(event.mode)
        && modeSelector && state.pendingSend === null) {
        state.conversationMode = event.mode;
        modeSelector.value = event.mode;
        if (modeHint) {
          updateModeHint(event.mode);
        }
        updateSkillBtnState();
      } else if (event._reconnect) {
        // Reconnect without mode info — preserve current mode state, no reset
      }
      // Flush one immutable pending send after the authoritative child ready.
      if (!provisionalReconnect && state.pendingSend !== null) {
        const pending = state.pendingSend;
        state.pendingSend = null;
        state.sessionTransition = null;
        updateActivityControls();
        doSendPrompt(pending);
      } else if (!provisionalReconnect && state.sessionTransition !== null) {
        state.sessionTransition = null;
        updateActivityControls();
      }
      requestRefreshHistoryReplay();
      break;
    }

    case "state":
      state.currentModel = event.model;
      state.currentThinkingLevel = event.thinking_level || state.currentThinkingLevel;
      if (event.provider) {
        state.currentProvider = event.provider;
        if (providerSelect) providerSelect.value = event.provider;
      }
      if (event.base_url) {
        state.currentBaseUrl = event.base_url;
        if (baseUrlInput) baseUrlInput.placeholder = event.base_url;
      }
      if (["quick", "standard", "long_task"].includes(event.mode) && state.pendingSend === null) {
        state.conversationMode = event.mode;
        if (modeSelector) modeSelector.value = event.mode;
        if (modeHint) updateModeHint(event.mode);
        updateSkillBtnState();
      }
      if (event.session_id) state.sessionId = event.session_id;
      updateCurrentProviderDisplay();
      updateIndicators();
      break;

    case "message_start":
      if (event.role === "user") break;
      clearWelcomeMessage();
      if (state.internalMode) {
        // Internal mode: start a new thinking section instead of a bubble
        state.currentThinkingSection = null;  // Force new section
        state.streamingMessageId = null;
      } else {
        state.streamingThinkingId = null;  // Reset thinking for new message
        state.currentThinkingSection = null;  // Close thinking section before bubble
        // Defer the bubble until the first text delta. A reasoning model can emit
        // thinking after message_start; pre-creating the bubble would place the
        // later thinking section below the final answer in DOM order.
        state.streamingMessageId = null;
      }
      break;

    case "thinking_start": {
      // Show a centered, small, light-colored "thinking..." indicator (not a bubble)
      clearWelcomeMessage();
      if (!state.thinkingIndicatorId) {
        const id = `thinking-ind-${Date.now()}`;
        const el = createElement("div", "thinking-indicator");
        el.id = id;
        el.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div><span>thinking</span>`;
        messagesContainer.appendChild(el);
        autoScroll();
        state.thinkingIndicatorId = id;
      }
      break;
    }

    case "thinking_end": {
      if (event.session_id && state.sessionId && event.session_id !== state.sessionId) break;
      // Remove the "thinking..." indicator
      if (state.thinkingIndicatorId) {
        const el = document.getElementById(state.thinkingIndicatorId);
        if (el) el.remove();
        state.thinkingIndicatorId = null;
      }
      // Capture usage from internal-mode assistant messages
      if (event.usage) {
        if (event.source === "audit") {
          // Audit LLM usage: accumulate separately, do NOT add to main totals
          accumulateAuditUsage(event.usage);
        } else {
          accumulateUsage(event.usage);
        }
      }
      break;
    }

    case "thinking": {
      // Render thinking content in a collapsible section
      const delta = event.delta || "";
      if (!delta) break;
      appendThinkingSection(delta, t('chat.thinkingProcess'));
      break;
    }

    case "message_update": {
      clearWelcomeMessage();
      const delta = event.delta || "";
      if (typeof delta !== "string" || delta.length === 0) break;
      if (state.internalMode) {
        // Internal mode: append to thinking section instead of bubble
        appendThinkingSection(delta, t('chat.executionProcess'));
      } else {
        if (!state.streamingMessageId) state.streamingMessageId = addMessage(event.role || "assistant", "");
        updateMessage(state.streamingMessageId, delta);
      }
      break;
    }

    case "message_end": {
      // Capture usage from assistant messages (non-internal mode)
      if (event.usage) {
        accumulateUsage(event.usage);
      }
      // Remove empty assistant bubbles (message_start created but no content received)
      let completedMessageId = state.streamingMessageId;
      if (completedMessageId) {
        const msgEl = messagesContainer.querySelector(`[data-id="${completedMessageId}"]`);
        if (msgEl) {
          const contentEl = msgEl.querySelector(".message-content");
          if (contentEl && !contentEl.textContent.trim()) {
            msgEl.remove();
            state.messages = state.messages.filter(m => m.id !== completedMessageId);
            completedMessageId = null;
          }
        }
      }
      state.pendingAuthoritativeMessageId = completedMessageId;
      state.streamingMessageId = null;
      state.streamingThinkingId = null;
      // Clean up thinking indicator if still present
      if (state.thinkingIndicatorId) {
        const el = document.getElementById(state.thinkingIndicatorId);
        if (el) el.remove();
        state.thinkingIndicatorId = null;
      }
      // Close current thinking section on message_end (so next event starts fresh)
      if (state.internalMode) {
        state.currentThinkingSection = null;
      }
      break;
    }
    case "turn_start":
      state.pendingAuthoritativeMessageId = null;
      state.turnStatusId = addStatusMessage(t('chat.thinking'), true);
      updateActivityControls();
      break;
    case "turn_end":
      if (state.turnStatusId) { removeStatusMessage(state.turnStatusId); state.turnStatusId = null; }
      // message_update streams the raw model text. When the runtime recognizes a
      // delivery_decision, turn_end.content is the authoritative user-visible
      // text with that control envelope removed. Correct the existing bubble in
      // place so the WebUI does not leave the JSON visible or add a second bubble.
      if (event.delivery_decision !== undefined && state.pendingAuthoritativeMessageId) {
        replaceMessageContent(state.pendingAuthoritativeMessageId, event.content || "");
      }
      state.pendingAuthoritativeMessageId = null;
      abortBtn.disabled = true;
      break;

    case "tool_execution_start": {
      const id = event.tool_call_id || `tool-${Date.now()}`;
      state.pendingToolCalls.set(id, { name: event.tool_name, args: event.args });
      addToolActivity(id, event.tool_name, event.args, "running");
      break;
    }
    case "tool_execution_update": {
      const id = event.tool_call_id || `tool-${Date.now()}`;
      if (event.output || event.result) {
        const toolEl = document.getElementById(id);
        if (toolEl) toolEl.querySelector(".tool-body pre").textContent += "\n" + JSON.stringify(event.output || event.result, null, 2);
      }
      break;
    }
    case "tool_execution_end": {
      const id = event.tool_call_id || `tool-${Date.now()}`;
      state.pendingToolCalls.delete(id);
      updateToolStatus(id, event.is_error ? "error" : "success");
      break;
    }

    case "models_refreshed":
      // Server returned refreshed model list for a provider
      if (event.models?.length && event.provider) {
        const target = event.target || "main";
        state.providerModels[event.provider] = event.models;
        if (target === "audit" && event.provider !== auditProviderSelect?.value) break;
        if (target !== "audit" && event.provider !== providerSelect?.value) break;

        if (target === "audit") {
          // Update audit model select
          if (auditModelSelect) {
            const currentAuditModel = customAuditModelInput?.value?.trim() || auditModelSelect.value;
            const options = event.models.map((model) => {
              const option = document.createElement("option");
              option.value = model.id;
              option.textContent = `${model.name} (${model.contextWindow})`;
              return option;
            });
            const hasCurrentModel = currentAuditModel
              && event.models.some((model) => model.id === currentAuditModel);
            if (currentAuditModel && !hasCurrentModel) {
              const option = document.createElement("option");
              option.value = currentAuditModel;
              option.textContent = `${currentAuditModel} (custom)`;
              options.unshift(option);
              if (customAuditModelInput) customAuditModelInput.value = currentAuditModel;
            } else if (hasCurrentModel && customAuditModelInput) {
              customAuditModelInput.value = "";
            }
            auditModelSelect.replaceChildren(...options);
            if (currentAuditModel) auditModelSelect.value = currentAuditModel;
            auditModelSelect.disabled = false;
            if (auditModelRefreshStatus) {
              auditModelRefreshStatus.textContent = t('settings.fetchedModels', { count: event.models.length });
              auditModelRefreshStatus.className = "setting-hint success";
            }
          }
        } else {
          // Only preserve currentModel if it belongs to the same provider
          const isSameProvider = event.provider === state.currentProvider;
          populateModelSelect(event.models, `${t('settings.updated')} · ${event.provider}`, { preserveCurrentModel: isSameProvider });
          if (!isSameProvider) {
            const defaultModelId = PROVIDER_DEFAULTS[event.provider]?.modelId;
            if (defaultModelId && event.models.some((model) => model.id === defaultModelId)) {
              modelSelect.value = defaultModelId;
            }
          }
          if (modelRefreshStatus) {
            modelRefreshStatus.textContent = `${t('settings.fetchedModels', { count: event.models.length })}`;
            modelRefreshStatus.className = "model-refresh-status success";
            setTimeout(() => { modelRefreshStatus.textContent = ""; }, 3000);
          }
          if (refreshModelsBtn) refreshModelsBtn.disabled = false;
        }
      }
      break;

    case "skill_installed":
      addStatusMessage(`${t('skills.skillInstalled')}: ${event.name}`);
      if (state.capabilities) {
        if (!state.capabilities.installed_skills) state.capabilities.installed_skills = [];
        state.capabilities.installed_skills.push(event.name);
        renderSkills(state.capabilities);
      }
      break;

    case "skill_install_skipped":
      addStatusMessage(`技能 ${event.name} 已安装 v${event.existingVer}，上传版本 v${event.incomingVer} 不更新，已跳过。`);
      break;

    case "skill_configured":
      addStatusMessage(`${t('skills.configured')}: ${event.name}`);
      break;

    case "error": {
      if (event.target === "audit" && event.provider && event.provider !== auditProviderSelect?.value) break;
      if (event.target === "main" && event.provider && event.provider !== providerSelect?.value) break;
      const errorText = event.error || event.message || t('common.unknownError');
      if (event.command_type === "resume_session" && state.sessionTransition === "resume") {
        state.sessionTransition = null;
        state.pendingSend = null;
        state.isReadOnly = true;
        updateReadOnlyIndicator(true);
        if (state.creatingSessionId) {
          removeStatusMessage(state.creatingSessionId);
          state.creatingSessionId = null;
        }
      } else if (event.command_type === "new_session" && state.sessionTransition === "new") {
        state.sessionTransition = null;
        state.pendingSend = null;
        state.pendingNewSessionUI = false;
        state.awaitingNewSession = false;
      }
      // Skip chat error display for model refresh errors (non-chat operations)
      if (event.target !== "audit" && event.target !== "main") {
        // If there's an empty assistant message bubble (LLM failed before producing text), update it
        if (state.streamingMessageId) {
          const msgEl = messagesContainer.querySelector(`[data-id="${state.streamingMessageId}"]`);
          if (msgEl) {
            const contentEl = msgEl.querySelector(".message-content");
            if (contentEl && (!contentEl.textContent || !contentEl.textContent.trim())) {
              contentEl.innerHTML = renderMarkdown(`⚠️ **${t('common.error')}:** ${errorText}`);
              msgEl.classList.add("error-message");
            }
          }
          state.streamingMessageId = null;
        } else {
          // Check last assistant message bubble
          const lastMsg = messagesContainer.lastElementChild;
          if (lastMsg && lastMsg.classList.contains("assistant")) {
            const contentEl = lastMsg.querySelector(".message-content");
            if (contentEl && (!contentEl.textContent || !contentEl.textContent.trim())) {
              contentEl.innerHTML = renderMarkdown(`⚠️ **${t('common.error')}:** ${errorText}`);
              lastMsg.classList.add("error-message");
            } else {
              addStatusMessage(`${t('common.error')}: ${errorText}`);
            }
          } else {
            addStatusMessage(`${t('common.error')}: ${errorText}`);
          }
        }
      } else if (event.target === "main") {
        // Main model refresh error — show in status area only
        addStatusMessage(`${t('common.error')}: ${errorText}`);
      }
      // Main model refresh loading state
      if (event.target !== "audit" && modelRefreshStatus && modelRefreshStatus.className.includes("loading")) {
        modelRefreshStatus.textContent = t('settings.fetchFailedManual');
        modelRefreshStatus.className = "model-refresh-status error";
        if (refreshModelsBtn) refreshModelsBtn.disabled = false;
      }
      // Audit model refresh error
      if (event.target === "audit" && auditModelSelect) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = t('settings.noModels');
        auditModelSelect.replaceChildren(option);
        auditModelSelect.disabled = false;
        if (auditModelRefreshStatus) {
          auditModelRefreshStatus.textContent = t('settings.fetchFailedManual');
          auditModelRefreshStatus.className = "setting-hint warning";
        }
      }
      // Reset busy state after error (skip for model refresh operations)
      if (!event.target) {
        state.isBusy = false;
        resetPendingSettings(errorText);
        updateActivityControls();
      }
      break;
    }

    case "model_changed": state.currentModel = event.model_id; updateIndicators(); break;
    case "thinking_level_changed": state.currentThinkingLevel = event.level; updateIndicators(); break;
    case "session_created": {
      // Remove "creating session..." status message
      if (state.creatingSessionId) {
        removeStatusMessage(state.creatingSessionId);
        state.creatingSessionId = null;
      }
      state.sessionId = event.session_id;
      addStatusMessage(`${t('chat.newSession')}: ${event.session_id?.slice(0, 8)}...`)
      // Refresh session list after creating new session
      loadSessionList();
      break;
    }
    case "session_list": {
      renderSessionList(event.sessions || [], event.current_session_id);
      break;
    }
    case "session_switched": {
      // Clear current chat and load session history
      state.followLatestMessages = true;
      messagesContainer.innerHTML = "";
      state.messages = [];
      state.pendingAuthoritativeMessageId = null;
      state.sessionId = event.session_id;
      state.currentSessionTitle = event.title || null;
      updateChatTitle();
      state.internalMode = false;  // Reset internal mode on session switch
      state.isReadOnly = true;     // Historical sessions are read-only until user sends a message
      updateReadOnlyIndicator(true);  // Show visual indicator
      // Cancel any pending transitions from previous session
      state.pendingSend = null;
      state.sessionTransition = null;
      state.pendingNewSessionUI = false;
      state.awaitingNewSession = false;
      state.isBusy = false;
      state.isCompacting = false;
      updateActivityControls();
      // Reset usage tracking, then restore historical usage from session data
      resetUsage();
      if (event.usageHistory && Array.isArray(event.usageHistory)) {
        for (const u of event.usageHistory) {
          accumulateUsage(u);
        }
      }
      // Restore per-sub-agent stats persisted in the session task dir
      if (event.subAgentUsage && Array.isArray(event.subAgentUsage)) {
        state.subAgentUsage = event.subAgentUsage.map(s => ({
          id: s.id || '',
          status: s.status || '',
          ...normalizeUsage(s),
        }));
      }
      // Restore audit LLM usage persisted in the session task dir
      if (event.auditUsage && Array.isArray(event.auditUsage)) {
        for (const rec of event.auditUsage) {
          const u = rec.usage || rec;
          accumulateAuditUsage(u);
        }
      }
      // Restore mode from target session's mode.json (default to "standard" if none)
      const targetMode = event.mode || "standard";
      state.conversationMode = targetMode;
      if (modeSelector) {
        modeSelector.value = targetMode;
        if (modeHint) {
          updateModeHint(targetMode);
        }
        updateSkillBtnState();
      }
      // Render message history — distinguish thinking sections from regular bubbles
      const messages = event.messages || [];
      for (const msg of messages) {
        if (!msg.content || !msg.content.trim()) continue;
        if (msg.type === "thinking") {
          // Render as collapsed thinking section (was shown as thinking_* during live session)
          // thinking-section defaults to collapsed (body hidden by CSS), toggle uses 'expanded' class
          const thinkEl = createElement("div", "thinking-section");
          const id = `think-hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          thinkEl.id = id;
          thinkEl.innerHTML = `<div class="thinking-section-header"><span class="thinking-section-arrow">▶</span><span>${t('chat.thinkingProcess')}</span></div><div class="thinking-section-body"></div>`;
          thinkEl.querySelector(".thinking-section-header").addEventListener("click", () => {
            thinkEl.classList.toggle("expanded");
          });
          const body = thinkEl.querySelector(".thinking-section-body");
          if (body) body.textContent = msg.content;
          messagesContainer.appendChild(thinkEl);
        } else {
          addMessage(msg.role, msg.content);
        }
      }
      // Render the delivery records returned with session history. Filename
      // conventions do not reconstruct delivery state.
      const historyFiles = event.files || [];
      for (const f of historyFiles) {
        renderDeliveryCard(f.path, event.session_id, f.size || 0, f.description || f.name || f.path, f.mime_type || "application/octet-stream", f.id);
      }
      addStatusMessage(`${t('chat.switchedSession')}: ${event.session_id?.slice(0, 8)}...`)
      // Refresh session list to update active state
      loadSessionList();
      break;
    }
    case "internal_mode":
      state.internalMode = !!event.active;
      if (state.internalMode) {
        // Entering internal mode — close current thinking section to start fresh
        state.currentThinkingSection = null;
        clearWelcomeMessage();
      } else {
        // Leaving internal mode — close thinking section, next message will be a bubble
        state.currentThinkingSection = null;
      }
      break;

    case "compact_started":
      state.isCompacting = true;
      updateActivityControls();
      break;
    case "compact_completed":
      state.isCompacting = false;
      updateActivityControls();
      break;
    case "compact_failed": {
      state.isCompacting = false;
      updateActivityControls();
      break;
    }
    case "session_compact":
      // Legacy observation only; compact_* events own lifecycle state.
      break;
    case "status_update": addStatusMessage(event.message || event.status || t('chat.statusUpdate')); break;
    case "warning": addWarningMessage(event.message || ''); break;
    case "todo_list": renderTodoList(event.tasks || event.items || []); break;
    case "aborted":
      addStatusMessage(t('chat.aborted'));
      state.isBusy = false;
      state.isCompacting = false;
      updateActivityControls();
      requestRefreshHistoryReplay();
      break;
    case "agent_end":
      state.isBusy = event._web_busy === true;
      if (event.reason === "unexpected_exit" || event.reason === "context_compaction_failed") {
        state.isCompacting = false;
      }
      updateActivityControls();
      requestRefreshHistoryReplay();
      break;

    case "delivery": {
      if (!event.id || !event.path || event.session_id !== state.sessionId) break;
      renderDeliveryCard(
        event.path || "",
        event.session_id || "",
        event.size || 0,
        event.description || event.path || "",
        event.mime_type || "application/octet-stream",
        event.id,
      );
      autoScroll();
      break;
    }

    case "api_key_test_result": {
      if (!testApiKeyBtn || !apiKeyStatus) break;
      testApiKeyBtn.disabled = false;
      testApiKeyBtn.classList.remove("testing");
      if (event.success) {
        apiKeyStatus.textContent = "✓ " + (t('settings.keyValid') || "Connection successful");
        apiKeyStatus.className = "api-key-status success";
      } else {
        apiKeyStatus.textContent = "✗ " + (event.error || t('settings.keyInvalid') || "Connection failed");
        apiKeyStatus.className = "api-key-status error";
      }
      setTimeout(() => { apiKeyStatus.textContent = ""; apiKeyStatus.className = "api-key-status"; }, 5000);
      break;
    }
    case "settings_saved": {
      saveSettingsBtn.disabled = false;
      const fromComposer = state.pendingLlmSettings?.source === 'composer';
      // Backend confirmation — only show after actual save succeeds
      const savedProvider = event.provider;
      if (state.pendingLlmSettings) {
        state.currentProvider = state.pendingLlmSettings.provider;
        state.currentApiKey = state.pendingLlmSettings.apiKey;
        state.currentBaseUrl = state.pendingLlmSettings.baseUrl;
        state.currentModel = state.pendingLlmSettings.modelId;
        state.currentThinkingLevel = state.pendingLlmSettings.thinkingLevel;
        if (state.pendingLlmSettings.auditConfigured !== undefined) {
          state.auditConfigured = state.pendingLlmSettings.auditConfigured;
        }
        if (state.pendingLlmSettings.audit) state.auditSettings = state.pendingLlmSettings.audit;
        if (state.pendingLlmSettings.providerApiKeys) state.providerApiKeys = state.pendingLlmSettings.providerApiKeys;
        state.pendingLlmSettings = null;
        state.auditUserModified = false;
        if (apiKeyInput) delete apiKeyInput.dataset.modified;
        if (auditApiKeyInput) delete auditApiKeyInput.dataset.modified;
        updateCurrentProviderDisplay();
        updateIndicators();
      }
      if (event.settings) {
        const saved = event.settings;
        state.currentProvider = saved.provider || state.currentProvider;
        state.currentApiKey = saved.apiKey ?? saved.providerApiKeys?.[state.currentProvider] ?? "";
        state.currentBaseUrl = saved.baseUrl || "";
        state.currentModel = saved.modelId || state.currentModel;
        state.currentThinkingLevel = saved.thinkingLevel || state.currentThinkingLevel;
        state.providerApiKeys = { ...saved.providerApiKeys, [state.currentProvider]: state.currentApiKey };
        state.auditSettings = saved.audit || {};
        state.auditConfigured = Boolean(saved.audit?.provider && saved.audit.provider !== "close");
        updateCurrentProviderDisplay();
        updateIndicators();
      }
      addStatusMessage(savedProvider ? `${t('settings.saved')} · ${savedProvider}` : t('settings.saved'));
      if (settingsModal) settingsModal.classList.remove("open");
      if (fromComposer) closeComposerModelPanel();
      updateComposerModelControls();
      break;
    }
    case "mcp_servers": {
      const result = event.result || {};
      state.mcpConfig = result.systemConfig || { schemaVersion: 1, servers: [] };
      state.mcpEffectiveViews = result.effectiveServers || [];
      for (const view of state.mcpEffectiveViews) {
        if (view.catalog && view.config?.name) state.mcpCatalogs[view.config.name] = view.catalog;
      }
      renderMcpServers();
      if (mcpSettingsStatus) mcpSettingsStatus.textContent = result.error || "";
      break;
    }
    case "mcp_servers_saved": {
      const result = event.result || {};
      state.mcpConfig = result.config || state.mcpConfig;
      state.mcpEffectiveViews = result.effectiveServers || [];
      renderMcpServers();
      if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.saved");
      if (state.pendingMcpProbe) {
        const serverName = state.pendingMcpProbe;
        state.pendingMcpProbe = null;
        if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.probing");
        sendCommand({ type: "probe_mcp_server", request_id: nextMcpRequestId(), server_name: serverName });
      }
      break;
    }
    case "mcp_probe_result": {
      const catalog = event.result?.catalog;
      if (catalog?.serverName) {
        state.mcpCatalogs[catalog.serverName] = catalog;
        const view = state.mcpEffectiveViews.find((item) => item.config?.name === catalog.serverName);
        if (view) {
          view.status = event.result?.status || "connected";
          view.catalog = catalog;
          delete view.error;
        }
      }
      renderMcpServers();
      if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.probeSucceeded");
      break;
    }
    case "mcp_servers_reloaded": {
      const result = event.result || {};
      state.mcpConfig = result.systemConfig || state.mcpConfig;
      state.mcpEffectiveViews = result.effectiveServers || [];
      renderMcpServers();
      if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.reloaded");
      break;
    }
    case "mcp_error": {
      const message = event.error || t("mcp.operationFailed");
      state.pendingMcpProbe = null;
      if (mcpSettingsStatus) mcpSettingsStatus.textContent = `${event.code || "ERROR"}: ${message}`;
      addStatusMessage(`${t("mcp.operationFailed")}: ${message}`);
      break;
    }
    case "shutdown": addStatusMessage(t('chat.shuttingDown')); break;
    case "sub_agent_spawned": break; // No UI action; usage is captured on completion
    case "sub_agent_completed": {
      // Capture per-sub-agent token usage for the token stats panel.
      // Skip late completions attributed to another session (user switched away
      // mid-run); their usage is persisted in that session and restored on switch-back.
      if (event.session_id && state.sessionId && event.session_id !== state.sessionId) break;
      if (event.usage) {
        if (event.sub_agent_id && state.subAgentUsage.some(item => item.id === event.sub_agent_id)) break;
        state.subAgentUsage.push({
          id: event.sub_agent_id || `sub-${state.subAgentUsage.length + 1}`,
          status: event.status || '',
          ...normalizeUsage(event.usage),
        });
      }
      break;
    }
    default: console.log("Unhandled event:", event);
  }
}

function renderTodoList(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const id = `todo-${Date.now()}`;
  const el = createElement("div", "tool-activity open");
  el.id = id;
  const header = createElement("div", "tool-header");
  header.innerHTML = `<span class="tool-name">📋 ${t('chat.todoList')}</span><span class="tool-status success">${tasks.length}</span>`;
  header.addEventListener("click", () => el.classList.toggle("open"));
  const body = createElement("div", "tool-body");
  const list = document.createElement("ul");
  for (const task of tasks) {
    const li = document.createElement("li");
    li.textContent = typeof task === "string" ? task : task.name || task.title || JSON.stringify(task);
    list.appendChild(li);
  }
  body.appendChild(list);
  el.appendChild(header);
  el.appendChild(body);
  messagesContainer.appendChild(el);
  autoScroll();
}

// ─── Slash Commands ───────────────────────────────────────────────────────────

const SLASH_COMMANDS = {
  // Client commands (frontend-only execution)
  help:     { client: true, desc: 'commands.help' },
  commands: { client: true, desc: 'commands.commands' },
  tools:    { client: true, desc: 'commands.tools' },
  status:   { client: true, desc: 'commands.status' },
  cost:     { client: true, desc: 'commands.cost' },
  // RPC commands (sent to backend)
  new:      { rpc: true, desc: 'commands.new' },
  compact:  { rpc: true, desc: 'commands.compact' },
  cancel:   { rpc: true, desc: 'commands.cancel' },
  stop:     { rpc: true, desc: 'commands.cancel' },
  model:    { rpc: true, desc: 'commands.model' },
  'think-level-min': { client: true, desc: 'commands.thinkMin' },
  'think-level-mid': { client: true, desc: 'commands.thinkMid' },
  'think-level-max': { client: true, desc: 'commands.thinkMax' },
};

/**
 * Parse slash command text, returns { cmd, param, rest } or null
 * Example: /help → { cmd:'help', param:'', rest:'' }
 *       /new Write weekly report → { cmd:'new', param:'', rest:'Write weekly report' }
 *       /model claude-3.5-sonnet → { cmd:'model', param:'claude-3.5-sonnet', rest:'' }
 *       /gen-chart:parchment Generate chart → { cmd:'gen-chart', param:'parchment', rest:'Generate chart' }
 */
function parseSlashCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  // Find the first space to split command and the rest
  const spaceIdx = trimmed.indexOf(' ');
  const cmdPart = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  // Parse cmd:param format
  const colonIdx = cmdPart.indexOf(':');
  if (colonIdx !== -1) {
    return { cmd: cmdPart.slice(0, colonIdx), param: cmdPart.slice(colonIdx + 1), rest };
  }
  return { cmd: cmdPart, param: '', rest };
}

/**
 * Execute slash command, returns true if handled (should not be sent as regular prompt)
 */
function executeSlashCommand(parsed) {
  const { cmd, param, rest } = parsed;

  // Check built-in commands
  const def = SLASH_COMMANDS[cmd];
  if (def) {
    if (def.client) {
      executeClientCommand(cmd, rest);
      return true;
    }
    if (def.rpc) {
      executeRpcCommand(cmd, param, rest);
      return true;
    }
  }

  // Check tool name
  const toolMatch = BUILTIN_TOOLS.find(t => t.command === cmd);
  if (toolMatch) {
    const promptText = rest ? `/${cmd} ${rest}` : `/${cmd} `;
    sendPrompt(promptText);
    return true;
  }

  // Check dynamic skill name
  const skillNames = (state.skillsData || []).map(s => typeof s === 'string' ? s : s.name || '');
  if (skillNames.includes(cmd)) {
    const prefix = param ? `/${cmd}:${param}` : `/${cmd}`;
    const promptText = rest ? `${prefix} ${rest}` : `${prefix} `;
    sendPrompt(promptText);
    return true;
  }

  return false; // Unrecognized command
}

function executeClientCommand(cmd, rest) {
  switch (cmd) {
    case 'help':
    case 'commands': {
      const rows = [
        '| ' + t('commands.cmdCol') + ' | ' + t('commands.descCol') + ' |',
        '|---|---|',
        '| `/help` or `/commands` | ' + t('commands.help') + ' |',
        '| `/new [text]` | ' + t('commands.new') + ' |',
        '| `/compact` | ' + t('commands.compact') + ' |',
        '| `/status` | ' + t('commands.status') + ' |',
        '| `/model [name]` | ' + t('commands.model') + ' |',
        '| `/cancel` | ' + t('commands.cancel') + ' |',
        '| `/think-level-min` | ' + t('commands.thinkMin') + ' |',
        '| `/think-level-mid` | ' + t('commands.thinkMid') + ' |',
        '| `/think-level-max` | ' + t('commands.thinkMax') + ' |',
        '| `/tools` | ' + t('commands.tools') + ' |',
        '| `/cost` | ' + t('commands.cost') + ' |',
        '| `/math_calc` | ' + t('commands.mathCalc') + ' |',
        '| `/web_fetch` | ' + t('commands.webFetch') + ' |',
        '| `/web_search` | ' + t('commands.webSearch') + ' |',
        '| `/\u003cskill\u003e[:theme]` | ' + t('commands.skillCmd') + ' |',
      ];
      addMessage('assistant', '**' + t('commands.title') + '**\n\n' + rows.join('\n'));
      break;
    }
    case 'tools': {
      const tools = BUILTIN_TOOLS.map(tool => '- `' + tool.command + '` — ' + t(tool.desc)).join('\n');
      const skills = (state.skillsData || []).map(s => {
        const name = typeof s === 'string' ? s : s.name || '';
        return '- `' + name + '`';
      }).join('\n');
      const parts = [];
      if (tools) parts.push('**' + t('commands.toolsGroup') + '**\n' + tools);
      if (skills) parts.push('**' + t('commands.skillsGroup') + '**\n' + skills);
      addMessage('assistant', parts.join('\n\n') || t('skills.empty'));
      break;
    }
    case 'status': {
      const info = [
        '- **Session**: ' + (state.sessionId || '-'),
        '- **Model**: ' + (state.currentModel || '-'),
        '- **Mode**: ' + state.conversationMode,
        '- **Connected**: ' + (state.connected ? 'Yes' : 'No'),
        '- **Messages**: ' + state.messages.length,
      ];
      addMessage('assistant', '**' + t('commands.statusTitle') + '**\n\n' + info.join('\n'));
      break;
    }
    case 'cost': {
      if (state.usageLog.length > 0 || state.subAgentUsage.length > 0) {
        const totals = getCombinedTotals();
        const lines = [
          '- ' + t('chat.tokenInput') + ': ' + totals.input.toLocaleString(),
          '- ' + t('chat.tokenOutput') + ': ' + totals.output.toLocaleString(),
          '- ' + t('chat.tokenCacheRead') + ': ' + totals.cacheRead.toLocaleString(),
          '- ' + t('chat.tokenCacheWrite') + ': ' + totals.cacheWrite.toLocaleString(),
          '- ' + t('chat.tokenTotal') + ': ' + totals.totalTokens.toLocaleString(),
          '- ' + t('chat.tokenTurn') + ': ' + state.usageLog.length,
        ];
        addMessage('assistant', '**' + t('commands.costTitle') + '**\n\n' + lines.join('\n'));
      } else {
        const msgCount = state.messages.length;
        const estTokens = msgCount * 800;
        addMessage('assistant', '**' + t('commands.costTitle') + '**\n\n- ' + t('commands.msgCount') + ': ' + msgCount + '\n- ' + t('commands.estTokens') + ': ~' + estTokens.toLocaleString());
      }
      break;
    }
    case 'think-level-min':
      sendCommand({ type: 'set_thinking_level', level: 'minimal' });
      break;
    case 'think-level-mid':
      sendCommand({ type: 'set_thinking_level', level: 'medium' });
      break;
    case 'think-level-max':
      sendCommand({ type: 'set_thinking_level', level: 'xhigh' });
      break;
  }
}

function executeRpcCommand(cmd, param, rest) {
  switch (cmd) {
    case 'new': {
      const pending = rest ? createPendingSend(rest) : null;
      sendNewSession();
      if (pending && state.sessionTransition === "new") state.pendingSend = pending;
      break;
    }
    case 'cancel':
    case 'stop':
      sendCommand({ type: 'abort' });
      break;
    case 'compact':
      if (!state.connected || state.isBusy || state.isCompacting || state.isReadOnly) return;
      state.isCompacting = true;
      updateActivityControls();
      sendCommand({ type: 'compact' });
      break;
    case 'model': {
      if (!param && !rest) {
        addMessage('assistant', '**' + t('commands.currentModel') + '**: ' + (state.currentModel || '-'));
      } else {
        const modelName = param || rest;
        sendCommand({ type: 'set_model', model_id: modelName });
      }
      break;
    }
  }
}

// ─── Slash Autocomplete ─────────────────────────────────────────────────────

function updateSlashAutocomplete() {
  if (!slashAutocomplete) return;
  const val = messageInput.value;
  const cursor = messageInput.selectionStart;

  // Only show when input starts with "/" and cursor is before the first space
  if (!val.startsWith('/')) {
    slashAutocomplete.style.display = 'none';
    return;
  }
  const spaceIdx = val.indexOf(' ');
  if (spaceIdx !== -1 && cursor > spaceIdx) {
    slashAutocomplete.style.display = 'none';
    return;
  }

  const query = val.slice(1, spaceIdx === -1 ? val.length : spaceIdx).toLowerCase();

  // Build candidate list: built-in commands + tools + skills
  const allItems = [];

  for (const [name, def] of Object.entries(SLASH_COMMANDS)) {
    if (name === 'stop') continue; // Hide alias
    allItems.push({ name, desc: t(def.desc), type: def.client ? 'client' : 'rpc' });
  }
  for (const tool of BUILTIN_TOOLS) {
    allItems.push({ name: tool.command, desc: t(tool.desc), type: 'tool' });
  }
  const skillNames = (state.skillsData || []).map(s => typeof s === 'string' ? s : s.name || '');
  for (const name of skillNames) {
    allItems.push({ name, desc: 'Skill', type: 'skill' });
  }

  // Filter
  const filtered = allItems.filter(item =>
    item.name.toLowerCase().startsWith(query) || item.name.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    slashAutocomplete.style.display = 'none';
    return;
  }

  // Render
  slashAutocomplete.innerHTML = '';
  filtered.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'slash-autocomplete-item' + (idx === 0 ? ' active' : '');
    el.innerHTML = `<span class="cmd-name">/${escapeHtml(item.name)}</span><span class="cmd-desc">${escapeHtml(item.desc)}</span>`;
    el.addEventListener('click', () => {
      const prefix = `/${item.name} `;
      messageInput.value = prefix;
      messageInput.focus();
      messageInput.setSelectionRange(prefix.length, prefix.length);
      slashAutocomplete.style.display = 'none';
    });
    slashAutocomplete.appendChild(el);
  });

  slashAutocomplete.style.display = 'block';
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function sendCurrentMessage() {
  const text = messageInput.value;
  if (!text.trim() && state.uploadedFiles.length === 0) return;
  if (!state.connected || state.isBusy || state.isCompacting || state.sessionTransition !== null) return;
  closeComposerMenus();

  // Slash command interception
  if (text.trim().startsWith('/')) {
    const parsed = parseSlashCommand(text);
    if (parsed?.cmd === 'new' && parsed.rest && rejectQuickAttachments()) return;
    if (parsed && executeSlashCommand(parsed)) {
      messageInput.value = '';
      messageInput.style.height = 'auto';
      return;
    }
  }

  sendPrompt(text);
}

messageInput.addEventListener("keydown", (e) => {
  // Autocomplete navigation
  if (slashAutocomplete) {
    const items = slashAutocomplete.querySelectorAll('.slash-autocomplete-item');
    if (items.length > 0 && slashAutocomplete.style.display !== 'none') {
    const activeIdx = [...items].findIndex(el => el.classList.contains('active'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items.forEach(el => el.classList.remove('active'));
      const next = (activeIdx + 1) % items.length;
      items[next]?.classList.add('active');
      items[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      items.forEach(el => el.classList.remove('active'));
      const prev = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
      items[prev]?.classList.add('active');
      items[prev]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.isComposing)) {
      if (activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        items[activeIdx].click();
        return;
      }
    }
    if (e.key === 'Escape') {
      slashAutocomplete.style.display = 'none';
      return;
    }
    } // end items.length > 0 check
  }
  // Ignore Enter during IME composition (Chinese/Japanese/Korean input)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendCurrentMessage();
  }
});
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  if (messageInput.value) messageInput.style.height = `${Math.min(messageInput.scrollHeight, 200)}px`;
  updateSlashAutocomplete();
});
sendBtn.addEventListener("click", sendCurrentMessage);
abortBtn.addEventListener("click", () => sendCommand({ type: "abort" }));
compactBtn.addEventListener("click", () => {
  if (!state.connected || state.isBusy || state.isCompacting || state.isReadOnly) return;
  state.isCompacting = true;
  updateActivityControls();
  sendCommand({ type: "compact" });
});
newSessionBtn.addEventListener("click", sendNewSession);

// Mode selector
if (modeSelector) {
  modeSelector.addEventListener("change", () => {
    const mode = modeSelector.value;
    if (!mode) return;
    state.conversationMode = mode;
    closeComposerMenus();
    if (modeHint) {
      updateModeHint(mode);
    }
    updateSkillBtnState();
  });
}

modelIndicator.addEventListener("click", () => {
  if (composerModelPanel.hidden) openComposerModelPanel();
  else closeComposerModelPanel();
});

// Settings modal — pre-fill with current config on open
settingsBtn.addEventListener("click", () => {
  closeComposerModelPanel(false);
  if (apiKeyInput) delete apiKeyInput.dataset.modified;
  if (auditApiKeyInput) delete auditApiKeyInput.dataset.modified;
  if (isVerySmallScreen()) collapseSidebar();
  // Pre-fill provider, apiKey, baseUrl from current state
  if (providerSelect && state.currentProvider) providerSelect.value = state.currentProvider;
  if (apiKeyInput) apiKeyInput.value = state.currentApiKey || "";
  if (baseUrlInput) {
    baseUrlInput.value = state.currentBaseUrl || "";
    baseUrlInput.placeholder = PROVIDER_DEFAULTS[state.currentProvider]?.baseUrl || "https://your-api-endpoint/v1";
  }
  // Pre-fill model select + custom input
  if (modelSelect && state.currentModel) {
    const hasModel = Array.from(modelSelect.options).some((o) => o.value === state.currentModel);
    if (hasModel) {
      modelSelect.value = state.currentModel;
      if (customModelInput) customModelInput.value = "";
    } else if (customModelInput) {
      customModelInput.value = state.currentModel;
    }
  }
  // Pre-fill thinking level
  if (thinkingLevelInput) {
    const idx = THINKING_LEVELS.indexOf(state.currentThinkingLevel || "medium");
    thinkingLevelInput.value = String(idx >= 0 ? idx : 3);
  }
  state.auditUserModified = false; // Reset audit modification tracking for this session
  prefillAuditSettings();
  settingsModal.classList.add("open");
});
closeSettingsBtn.addEventListener("click", () => settingsModal.classList.remove("open"));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.remove("open"); });

// Settings Tab switching
document.querySelectorAll(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
    document.querySelectorAll(".settings-tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === tabName));
    // Load search settings when switching to search tab
    if (tabName === "search") loadSearchSettings();
    if (tabName === "external-mcp") loadMcpServers();
  });
});

addMcpServerBtn?.addEventListener("click", () => {
  try { collectMcpConfig(); } catch (error) { addStatusMessage(error.message); return; }
  state.mcpConfig.servers.push(defaultMcpServer());
  renderMcpServers();
});

reloadMcpServersBtn?.addEventListener("click", () => {
  if (mcpSettingsStatus) mcpSettingsStatus.textContent = t("mcp.reloading");
  sendCommand({ type: "reload_mcp_servers", request_id: nextMcpRequestId() });
});

// Search provider change → re-render dynamic fields with cached values
if (searchProviderSelect) {
  searchProviderSelect.addEventListener("change", () => {
    renderSearchFields(searchProviderSelect.value);
  });
}

// Active search provider change → save immediately
const activeProviderSelect = document.getElementById("active-search-provider-select");
if (activeProviderSelect) {
  activeProviderSelect.addEventListener("change", () => {
    setActiveSearchProvider(activeProviderSelect.value);
  });
}

// Provider change → update API key and base URL
providerSelect.addEventListener("change", () => {
  const provider = providerSelect.value;
  const defaults = PROVIDER_DEFAULTS[provider];
  // Update API key: use cached key for this provider, or clear if none
  const cachedKey = state.providerApiKeys[provider] || "";
  if (apiKeyInput) apiKeyInput.value = cachedKey;
  // Clear base URL value and update placeholder to new provider's default
  baseUrlInput.value = "";
  baseUrlInput.placeholder = defaults?.baseUrl || "https://your-api-endpoint/v1";
  // Clear stale custom model input when switching provider
  if (customModelInput) customModelInput.value = "";
  if (modelSelect) {
    modelSelect.innerHTML = `<option value="">${provider === "custom" ? t('settings.refreshOrEnterModel') : t('settings.enterApiKey')}</option>`;
  }
  // Only auto-refresh models if we have a cached API key for this provider
  // Otherwise, let the user enter their API key first
  if (cachedKey) {
    refreshModelsForProvider(provider);
  } else {
    if (modelRefreshStatus) {
      modelRefreshStatus.textContent = "";
      modelRefreshStatus.className = "model-refresh-status";
    }
  }
});

if (modelSelect && customModelInput) {
  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) customModelInput.value = "";
  });
}

let mainModelDiscoveryTimer = null;
function scheduleMainModelDiscovery() {
  if (mainModelDiscoveryTimer) clearTimeout(mainModelDiscoveryTimer);
  mainModelDiscoveryTimer = setTimeout(() => {
    const provider = providerSelect.value;
    const baseUrl = baseUrlInput?.value?.trim() || PROVIDER_DEFAULTS[provider]?.baseUrl || "";
    const apiKey = apiKeyInput?.value?.trim() || "";
    const requiresApiKey = ["openai", "anthropic", "deepseek", "mistral", "google"].includes(provider);
    if (!baseUrl || (requiresApiKey && !apiKey)) return;
    refreshModelsForProvider(provider);
  }, 600);
}
baseUrlInput?.addEventListener("input", scheduleMainModelDiscovery);
apiKeyInput?.addEventListener("input", () => {
  apiKeyInput.dataset.modified = "true";
  scheduleMainModelDiscovery();
});

// Refresh models button
if (refreshModelsBtn) {
  refreshModelsBtn.addEventListener("click", () => {
    refreshModelsForProvider(providerSelect.value);
  });
}

// Toggle API key visibility (main + audit)
(() => {
  const eyeOpenSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeClosedSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
  const toggleMainBtn = document.getElementById("toggle-api-key-visibility");
  if (toggleMainBtn && apiKeyInput) {
    toggleMainBtn.addEventListener("click", () => {
      const showing = apiKeyInput.type === "text";
      apiKeyInput.type = showing ? "password" : "text";
      toggleMainBtn.innerHTML = showing ? eyeOpenSVG : eyeClosedSVG;
    });
  }
  const toggleAuditBtn = document.getElementById("toggle-audit-api-key-visibility");
  const auditKeyInput = document.getElementById("audit-api-key-input");
  if (toggleAuditBtn && auditKeyInput) {
    toggleAuditBtn.addEventListener("click", () => {
      const showing = auditKeyInput.type === "text";
      auditKeyInput.type = showing ? "password" : "text";
      toggleAuditBtn.innerHTML = showing ? eyeOpenSVG : eyeClosedSVG;
    });
  }
})();

// Test API Key button
if (testApiKeyBtn) {
  testApiKeyBtn.addEventListener("click", () => {
    const provider = providerSelect?.value || "hedgehog";
    const apiKey = apiKeyInput?.value?.trim() || "";
    const baseUrl = baseUrlInput?.value?.trim() || PROVIDER_DEFAULTS[provider]?.baseUrl || "";
    if (!apiKey) {
      if (apiKeyStatus) {
        apiKeyStatus.textContent = "✗ " + (t('settings.needApiKey') || "No API Key");
        apiKeyStatus.className = "api-key-status error";
        setTimeout(() => { apiKeyStatus.textContent = ""; apiKeyStatus.className = "api-key-status"; }, 3000);
      }
      return;
    }
    testApiKeyBtn.disabled = true;
    testApiKeyBtn.classList.add("testing");
    if (apiKeyStatus) {
      apiKeyStatus.textContent = t('settings.testingKey') || "Testing...";
      apiKeyStatus.className = "api-key-status testing";
    }
    sendCommand({ type: "test_api_key", provider, apiKey, baseUrl });
  });
}

// ─── Audit Model Settings ─────────────────────────────────────────────────────

function toggleAuditFields(show) {
  const display = show ? "" : "none";
  const ids = ["audit-base-url-group", "audit-api-key-group", "audit-model-group", "audit-score-group", "audit-iterations-group"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  });
}

function prefillAuditSettings() {
  const audit = state.auditSettings;
  const enabled = Boolean(audit.provider && audit.provider !== "close");
  if (auditProviderSelect) auditProviderSelect.value = enabled ? audit.provider : "";
  if (auditApiKeyInput) auditApiKeyInput.value = enabled ? audit.apiKey || "" : "";
  if (auditBaseUrlInput) auditBaseUrlInput.value = enabled ? audit.baseUrl || "" : "";
  if (auditModelSelect) {
    const option = document.createElement("option");
    option.value = enabled ? audit.modelId || "" : "";
    option.textContent = option.value || t('settings.refreshOrEnterModel');
    auditModelSelect.replaceChildren(option);
    auditModelSelect.disabled = false;
  }
  if (customAuditModelInput) customAuditModelInput.value = "";
  if (auditMinScore) auditMinScore.value = String(audit.minPassScore ?? 70);
  if (auditScoreValue) auditScoreValue.textContent = String(audit.minPassScore ?? 70);
  if (auditMaxIterations) auditMaxIterations.value = String(audit.maxIterations ?? 2);
  toggleAuditFields(enabled);
}

if (auditProviderSelect) {
  auditProviderSelect.addEventListener("change", () => {
    state.auditUserModified = true;
    const provider = auditProviderSelect.value;
    const hasProvider = !!provider;
    // Auto-fill Base URL placeholder based on provider (same as main LLM)
    if (auditBaseUrlInput) {
      auditBaseUrlInput.value = "";
      auditBaseUrlInput.placeholder = PROVIDER_DEFAULTS[provider]?.baseUrl || "https://your-api-endpoint/v1";
    }
    // Update API key: use cached key for this provider, or clear if none (same as main LLM)
    const cachedKey = state.providerApiKeys[provider] || "";
    if (auditApiKeyInput) auditApiKeyInput.value = cachedKey;
    if (customAuditModelInput) customAuditModelInput.value = "";
    if (auditModelRefreshStatus) auditModelRefreshStatus.textContent = "";
    if (auditModelSelect) {
      const prompt = provider === "custom" ? t('settings.refreshOrEnterModel') : t('settings.enterApiKey');
      auditModelSelect.innerHTML = `<option value="">${prompt}</option>`;
    }
    toggleAuditFields(hasProvider);
    if (hasProvider && cachedKey) {
      refreshAuditModels(provider, auditBaseUrlInput?.value || "", cachedKey);
    }
  });
}

if (auditModelSelect && customAuditModelInput) {
  auditModelSelect.addEventListener("change", () => {
    state.auditUserModified = true;
    if (auditModelSelect.value) customAuditModelInput.value = "";
  });
  customAuditModelInput.addEventListener("input", () => {
    state.auditUserModified = true;
  });
}

let auditModelDiscoveryTimer = null;
function scheduleAuditModelDiscovery() {
  if (auditModelDiscoveryTimer) clearTimeout(auditModelDiscoveryTimer);
  auditModelDiscoveryTimer = setTimeout(() => {
    const provider = auditProviderSelect?.value || "";
    const baseUrl = auditBaseUrlInput?.value?.trim() || PROVIDER_DEFAULTS[provider]?.baseUrl || "";
    const apiKey = auditApiKeyInput?.value?.trim() || "";
    const requiresApiKey = ["openai", "anthropic", "deepseek", "mistral", "google"].includes(provider);
    if (!provider || !baseUrl || (requiresApiKey && !apiKey)) return;
    refreshAuditModels(provider, baseUrl, apiKey);
  }, 600);
}
auditBaseUrlInput?.addEventListener("input", () => {
  state.auditUserModified = true;
  scheduleAuditModelDiscovery();
});
auditApiKeyInput?.addEventListener("input", () => {
  state.auditUserModified = true;
  auditApiKeyInput.dataset.modified = "true";
  scheduleAuditModelDiscovery();
});

if (auditMinScore) {
  auditMinScore.addEventListener("input", () => {
    state.auditUserModified = true;
    if (auditScoreValue) auditScoreValue.textContent = auditMinScore.value;
  });
}
auditMaxIterations?.addEventListener("input", () => {
  state.auditUserModified = true;
});

async function refreshAuditModels(provider, baseUrl, apiKey) {
  if (!auditModelSelect) return;
  const currentModel = customAuditModelInput?.value?.trim() || auditModelSelect.value;
  // Keep the current selection in the manual fallback while discovery is in
  // flight, otherwise a failed request would erase a valid saved model ID.
  if (currentModel && customAuditModelInput) customAuditModelInput.value = currentModel;
  auditModelSelect.innerHTML = `<option value="">${t('common.loading')}...</option>`;
  auditModelSelect.disabled = true;
  if (auditModelRefreshStatus) {
    auditModelRefreshStatus.textContent = t('settings.fetchingModels') + '...';
    auditModelRefreshStatus.className = "setting-hint";
  }
  // Use RPC command (same as main LLM) instead of HTTP
  const effectiveBaseUrl = baseUrl || PROVIDER_DEFAULTS[provider]?.baseUrl || "";
  sendCommand({ type: "refresh_models", provider, baseUrl: effectiveBaseUrl, apiKey, target: "audit" });
}

if (refreshAuditModelsBtn) {
  refreshAuditModelsBtn.addEventListener("click", () => {
    const provider = auditProviderSelect?.value;
    if (provider) {
      refreshAuditModels(provider, auditBaseUrlInput?.value || "", auditApiKeyInput?.value || "");
    }
  });
}

// Save settings — route based on active tab
saveSettingsBtn.addEventListener("click", () => {
  const activeTab = document.querySelector(".settings-tab.active")?.dataset.tab;
  if (activeTab === "search") {
    // Save search settings via HTTP API — modal stays open
    saveSearchSettings();
    return;
  }
  if (!state.connected || saveSettingsBtn.disabled) return;

  if (activeTab === "external-mcp") {
    saveMcpServers();
    return;
  }

  // System config — save all system settings
  if (activeTab === "system") {
    saveSettingsBtn.disabled = true;
    const sandboxModeSelect = document.getElementById("sandbox-mode-select");
    const explicitCacheToggle = document.getElementById("explicit-cache-toggle");
    const showCacheStatsToggle = document.getElementById("show-cache-stats-toggle");
    const thresholdInput = document.getElementById("compress-threshold");
    const compressorToggle = document.getElementById("compressor-enabled-toggle");
    const maxTurnsInput = document.getElementById("subagent-max-turns");
    sendCommand({
      type: "save_settings",
      explicitCache: explicitCacheToggle ? explicitCacheToggle.checked : false,
      showCacheStats: showCacheStatsToggle ? showCacheStatsToggle.checked : false,
      systemConfig: {
        sandboxMode: sandboxModeSelect ? sandboxModeSelect.value : "disabled",
        compressorEnabled: compressorToggle ? compressorToggle.checked : false,
        compressThreshold: (() => { const v = thresholdInput ? parseInt(thresholdInput.value, 10) : NaN; return Number.isFinite(v) && v > 0 ? v : 5000; })(),
        subagentMaxTurns: (() => { const v = maxTurnsInput ? parseInt(maxTurnsInput.value, 10) : NaN; return Number.isFinite(v) && v > 0 ? v : 50; })(),
        memoryEnabled: (() => { const el = document.getElementById("memory-enabled-toggle"); return el ? el.checked : false; })(),
        memoryMcpKbUrl: (() => { const el = document.getElementById("memory-mcp-kb-url"); return el ? el.value.trim() : ""; })(),
      },
    });
    return;
  }

  // LLM settings — existing logic
  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim() || PROVIDER_DEFAULTS[provider]?.baseUrl || "";
  const modelId = (customModelInput && customModelInput.value.trim()) || modelSelect.value;
  const thinkingIndex = parseInt(thinkingLevelInput.value, 10);
  const thinkingLevel = THINKING_LEVELS[thinkingIndex] || "medium";

  if (!modelId) {
    if (modelRefreshStatus) {
      modelRefreshStatus.textContent = t('settings.modelIdRequired');
      modelRefreshStatus.className = "model-refresh-status error";
    }
    return;
  }

  // Keep submitted credentials separate until the server confirms persistence.
  const providerApiKeys = { ...state.providerApiKeys };
  if (apiKey) {
    providerApiKeys[provider] = apiKey;
  } else {
    delete providerApiKeys[provider];
  }

  // Audit model fields — send audit only when user explicitly configured/cleared it.
  // When auditUserModified is false and auditConfigured is true, omit audit from the
  // payload so the server preserves existing config (prevents accidental clearing).
  const auditProvider = auditProviderSelect?.value || "";
  const auditModelId = customAuditModelInput?.value?.trim() || auditModelSelect?.value || "";
  if (auditProvider && !auditModelId) {
    if (auditModelRefreshStatus) {
      auditModelRefreshStatus.textContent = t('settings.modelIdRequired');
      auditModelRefreshStatus.className = "setting-hint warning";
    }
    return;
  }
  let audit;
  if (state.auditUserModified || !state.auditConfigured) {
    audit = auditProvider ? {
      provider: auditProvider,
      ...((auditProvider === "custom" || auditApiKeyInput?.value?.trim() || auditApiKeyInput?.dataset.modified === "true") && {
        apiKey: auditApiKeyInput?.value?.trim() || "",
      }),
      baseUrl: auditBaseUrlInput?.value?.trim() || PROVIDER_DEFAULTS[auditProvider]?.baseUrl || "",
      modelId: auditModelId,
      minPassScore: parseInt(auditMinScore?.value || "70", 10),
      maxIterations: parseInt(auditMaxIterations?.value || "2", 10),
    } : { provider: "close" }; // Explicitly off, including after restart with audit env defaults
  } else {
    audit = null; // not modified → omit from payload, server preserves existing
  }

  // Send single save_settings command that persists + applies
  state.pendingLlmSettings = {
    provider,
    apiKey,
    baseUrl,
    modelId,
    thinkingLevel,
    providerApiKeys,
    ...(audit !== null && { audit }),
    ...(audit !== null && { auditConfigured: Boolean(audit?.provider && audit.provider !== "close") }),
  };
  saveSettingsBtn.disabled = true;
  sendCommand({
    type: "save_settings",
    provider,
    ...((provider === "custom" || apiKey || apiKeyInput.dataset.modified === "true") && { apiKey }),
    providerApiKeys,
    baseUrl,
    modelId: modelId || "",
    thinkingLevel,
    audit,
  });

  // The visible active configuration changes only after settings_saved.
});

// Skill install from git
if (installSkillBtn) {
  installSkillBtn.addEventListener("click", () => {
    const url = skillGitUrlInput?.value?.trim();
    if (!url) return;
    installSkillBtn.disabled = true;
    installSkillBtn.textContent = t('skills.installing') + '...';
    sendCommand({ type: "install_skill_from_git", url });
    addStatusMessage(`${t('skills.installing')}: ${url}`);
    // Reset after delay
    setTimeout(() => {
      installSkillBtn.disabled = false;
      installSkillBtn.textContent = t('skills.install');
      if (skillGitUrlInput) skillGitUrlInput.value = "";
    }, 5000);
  });
}

// Skill config modal
if (closeSkillConfigBtn) closeSkillConfigBtn.addEventListener("click", () => skillConfigModal.classList.remove("open"));
if (skillConfigModal) skillConfigModal.addEventListener("click", (e) => { if (e.target === skillConfigModal) skillConfigModal.classList.remove("open"); });
if (saveSkillConfigBtn) {
  saveSkillConfigBtn.addEventListener('click', async () => {
    const skillName = skillConfigModal.dataset.skillName;
    const config = {};
    let invalidLongTaskFlag = false;
    // API key
    const hasApikey = document.getElementById('skill-config-has-apikey')?.checked;
    const apikeyVal = document.getElementById('skill-config-apikey')?.value?.trim();
    if (hasApikey && apikeyVal) config['api-key'] = apikeyVal;
    // Custom key-value pairs
    document.querySelectorAll('#skill-custom-configs .config-row').forEach(row => {
      const k = row.querySelector('.config-key')?.value?.trim();
      const v = row.querySelector('.config-value')?.value?.trim();
      if (k === 'isLongTaskSpecific') {
        if (v === 'true' || v === 'false') config[k] = v === 'true';
        else invalidLongTaskFlag = true;
      } else if (k) config[k] = v || '';
    });
    if (invalidLongTaskFlag) {
      addStatusMessage(`${t('common.error')}: isLongTaskSpecific must be true or false`);
      return;
    }
    try {
      const resp = await authenticatedFetch(`/api/skills/${encodeURIComponent(skillName)}/config?user=${encodeURIComponent(state.user)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const result = await resp.json();
      if (result.error) { addStatusMessage(`${t('common.error')}: ${result.error}`); return; }
      skillConfigModal.classList.remove('open');
      addStatusMessage(`${t('skills.configured')}: ${skillName}`);
    } catch (err) {
      addStatusMessage(`${t('common.error')}: ${err.message}`);
    }
  });
}

// Existing dialogs share focus handling; their business actions stay in their own handlers.
for (const overlay of document.querySelectorAll('.modal-overlay')) {
  const dialog = overlay.querySelector('.modal');
  if (!dialog) continue;
  const heading = dialog.querySelector('h2');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  if (heading) {
    heading.id ||= `${overlay.id}-title`;
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  let returnFocus = null;
  const focusableControls = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(el => el.getClientRects().length);
  new MutationObserver(() => {
    if (overlay.classList.contains('open')) {
      returnFocus = document.activeElement;
      (focusableControls()[0] || dialog).focus();
    } else if (returnFocus?.isConnected && returnFocus.getClientRects().length) {
      returnFocus.focus();
    }
  }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); overlay.classList.remove('open'); }
    if (event.key !== 'Tab') return;
    const controls = focusableControls();
    const first = controls[0] || dialog;
    const last = controls[controls.length - 1] || dialog;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

// ─── Initialize ───────────────────────────────────────────────────────────────

// Initialize i18n
(async function initI18n() {
  await loadTranslations('en');
  await loadTranslations(currentLang);
  applyI18n();
  syncSidebarAccessibility();
  updateIndicators();

  // Populate language selector
  const langSelector = document.getElementById('lang-selector');
  if (langSelector) {
    for (const lang of SUPPORTED_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.label;
      if (lang.code === currentLang) opt.selected = true;
      langSelector.appendChild(opt);
    }
    langSelector.addEventListener('change', () => {
      changeLanguage(langSelector.value);
    });
  }
})();

// Initialize user from URL query param or localStorage. If that browser state
// references a removed mapping, the server selects the provisioned default user
// before any user-scoped request or WebSocket connection starts.
const userInitialization = (async function initUser() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlUser = urlParams.get("user");
  if (urlUser) {
    state.user = urlUser;
    localStorage.setItem("hogagent_user", urlUser);
  } else {
    state.user = localStorage.getItem("hogagent_user") || "default";
  }

  // Populate user dropdown from API
  const userSelect = document.getElementById('user-select');
  if (userSelect) {
    try {
      const resp = await authenticatedFetch(`/api/users?user=${encodeURIComponent(state.user)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const users = data.users || [];
      const selectedUser = data.selectedUser || "default";
      if (selectedUser !== state.user) {
        state.user = selectedUser;
        localStorage.setItem("hogagent_user", selectedUser);
        const normalizedUrl = new URL(window.location);
        if (normalizedUrl.searchParams.has("user")) {
          normalizedUrl.searchParams.set("user", selectedUser);
          window.history.replaceState(null, "", normalizedUrl);
        }
      }
      userSelect.innerHTML = '';
      for (const u of users) {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.id;
        userSelect.appendChild(opt);
      }
      userSelect.value = state.user;
    } catch {
      // The page came from this server, so API failure is exceptional. Default
      // locally as well to keep subsequent user-scoped requests consistent.
      state.user = "default";
      localStorage.setItem("hogagent_user", state.user);
      const option = document.createElement('option');
      option.value = state.user;
      option.textContent = state.user;
      userSelect.replaceChildren(option);
    }
    // User switch handler — reload page to cleanly reinitialize all state
    userSelect.addEventListener('change', () => {
      const newUser = userSelect.value;
      if (newUser && newUser !== state.user) {
        // Detach old WS handlers BEFORE closing to prevent onclose → attemptReconnect loop
        const oldWs = state.ws;
        if (oldWs) {
          oldWs.onclose = null;
          oldWs.onerror = null;
          oldWs.onmessage = null;
          try { oldWs.close(); } catch {}
        }
        // Persist new user and reload to reinitialize everything
        localStorage.setItem('hogagent_user', newUser);
        const url = new URL(window.location);
        url.searchParams.set('user', newUser);
        window.location.href = url.toString();
      }
    });
  }
})();

// Initialize theme selector
(async function initThemeSelector() {
  // Apply default theme immediately to avoid flash
  applyTheme(DEFAULT_THEME);

  // Populate theme selector
  const themeSelector = document.getElementById('theme-selector');
  if (themeSelector) {
    for (const theme of THEMES) {
      const opt = document.createElement('option');
      opt.value = theme.key;
      opt.textContent = theme.label;
      themeSelector.appendChild(opt);
    }
    themeSelector.addEventListener('change', () => {
      const newTheme = themeSelector.value;
      applyTheme(newTheme);
      saveUserTheme(newTheme);
    });
  }

  // User validation must finish before loading user-scoped settings.
  await userInitialization;
  await loadUserTheme();
})();

// Show fallback models initially, then auto-fetch from provider
populateModelSelect(FALLBACK_MODELS, `⚠ ${t('settings.fallbackModels')}`);
if (modelHint) modelHint.dataset.i18n = "settings.fallbackModels";
void userInitialization.then(() => {
  restoreWebConnectionId();
  connect();
});

/** Auto-fetch models from provider once connected (no server-side cache). */
function autoFetchModelsOnReady() {
  const provider = state.currentProvider || state.capabilities?.llmProvider?.provider || "hedgehog";
  const apiKey = state.currentApiKey || state.capabilities?.llmProvider?.apiKey || "";
  const baseUrl = state.currentBaseUrl || state.capabilities?.llmProvider?.baseUrl || PROVIDER_DEFAULTS[provider]?.baseUrl || "";
  sendCommand({ type: "refresh_models", provider, apiKey, baseUrl });
}
messageInput.focus();
