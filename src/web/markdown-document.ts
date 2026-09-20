/** Presentation-only chart footnotes shared by the WebUI and image access checks. */
export interface MarkdownChartReference { id: string; json: string; description: string }

function objectEnd(text: string, start: number): number {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return -1;
      i++;
    } else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

export function extractMarkdownChartSection(markdown: string): { body: string; charts: MarkdownChartReference[] } {
  const lines = markdown.split("\n");
  let fence: { marker: string; length: number } | undefined;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = /^(#{1,6}\s*)?(?:\*\*)?\[图表数据\](?:\*\*)?$/.exec(line);
    if (!fence && match && start < 0) { start = i; continue; }
    if (start >= 0 && !fence && /^(?:#{1,6}\s+\S|\[[^\[\]{}"]+\]\s*$)/.test(line)) { end = i; break; }
    const boundary = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (boundary) {
      if (!fence) fence = { marker: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === fence.marker && boundary[1].length >= fence.length && !boundary[2].trim()) fence = undefined;
    }
  }
  if (start < 0) return { body: markdown, charts: [] };
  const section = lines.slice(start + 1, end).join("\n");
  const matches = [...section.matchAll(/(?:^|\n)[ \t]*(?:[-*]\s*)?(\{图\d+\})\s*[:：]?\s*/g)];
  const charts = matches.map((match, index) => {
    const chunk = section.slice(match.index! + match[0].length, matches[index + 1]?.index ?? section.length).trim();
    const jsonStart = chunk.indexOf("{");
    const jsonEnd = jsonStart >= 0 ? objectEnd(chunk, jsonStart) : -1;
    return {
      id: match[1], json: jsonEnd < 0 ? "" : chunk.slice(jsonStart, jsonEnd + 1),
      description: jsonEnd < 0 ? "" : chunk.slice(jsonEnd + 1).replace(/^\s*```\s*/, "").trim(),
    };
  });
  return { body: [...lines.slice(0, start), "", ...lines.slice(end)].join("\n"), charts };
}

export function chartImageUrl(json: string): string | undefined {
  try {
    const value = JSON.parse(json);
    return typeof value?.url === "string" ? value.url : undefined;
  } catch { return undefined; }
}
