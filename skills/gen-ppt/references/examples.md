# GenPPT Example Templates

> Native `bar`, `line`, `pie`, `doughnut`, `area`, `scatter`, and `radar` charts remain editable. For scatter charts, use `{ "xValues": [...], "yValues": [...] }` per series as documented in `json-schema.md`; a single generic `{labels, values}` series is rejected because it renders no points.

## Example 1: Financial Report (5 slides, economist theme)

```json
{
  "title": "2026 Q2 Macro Outlook",
  "author": "Research Division",
  "date": "2026-06-26",
  "theme": "economist",
  "slides": [
    {
      "layout": "title",
      "title": "2026 Q2 Macro Economic Outlook",
      "subtitle": "Global Growth, Inflation & Policy Outlook",
      "date": "June 2026",
      "author": "Research Division"
    },
    {
      "layout": "content",
      "title": "Executive Summary",
      "bullets": [
        { "text": "Global GDP growth revised up to 3.2% for 2026", "level": 0, "bold": true },
        { "text": "Driven by resilient US consumption and China stimulus", "level": 1 },
        { "text": "Inflation trending toward 2% targets in most DM", "level": 0, "bold": true },
        { "text": "Fed expected to cut 50bps by year-end", "level": 1 },
        "Key risk: geopolitical escalation and commodity price shocks"
      ],
      "footnote": "Source: IMF WEO April 2026, Bloomberg"
    },
    {
      "layout": "chart",
      "title": "GDP Growth Forecast by Region",
      "subtitle": "2026E Real GDP Growth (%)",
      "chart": {
        "type": "bar",
        "data": [
          { "name": "2026E GDP", "labels": ["US","Eurozone","China","Japan","India"], "values": [2.4,0.8,5.0,1.2,6.8] }
        ],
        "options": { "barDir": "col", "showValue": true, "dataLabelPosition": "outEnd", "valAxisTitle": "Growth (%)" }
      },
      "footnote": "Source: IMF WEO, April 2026"
    },
    {
      "layout": "table",
      "title": "Key Economic Indicators",
      "table": {
        "headers": ["Country", "GDP Growth", "CPI YoY", "Policy Rate"],
        "rows": [
          ["United States", "2.4%", "2.3%", "4.50%"],
          ["Eurozone", "0.8%", "1.9%", "3.25%"],
          ["China", "5.0%", "0.5%", "3.45%"],
          ["Japan", "1.2%", "2.8%", "0.50%"],
          ["India", "6.8%", "4.2%", "6.25%"]
        ],
        "colW": [1.5, 1.2, 1.2, 1.2]
      },
      "footnote": "Source: National statistics, Bloomberg"
    },
    {
      "layout": "closing",
      "title": "Thank You",
      "subtitle": "research@hedgehog.com"
    }
  ]
}
```

---

## Example 2: Portfolio Review (6 slides, oldmoney theme, mixed layouts)

```json
{
  "title": "Portfolio Review Q2 2026",
  "author": "Wealth Management",
  "theme": "oldmoney",
  "slides": [
    {
      "layout": "title",
      "title": "Portfolio Review",
      "subtitle": "Q2 2026 Quarterly Review",
      "date": "June 26, 2026",
      "author": "Wealth Management Team"
    },
    {
      "layout": "section",
      "sectionNumber": "01",
      "title": "Performance Overview",
      "subtitle": "Total return, attribution, and benchmark comparison"
    },
    {
      "layout": "two-column",
      "title": "Q2 Performance Highlights",
      "left": {
        "title": "Achievements",
        "bullets": ["Portfolio +8.2% vs benchmark +6.5%", "Fixed income outperformed by 120bps", "Currency hedging saved 45bps"]
      },
      "right": {
        "title": "Improvements",
        "bullets": ["EM equity underperformed by 80bps", "Tech overweight dragged returns", "Consider reducing duration"]
      },
      "footnote": "Net of fees. Benchmark: 60/40 MSCI ACWI / Bloomberg Agg."
    },
    {
      "layout": "chart",
      "title": "Allocation vs Benchmark",
      "chart": {
        "type": "bar",
        "data": [
          { "name": "Portfolio", "labels": ["Equity","Fixed Income","Alternatives","Cash"], "values": [45,30,15,10] },
          { "name": "Benchmark", "labels": ["Equity","Fixed Income","Alternatives","Cash"], "values": [60,35,5,0] }
        ],
        "options": { "barDir": "col", "barGrouping": "clustered", "showLegend": true, "legendPos": "b", "showValue": true }
      }
    },
    {
      "layout": "chart",
      "title": "Monthly Returns — Trailing 6M",
      "chart": {
        "type": "line",
        "data": [
          { "name": "Portfolio", "labels": ["Jan","Feb","Mar","Apr","May","Jun"], "values": [-1.0,2.8,1.1,0.6,2.3,1.8] },
          { "name": "Benchmark", "labels": ["Jan","Feb","Mar","Apr","May","Jun"], "values": [-1.5,2.2,0.8,0.3,1.9,1.5] }
        ],
        "options": { "showLegend": true, "legendPos": "b", "lineSize": 2 }
      },
      "footnote": "Source: Bloomberg"
    },
    {
      "layout": "closing",
      "title": "Questions & Discussion",
      "subtitle": "wealth@hedgehog.com"
    }
  ]
}
```

---

## Example 3: Product Pitch Deck (6 slides, saas theme, custom elements)

