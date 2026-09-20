# Vega-Lite Specification Examples

> The `$schema` field is **optional**. The script auto-detects Vega-Lite by structure (`mark` + `encoding`).
> If included, use: `"$schema": "https://vega.github.io/schema/vega-lite/v6.json"` or omit entirely.
> Local schema stub: `references/vega-lite-schema.json`

## Bar Chart
```json
{
  "data": {
    "values": [
      {"category": "A", "value": 28},
      {"category": "B", "value": 55},
      {"category": "C", "value": 43},
      {"category": "D", "value": 91}
    ]
  },
  "mark": "bar",
  "encoding": {
    "x": {"field": "category", "type": "nominal", "axis": {"labelAngle": 0}},
    "y": {"field": "value", "type": "quantitative"}
  }
}
```

## Line Chart
```json
{
  "data": {
    "values": [
      {"date": "2024-01-01", "price": 100},
      {"date": "2024-02-01", "price": 115},
      {"date": "2024-03-01", "price": 108},
      {"date": "2024-04-01", "price": 130}
    ]
  },
  "mark": "line",
  "encoding": {
    "x": {"field": "date", "type": "temporal"},
    "y": {"field": "price", "type": "quantitative"}
  }
}
```

> Temporal fields MUST use ISO 8601 (`"2024-01-01"`). Non-ISO strings like `"2024-01"` or `"2024年1月"` are auto-fixed by the script but should be avoided.

## Pie Chart
```json
{
  "data": {
    "values": [
      {"category": "Stocks", "value": 60},
      {"category": "Bonds", "value": 25},
      {"category": "Cash", "value": 15}
    ]
  },
  "mark": "arc",
  "encoding": {
    "theta": {"field": "value", "type": "quantitative"},
    "color": {"field": "category", "type": "nominal"}
  }
}
```

## Scatter Plot
```json
{
  "data": {
    "values": [
      {"x": 10, "y": 20, "size": 5},
      {"x": 30, "y": 45, "size": 8},
      {"x": 50, "y": 35, "size": 3}
    ]
  },
  "mark": "point",
  "encoding": {
    "x": {"field": "x", "type": "quantitative"},
    "y": {"field": "y", "type": "quantitative"},
    "size": {"field": "size", "type": "quantitative"}
  }
}
```
