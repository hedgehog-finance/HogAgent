import { buildInstructionPrompt } from "./instruction-snapshot.ts";
export { parseGatewayProcessInstructions } from "./instruction-snapshot.ts";
import { formatInstructionScope, getInstructionScope, type InstructionScope } from "./instruction-scope.ts";
import { projectDeliverablesDirectory } from "./gateway-project.ts";
/**
 * System Prompt Builder
 *
 * Constructs the system prompt with segments ordered by stability (most stable first)
 * to maximize LLM prompt cache hit rates across providers (Anthropic/OpenAI/Qwen/Gemini).
 *
 * Segment order (stable → volatile):
 *   1. SYSTEM.md          — project-level, rarely changes
 *   2. AGENTS.md          — workspace-level, semi-stable
 *   3. self_evolution     — hardcoded, never changes
 *   4. available_skills   — stable within same mode
 *   5. data_access_strategies — semi-stable, depends on tool set
 *   6. memory_guidance    — semi-stable, depends on memory extension/skill
 *   7. theme              — stable per user, rarely changes
 *   8. conversation_mode  — may change during session
 *   9. context info       — date + paths, most volatile (changes daily/per-session)
 *
 * Note: tool name/description/parameters are sent to the provider as native tool
 * definitions, so they are intentionally NOT duplicated in the system prompt.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getProjectRoot } from "./config.ts";
import { DEFAULT_THEME, resolveThemeOrDefault } from "./themes.ts";
import type { ConversationMode } from "./utils/types.ts";
import type { Skill } from "./vendor/agent/harness/types.ts";
import type { AgentTool } from "./vendor/agent/types.ts";
import type { Model } from "./vendor/ai/base.ts";
import { formatRuntimeContextForModel, type DeepReadonly, type RuntimeContextSnapshot } from "./runtime-context.ts";

const MODE_LABELS: Record<ConversationMode, string> = { quick: "Quick", standard: "Standard", long_task: "Long Task" };

export function getPlatformCommandGuidance(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const windowsGuidance = platform === "win32"
    ? " — prefer node / npm / npx; avoid Unix-only commands; cmd.exe is unsupported; the bash tool uses PowerShell 5.x or verified Git Bash and commands must stay on one line; never inline nested JSON because PowerShell can strip embedded quotes before Node receives them; Chinese I/O must use node"
    : "";
  return `- **Platform**: ${platform} (${arch})${windowsGuidance}`;
}

export function buildSystemPrompt(options: {
  workspaceDir: string;
  sessionTaskDir: string;
  model: Model<any>;
  skills: Skill[];
  activeTools: AgentTool[];
  currentMode?: ConversationMode | null;
  scope?: InstructionScope;
  theme?: string;
  projectDir?: string;
  runtimeContext?: DeepReadonly<RuntimeContextSnapshot>;
}): string {
  let prompt = "";
  const isQuick = options.currentMode === "quick";

  const activeToolNames = new Set(options.activeTools.map((t) => t.name));
  const hasMemoryExtension = activeToolNames.has("memory_save") && activeToolNames.has("memory_search");
  const hogMemorySkillPath = join(options.workspaceDir, ".hogagent", "skills", "hog-memory", "SKILL.md");
  const resolvedHogMemorySkillPath = resolve(hogMemorySkillPath);
  const hogMemorySkill = existsSync(hogMemorySkillPath)
    ? options.skills.find(
      (skill) => skill.name === "hog-memory" && resolve(skill.filePath) === resolvedHogMemorySkillPath,
    )
    : undefined;
  // When the extension is active, hide the fallback skill from the model-visible
  // skill catalog as well as memory guidance so the model cannot select it via
  // the generic skill workflow.
  const visibleSkills = options.skills.filter((skill) => {
    if (skill.name !== "hog-memory") return true;
    return !hasMemoryExtension && skill === hogMemorySkill;
  });

  // Common rules and Hog-specific additions are both loaded in quick mode.
  // Tools and Skill declarations below are gated by the actual tool catalogue.
  prompt = buildInstructionPrompt(options.workspaceDir);

  // --- Segment 3: Self-evolution capabilities (hardcoded, maximally cacheable) ---
  // Quick mode: skip (no tools/skills/extensions available)
  if (!isQuick && activeToolNames.has("write")) {
    prompt += `\n\n<self_evolution>`;
    prompt += `\nYour workspace supports self-evolution — you can customize and extend your capabilities:`;
    prompt += `\n- **AGENTS.md**: Workspace-wide instructions, overriding the HogAgent installation fallback. These are not an application's project-scoped rules; neither file grants directory permissions. Modify only when the user or standing workspace policy authorizes it.`;
    prompt += `\n- **.hogagent/skills/**: Custom skills in workspace/.hogagent/skills/<name>/SKILL.md. If same name as system skill, your version OVERRIDES it.`;
    prompt += `\n- **extensions/**: Custom extensions in workspace/extensions/<name>/index.js. If same name as system extension, your version OVERRIDES it.`;
    prompt += `\nUse these to evolve your capabilities, add domain-specific tools, or customize behavior — without modifying system files.`;
    prompt += `\n</self_evolution>`;
  }

  // --- Segment 4: Available skills (progressive disclosure, stable within same mode) ---
  if (visibleSkills.length > 0 && activeToolNames.has("read")) {
    prompt += `\n\n<available_skills>\n`;
    for (const skill of visibleSkills) {
      const skillPath = skill === hogMemorySkill ? hogMemorySkillPath : skill.filePath;
      prompt += `- ${skill.name}: ${skill.description} (${skillPath})\n`;
    }
    prompt += `</available_skills>\nTo use a skill, read its full content with the read tool, then follow its instructions.`;
    prompt += `\nSkill path resolution: relative paths (./scripts/*) in skill docs are relative to the skill's SKILL.md directory. <hogagent_root> = HogAgent root path above.`;
  }

  // --- Segment 5: Data access strategies (semi-stable, depends on tool set) ---
  const strategies: string[] = [];
  if (activeToolNames.has("read")) strategies.push(
    'read(path, offset=N, limit=M) — bounded file pages (2000 lines / 50 KiB including line numbers); follow the returned next offset. Read Skill instructions completely and continue to EOF when truncated.',
    'read(path, section="## Heading") — extract a bounded Markdown section; oversized sections require locating and reading original file line ranges.',
  );
  if (activeToolNames.has("get_tool_details")) strategies.push('Only for an Entry ID actually present in a tool result: get_tool_details(entry_id, lines=N, offset=M) — retrieve cached text by page.');
  if (activeToolNames.has("query_tool_result")) strategies.push('Only for an Entry ID actually present in a tool result: query_tool_result(entry_id, query="filter:... | sort:... | agg:...") — query cached structured data.');
  if (strategies.length > 0) {
    prompt += `\n\n<data_access_strategies>\n${strategies.map(strategy => `- ${strategy}`).join("\n")}\n</data_access_strategies>`;
  }

  // --- Segment 5.5: Memory guidance (extension first, skill fallback) ---
  // The extension only reaches the active tool set after it is enabled and has a
  // configured Gateway MCP URL. Require both tools so an unrelated tool named
  // memory_save cannot accidentally advertise the full extension capability.
  const canUseMemorySkill = hogMemorySkill && activeToolNames.has("read") && activeToolNames.has("bash");
  if (hasMemoryExtension || canUseMemorySkill) {
    prompt += `\n\n<memory_guidance>`;

    if (hasMemoryExtension) {
      prompt += `\n<memory_extension>`;
      prompt += `\nPersistent cross-session memory via Gateway MCP: use memory_save to save and memory_search to search.`;
      prompt += `\nSAVE when the user request or standing workspace policy authorizes persistence (task_type): market_insight=macro/industry/major-stock events; research_record=stock/sector analysis or valuation; portfolio=positions/rebalancing/allocation; review=trade reviews/lessons; strategy_quant=strategies/backtests/rules. Do not persist transient or sensitive content by default.`;
      prompt += `\nTags convention: always include exchange-suffixed stock codes (e.g. "600519.SH", "000001.SZ"), Shenwan L1 industry (e.g. "\u98df\u54c1\u996e\u6599", "\u7535\u5b50"), and key topics; market_insight MUST include stock codes and industry.`;
      prompt += `\nSEARCH proactively: stock/sector discussion → stock_codes/industry; new analysis → same stock/industry history; past conclusions/preferences → task_type; portfolio/strategy discussion → portfolio/strategy_quant.`;
      prompt += `\n</memory_extension>`;
    }

    // The built-in extension is the preferred implementation. Only advertise
    // the skill fallback when the extension is unavailable, so the model never
    // mixes two memory workflows or schemas.
    if (!hasMemoryExtension && canUseMemorySkill) {
      prompt += `\n<hog_memory_skill>`;
      prompt += `\nPersistent memory fallback: ${hogMemorySkill.description}`;
      prompt += `\nFirst read ${hogMemorySkillPath}.`;
      prompt += `\nSAVE only when the user request or standing workspace policy authorizes persistence; use the skill's save operation, not direct Gateway requests. Do not persist transient or sensitive content by default.`;
      prompt += `\nTypes: market_insight=macro/industry/major-stock events; research_record=stock/sector analysis or valuation; portfolio=positions/rebalancing/allocation; review=trade reviews/lessons; strategy_quant=strategies/backtests/rules.`;
      prompt += `\nTags convention: always pass --tags with exchange-suffixed stock codes (e.g. "600519.SH", "000001.SZ"), Shenwan L1 industry (e.g. "\u98df\u54c1\u996e\u6599", "\u7535\u5b50"), and key topics; market_insight MUST include stock codes and industry.`;
      prompt += `\nSEARCH proactively: use the skill's search operation to retrieve memories.`;
      prompt += `\nWhen: stock/sector discussion → --stock-codes/--industry; new analysis → same stock/industry history; past conclusions/preferences → --task-type; portfolio/strategy → portfolio/strategy_quant.`;
      prompt += `\nOther CLI commands: recall, update, delete, list.`;
      prompt += `\n</hog_memory_skill>`;
    }

    prompt += `\n</memory_guidance>`;
  }

  // --- Segment 6: User's visual theme (stable per user, rarely changes) ---
  const themeKey = options.theme || DEFAULT_THEME;
  const themePreset = resolveThemeOrDefault(themeKey);
  const themeJson = JSON.stringify(themePreset);
  prompt += `\nThe user's default style theme is "${themeKey}" = ${themeJson}. When generating visual content (HTML, tables, charts, slides/PPT, etc.), use this color scheme to ensure visual consistency with the user's interface theme. However, if the user explicitly requests a different theme or color scheme in their message, always honor the user's explicit preference over the default.`;

  // --- Segment 7: Conversation mode ---
  if (options.currentMode) {
    const modeLabel = MODE_LABELS[options.currentMode] || options.currentMode;
    prompt += `\n\n<conversation_mode>\nCurrent conversation mode: ${modeLabel}\n</conversation_mode>`;
  }

  // --- Segment 8: Context info (most volatile — date changes daily, paths per-session) ---
  // Placed last to minimize cache invalidation impact
  prompt += `\n\nCurrent date: ${new Date().toISOString().split("T")[0]}`;
  prompt += `\n${getPlatformCommandGuidance()}`;
  if (activeToolNames.has("write") && activeToolNames.has("bash")) prompt += `\n- **Skill CLI parameters**: pass non-empty single-line top-level string/finite-number/boolean values as named arguments. For objects, arrays, null, multiline text, difficult quoting, or numeric/boolean-looking strings that must stay strings, create UTF-8 JSON with the write tool in a writable task/project directory using a unique tmp-<skill-name>-<id>.json basename, pass the Skill's documented file option, then delete the temporary file. Never inline nested JSON or mix payload sources.`;
  prompt += `\n- **Workspace directory** (default CWD): ${options.workspaceDir} (shared across sessions — do NOT write files directly here)`;
  if (options.projectDir) {
    prompt += `\n- **Session task directory** (internal run state only): ${options.sessionTaskDir}`;
    prompt += `\n- **Native project directory** (accepted root for this request; artifact area: ${projectDeliverablesDirectory()}/ deliverables, src/ code, data/ raw data): ${options.projectDir}`;
    prompt += `\nA native root alone does not enable an application context. Follow current host-injected rules and root validation; never emulate a rejected context or infer another project's path.`;
  } else {
    prompt += `\n- **Session task directory** (current run's working, raw-data, and conversation-delivery files): ${options.sessionTaskDir}`;
  }
  prompt += `\n- **Saved source metadata**: for source-producing Skills that support it, pass --artifact-root ${JSON.stringify(options.projectDir ?? options.sessionTaskDir)}. This is the business root; it does not change --dir/--out. Do not guess a parent root or write internal annotations manually.`;
  prompt += `\nHogAgent root (<hogagent_root>): ${getProjectRoot()} (pre-installed node_modules and skills are here — replace <hogagent_root> in skill docs with this path)`;

  // Injected afresh for every Harness turn so all internal Long Task turns see
  // the same active Prompt Run. This segment is never appended to user history,
  // persisted JSONL, or included in compaction input.
  prompt += formatRuntimeContextForModel(options.runtimeContext);

  prompt += formatInstructionScope(options.scope ?? getInstructionScope(), [...activeToolNames]);
  return prompt;
}