```json
{
  "title": "Hedgehog AI — Investor Pitch",
  "theme": "saas",
  "slides": [
    {
      "layout": "title",
      "title": "Hedgehog AI",
      "subtitle": "AI-Powered Financial Research Platform",
      "date": "Series A - 2026"
    },
    {
      "layout": "content",
      "title": "The Problem",
      "bullets": [
        { "text": "Analysts spend 70% of time on data gathering", "level": 0, "bold": true },
        { "text": "Only 30% on actual analysis", "level": 1 },
        "Manual report creation takes 4-8 hours",
        { "text": "Critical insights lost in information overload", "level": 0, "bold": true }
      ]
    },
    {
      "layout": "chart",
      "title": "Market Opportunity",
      "subtitle": "Global Financial Analytics Market (USD B)",
      "chart": {
        "type": "bar",
        "data": [{ "name": "Market Size", "labels": ["2023","2024","2025","2026E","2027E"], "values": [42,51,63,78,97] }],
        "options": { "barDir": "col", "showValue": true, "dataLabelPosition": "outEnd" }
      }
    },
    {
      "layout": "two-column",
      "title": "Our Solution",
      "left": { "title": "Architecture", "bullets": ["Autonomous research agents", "Multi-step pipelines", "Real-time data integration"] },
      "right": { "title": "Differentiators", "bullets": ["10x faster than manual", "Domain-specific LLM", "Enterprise security"] }
    },
    {
      "layout": "chart",
      "title": "Revenue Trajectory",
      "chart": {
        "type": "bar",
        "data": [
          { "name": "ARR ($M)", "labels": ["2024","2025","2026E"], "values": [2.5,8.0,20.0] },
          { "name": "Customers", "labels": ["2024","2025","2026E"], "values": [15,52,130] }
        ],
        "options": { "barDir": "col", "barGrouping": "clustered", "showLegend": true, "legendPos": "b", "showValue": true }
      },
      "elements": [
        { "type": "text", "content": "3.2x YoY Growth", "x": 7.0, "y": 1.0, "w": 2.5, "h": 0.4, "options": { "fontSize": 14, "bold": true, "color": "10B981", "align": "right" } }
      ]
    },
    {
      "layout": "closing",
      "title": "Let's Build the Future",
      "subtitle": "investors@hedgehog.ai"
    }
  ]
}
```

---

## Example 4: Minimal (2 slides, no theme)

```json
{
  "theme": "none",
  "slides": [
    { "layout": "title", "title": "Quick Update", "subtitle": "Team Meeting — June 2026" },
    { "layout": "content", "title": "Action Items", "bullets": ["Complete Q2 report", "Review allocations", "Schedule client calls"] }
  ]
}
```

---

## Example 5: Custom Theme + Blank Layout

```json
{
  "theme": "fintech",
  "customTheme": { "primary": "0066CC", "background": "F5F5F5", "colors": ["0066CC","00AA55","FF6600","CC0066","6633CC","00BBCC"] },
  "slides": [
    { "layout": "title", "title": "Custom Branded Deck", "subtitle": "Using custom theme overrides" },
    {
      "layout": "blank",
      "elements": [
        { "type": "shape", "shape": "roundRect", "x": 0.5, "y": 0.5, "w": 4.0, "h": 2.0, "options": { "fill": { "color": "0066CC" }, "line": { "color": "004499", "width": 2 } } },
        { "type": "text", "content": "Key Metric: 42%", "x": 0.5, "y": 0.8, "w": 4.0, "h": 1.0, "options": { "fontSize": 28, "bold": true, "color": "FFFFFF", "align": "center", "valign": "middle" } },
        { "type": "text", "content": "YoY improvement in client satisfaction", "x": 5.0, "y": 0.8, "w": 4.5, "h": 1.5, "options": { "fontSize": 16, "color": "333333" } }
      ]
    }
  ]
}
```

---

## Example 6: Image-Text Arrangements + Inline Formatting

Four `image.position` arrangements — pick per content: wide charts → `top`/`bottom`; tall images → `left`/`right`. Text fields support inline markers (`**bold**`, `*italic*`, `<u>`, `~~strike~~`, `` `code` ``, `<center>`, `<br>`).

```json
{
  "title": "Industry Valuation Review",
  "theme": "economist",
  "targetViewer": "universal",
  "slides": [
    {
      "layout": "image-text",
      "title": "PE Comparison — Wide Chart on Top",
      "image": { "path": "/abs/path/industry_pe_comparison.png", "position": "top", "alt": "PE comparison chart" },
      "body": "Semiconductor PE at **68.5x** remains *well above* the sector median of 32x — valuation premium driven by AI demand.",
      "footnote": "Source: Wind, as of 2026-06"
    },
    {
      "layout": "image-text",
      "title": "Revenue Bridge — Text Above, Chart Below",
      "image": { "path": "/abs/path/revenue_bridge.png", "position": "bottom" },
      "body": "FY26 revenue guidance raised to **¥12.8bn** (+18% YoY); key driver is the `data-center` segment."
    },
    {
      "layout": "image-text",
      "title": "Tall Image Left, Bullets Right",
      "image": { "path": "/abs/path/supply_chain_map.png", "position": "left" },
      "bullets": [
        { "text": "**Upstream**: wafer supply tightening", "level": 0 },
        { "text": "*Midstream*: capacity utilization at 92%", "level": 1 },
        { "text": "~~Prior estimate 85%~~ revised up", "level": 1 }
      ]
    },
    {
      "layout": "image-text",
      "title": "Bullets Left, Image Right",
      "image": { "path": "/abs/path/margin_trend.png", "position": "right" },
      "bullets": ["Gross margin +2.1pp QoQ", "Opex ratio stable at 18%"]
    },
    {
      "layout": "chart",
      "title": "Unsupported Native Type as Static Image",
      "subtitle": "<center>Candlestick has no native gen-ppt implementation</center>",
      "chart": { "type": "image", "path": "/abs/path/candlestick_chart.png" },
      "footnote": "Use type:image for unsupported/static charts and for every chart in Keynote or universal delivery"
    }
  ]
}
```
