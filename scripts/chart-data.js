// GENERATED from frontend/web2/lib/markdown/briefingChartData.ts. Do not edit.
export const findBriefingChartDataSection = (content) => {
    const match = /\[图表数据\]|^ {0,3}#{1,6}[ \t]+图表数据[ \t]*$/m.exec(content);
    return match ? { start: match.index, end: match.index + match[0].length } : null;
};
const isRecord = (value) => (Boolean(value) && typeof value === 'object' && !Array.isArray(value));
const skipQuotedString = (text, start) => {
    const quote = text[start];
    let index = start + 1;
    while (index < text.length) {
        if (text[index] === '\\') {
            index += 2;
            continue;
        }
        if (text[index] === quote)
            return index + 1;
        index += 1;
    }
    return text.length;
};
const findFunctionExpressionEnd = (text, start) => {
    let index = start + 'function'.length;
    while (index < text.length && /\s/.test(text[index]))
        index += 1;
    while (index < text.length && /[A-Za-z0-9_$]/.test(text[index]))
        index += 1;
    while (index < text.length && /\s/.test(text[index]))
        index += 1;
    if (text[index] !== '(')
        return start;
    let parenthesisDepth = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === '"' || char === "'" || char === '`') {
            index = skipQuotedString(text, index);
            continue;
        }
        if (char === '(')
            parenthesisDepth += 1;
        if (char === ')' && --parenthesisDepth === 0) {
            index += 1;
            break;
        }
        index += 1;
    }
    while (index < text.length && /\s/.test(text[index]))
        index += 1;
    if (text[index] !== '{')
        return start;
    let braceDepth = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === '"' || char === "'" || char === '`') {
            index = skipQuotedString(text, index);
            continue;
        }
        if (char === '/' && text[index + 1] === '/') {
            while (index < text.length && text[index] !== '\n')
                index += 1;
            continue;
        }
        if (char === '/' && text[index + 1] === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/'))
                index += 1;
            index += 2;
            continue;
        }
        if (char === '{')
            braceDepth += 1;
        if (char === '}' && --braceDepth === 0)
            return index;
        index += 1;
    }
    return start;
};
/**
 * Historical reports may contain ECharts formatter functions. They are never
 * executable input: replace each literal with null so ECharts uses its own
 * safe default formatter while retaining the chart data.
 */
const stripJsFunctionLiterals = (text) => {
    let result = '';
    let index = 0;
    while (index < text.length) {
        if (text[index] === '"') {
            const end = skipQuotedString(text, index);
            result += text.slice(index, end);
            index = end;
            continue;
        }
        if (text.startsWith('function', index) && (index === 0 || !/[A-Za-z0-9_$]/.test(text[index - 1]))) {
            const end = findFunctionExpressionEnd(text, index);
            if (end > index) {
                result += 'null';
                index = end + 1;
                continue;
            }
        }
        result += text[index];
        index += 1;
    }
    return result;
};
/** Recover the known field mix-up only when option contains descriptive metadata. */
const recoverMisplacedChartOption = (parsed) => {
    if (typeof parsed.chart !== 'string' || !parsed.chart.trim().startsWith('{') || !parsed.option)
        return parsed;
    if (Object.keys(parsed.option).some(key => key !== 'unit' && key !== 'summary'))
        return parsed;
    try {
        // Decode one JSON object, never JavaScript or another nested chart wrapper.
        const option = JSON.parse(parsed.chart);
        if (!isRecord(option) || !Array.isArray(option.series) || option.series.length === 0)
            return parsed;
        const seriesTypes = option.series.map(series => isRecord(series) ? series.type : undefined);
        const chart = seriesTypes[0];
        if (typeof chart !== 'string' || !['bar', 'line', 'pie', 'radar', 'scatter', 'heatmap'].includes(chart))
            return parsed;
        if (!seriesTypes.every(type => type === chart))
            return parsed;
        return { chart, option };
    }
    catch {
        return parsed;
    }
};
export const parseBriefingChartData = (raw) => {
    const trimmed = raw.trim();
    const candidates = [
        trimmed,
        trimmed.replace(/\\"/g, '"'),
        stripJsFunctionLiterals(trimmed),
        stripJsFunctionLiterals(trimmed.replace(/\\"/g, '"')),
    ];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (!isRecord(parsed))
                continue;
            if (isRecord(parsed.option))
                return recoverMisplacedChartOption(parsed);
            if (Array.isArray(parsed.series)
                || isRecord(parsed.xAxis)
                || isRecord(parsed.yAxis)
                || (typeof parsed.chart === 'string' && Array.isArray(parsed.data))) {
                return {
                    chart: typeof parsed.chart === 'string' ? parsed.chart : 'line',
                    option: parsed,
                };
            }
        }
        catch {
            // Try the next safe normalization candidate.
        }
    }
    return null;
};
const findJsonObjectEnd = (text, startIndex) => {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = startIndex; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote)
                quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === '/' && text[index + 1] === '/') {
            while (index < text.length && text[index] !== '\n')
                index += 1;
            continue;
        }
        if (char === '/' && text[index + 1] === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/'))
                index += 1;
            index += 1;
            continue;
        }
        if (char === '{')
            depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    return -1;
};
export const extractBriefingChartDataMap = (content) => {
    const section = findBriefingChartDataSection(content);
    if (!section)
        return {};
    const chartDataContent = content.slice(section.end);
    const chartDataMap = {};
    const chartEntryPattern = /(\{图\d+\})\s*(?::\s*)?\{/g;
    let match;
    while ((match = chartEntryPattern.exec(chartDataContent)) !== null) {
        const chartId = match[1];
        const jsonStartIndex = chartEntryPattern.lastIndex - 1;
        const jsonEndIndex = findJsonObjectEnd(chartDataContent, jsonStartIndex);
        if (jsonEndIndex < 0)
            continue;
        const chartData = parseBriefingChartData(chartDataContent.slice(jsonStartIndex, jsonEndIndex + 1));
        if (chartData)
            chartDataMap[chartId] = chartData;
        chartEntryPattern.lastIndex = jsonEndIndex + 1;
    }
    return chartDataMap;
};
