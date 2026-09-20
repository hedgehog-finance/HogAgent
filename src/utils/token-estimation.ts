/**
 * Multilingual Token Estimation
 *
 * Provides accurate token counting for text across multiple writing systems.
 * Token density by script category:
 *   - CJK (Chinese/Japanese/Korean):          ~1.3 tokens per character
 *   - Complex scripts (Thai/Lao/Myanmar/etc.): ~0.7 tokens per character
 *   - Indic scripts (Devanagari/Bengali/etc.): ~0.6 tokens per character
 *   - RTL scripts (Arabic/Hebrew/etc.):        ~0.5 tokens per character
 *   - Latin/Cyrillic/Greek (English, code...): ~0.25 tokens per character (4 chars/token)
 *
 * This module is the single source of truth for token estimation heuristics.
 * Vendor code (compaction.ts) delegates to this module.
 */

import type { AgentMessage } from "../vendor/agent/types.ts";
import type { AssistantMessage } from "../vendor/ai/types.ts";

// ─── Token Density Constants ──────────────────────────────────────────────────

const CJK_CHARS_PER_TOKEN = 1.3;
const COMPLEX_SCRIPT_CHARS_PER_TOKEN = 0.7;
const INDIC_CHARS_PER_TOKEN = 0.6;
const RTL_CHARS_PER_TOKEN = 0.5;
const LATIN_CHARS_PER_TOKEN = 0.25; // 4 chars per token
const ESTIMATED_IMAGE_TOKENS = 1200;

// ─── Unicode Script Regexes ───────────────────────────────────────────────────

// CJK Unified Ideographs + Extensions A, CJK Compat, Fullwidth, Hiragana, Katakana, Hangul
const CJK_REGEX = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\u3040-\u30FF\uAC00-\uD7AF]/g;

// Thai, Lao, Myanmar (Burmese), Khmer, Tibetan
const COMPLEX_SCRIPT_REGEX = /[\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u0F00-\u0FFF]/g;

// Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Punjabi (Gurmukhi)
const INDIC_REGEX = /[\u0900-\u097F\u0980-\u09FF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0A80-\u0AFF\u0A00-\u0A7F]/g;

// Arabic (incl. supplement), Hebrew, Arabic Presentation Forms A/B
const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

// ─── Core String Estimation ───────────────────────────────────────────────────

/** Estimate token count for a plain string with multilingual awareness. */
export function estimateStringTokens(text: string): number {
	const cjkCount = (text.match(CJK_REGEX) ?? []).length;
	const complexCount = (text.match(COMPLEX_SCRIPT_REGEX) ?? []).length;
	const indicCount = (text.match(INDIC_REGEX) ?? []).length;
	const rtlCount = (text.match(RTL_REGEX) ?? []).length;
	const latinCount = text.length - cjkCount - complexCount - indicCount - rtlCount;
	return Math.ceil(
		cjkCount * CJK_CHARS_PER_TOKEN +
		complexCount * COMPLEX_SCRIPT_CHARS_PER_TOKEN +
		indicCount * INDIC_CHARS_PER_TOKEN +
		rtlCount * RTL_CHARS_PER_TOKEN +
		latinCount * LATIN_CHARS_PER_TOKEN,
	);
}

/** Truncate text to fit within a token budget (including the suffix) using binary search. */
export function truncateByTokens(text: string, maxTokens: number, suffix = "\n...(truncated)"): { text: string; truncated: boolean } {
	const totalTokens = estimateStringTokens(text);
	if (totalTokens <= maxTokens) return { text, truncated: false };

	// Reserve budget for the suffix so the final "prefix + suffix" stays within maxTokens.
	const prefixBudget = Math.max(0, maxTokens - estimateStringTokens(suffix));

	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (estimateStringTokens(text.slice(0, mid)) <= prefixBudget) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return { text: text.slice(0, lo) + suffix, truncated: true };
}

// ─── Content Block Estimation ───────────────────────────────────────────────────

function estimateContentBlockTokens(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return estimateStringTokens(content);
	}
	let tokens = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			tokens += estimateStringTokens(block.text);
		} else if (block.type === "image") {
			tokens += ESTIMATED_IMAGE_TOKENS;
		}
	}
	return tokens;
}

// ─── Message-level Estimation ───────────────────────────────────────────────────

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "[unserializable]";
	}
}

/** Estimate token count for one message with CJK-aware character heuristic. */
export function estimateMessageTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user": {
			return estimateContentBlockTokens(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			let tokens = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					tokens += estimateStringTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += estimateStringTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += estimateStringTokens(block.name) + estimateStringTokens(safeJsonStringify(block.arguments));
				}
			}
			return tokens;
		}
		case "custom":
		case "toolResult": {
			return estimateContentBlockTokens(message.content);
		}
		case "bashExecution": {
			return estimateStringTokens(message.command) + estimateStringTokens(message.output);
		}
		case "branchSummary":
		case "compactionSummary": {
			return estimateStringTokens(message.summary);
		}
	}

	return 0;
}
