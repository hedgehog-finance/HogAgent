# ECharts Chart Configuration Examples

> Input: `{ "chart": "<type>", "option": { ... } }` (BriefingChartData)
> Script reads from JSON file (`--spec`), outputs enhanced JSON to stdout. No files generated.

## Supported Chart Types

| Type | ECharts series.type | Notes |
|------|---------------------|-------|
| `line` | `line` | Line chart |
| `area` | `line` + `areaStyle` | Area chart |
| `bar` | `bar` | Vertical bar |
| `horizontal bar` | `bar` | Horizontal (xAxis=value, yAxis=category) |
| `histogram` | `bar` | Narrower bars |
| `pie` | `pie` | Pie chart |
| `donut` | `pie` | With inner radius |
| `radar` | `radar` | Radar chart |
| `scatter` / `scatter plot` | `scatter` | Scatter plot |
| `bubble` | `scatter` | With symbolSize |

## Line Chart
```json
{
  "chart": "line",
  "option": {
    "title": { "text": "Monthly Stock Price Trend" },
    "xAxis": { "type": "category", "data": ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"] },
    "yAxis": { "type": "value" },
    "series": [{ "type": "line", "name": "Close Price", "data": [100, 115, 108, 130, 125] }]
  }
}
```

## Multi-Series Line
```json
{
  "chart": "line",
  "option": {
    "title": { "text": "Revenue vs Profit" },
    "xAxis": { "type": "category", "data": ["Q1", "Q2", "Q3", "Q4"] },
    "yAxis": { "type": "value" },
    "series": [
      { "type": "line", "name": "Revenue", "data": [120, 150, 180, 200] },
      { "type": "line", "name": "Profit", "data": [30, 45, 55, 70] }
    ]
  }
}
```

## Bar Chart (Positive/Negative)
```json
{
  "chart": "bar",
  "option": {
    "title": { "text": "Quarterly YoY Growth" },
    "xAxis": { "type": "category", "data": ["Q1", "Q2", "Q3", "Q4"] },
    "yAxis": { "type": "value" },
    "series": [{ "type": "bar", "name": "YoY Growth", "data": [5.2, -3.1, 8.7, 12.4] }]
  }
}
```

## Horizontal Bar
```json
{
  "chart": "horizontal bar",
  "option": {
    "title": { "text": "Revenue by Business Line" },
    "xAxis": { "type": "value" },
    "yAxis": { "type": "category", "data": ["E-commerce", "Advertising", "Cloud", "FinTech"] },
    "series": [{ "type": "bar", "name": "Revenue (B)", "data": [320, 180, 150, 95] }]
  }
}
```

## Pie Chart
```json
{
  "chart": "pie",
  "option": {
    "title": { "text": "Asset Allocation" },
    "series": [{
      "type": "pie", "name": "Allocation",
      "data": [
        { "name": "Stocks", "value": 60 },
        { "name": "Bonds", "value": 25 },
        { "name": "Cash", "value": 15 }
      ]
    }]
  }
}
```

## Donut Chart
```json
{
  "chart": "donut",
  "option": {
    "title": { "text": "Revenue Breakdown" },
    "series": [{
      "type": "pie", "name": "Revenue",
      "data": [
        { "name": "Core Business", "value": 420 },
        { "name": "Other", "value": 80 },
        { "name": "Investment", "value": 50 }
      ]
    }]
  }
}
```

## Radar Chart
```json
{
  "chart": "radar",
  "option": {
    "title": { "text": "Financial KPIs" },
    "radar": {
      "indicator": [
        { "name": "Profitability", "max": 100 },
        { "name": "Solvency", "max": 100 },
        { "name": "Efficiency", "max": 100 },
        { "name": "Growth", "max": 100 },
        { "name": "Cash Flow", "max": 100 }
      ]
    },
    "series": [{ "type": "radar", "name": "Current", "data": [{ "value": [85, 72, 68, 90, 75] }] }]
  }
}
```

## Scatter Plot
```json
{
  "chart": "scatter",
  "option": {
    "title": { "text": "P/E vs Growth Rate" },
    "xAxis": { "type": "value", "name": "P/E Ratio" },
    "yAxis": { "type": "value", "name": "Growth (%)" },
    "series": [{
      "type": "scatter", "name": "Company",
      "data": [[15.2, 12.5], [22.8, 18.3], [8.5, 5.2], [31.0, 25.7], [18.4, -3.1]]
    }]
  }
}
```

## Area Chart
```json
{
  "chart": "area",
  "option": {
    "title": { "text": "Market Cap Change" },
    "xAxis": { "type": "category", "data": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"] },
    "yAxis": { "type": "value" },
    "series": [{ "type": "line", "name": "Market Cap", "data": [500, 520, 480, 550, 580, 610], "areaStyle": {} }]
  }
}
```

## Theme Selection

`--theme=<name>` injects color palette, background, and axis/tooltip styling.

```bash
node echarts-config.mjs --spec <workspace>/tmp-gen-chart-<id>.json --theme=bloomberg   # Bloomberg dark
node echarts-config.mjs --spec <workspace>/tmp-gen-chart-<id>.json --theme=fintech     # Default
node echarts-config.mjs --spec <workspace>/tmp-gen-chart-<id>.json --theme=none        # Raw option
node echarts-config.mjs --theme=list                          # Show all themes
```

> See SKILL.md "Financial Color Themes" for full theme table.

## Frontend Compatibility

Output JSON matches `BriefingChartData`:
```typescript
type BriefingChartData = { chart?: string; option?: Record<string, unknown> };
```

Frontend `buildBriefingChartOption()` strips color fields (`color`, `*Color`, `backgroundColor`) and applies its own palette (CHART_PALETTE). Result: theme colors fully apply for **standalone rendering**, while frontend pipeline applies consistent app styling. Both paths render correctly.

Frontend rendering:
- **Web**: `BriefingChart.web.tsx` — ECharts 5.5.1 via CDN, canvas renderer
- **Native**: `BriefingChart.native.tsx` — WebView with embedded ECharts HTML
