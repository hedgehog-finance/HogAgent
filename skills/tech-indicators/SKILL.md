---
name: tech-indicators
description: >
    Calculate technical analysis indicators and candlestick patterns from OHLCV data locally.
    Triggers: technical indicator, RSI, MACD, SMA, EMA, Bollinger, stochastic, KDJ, ATR, ADX, SuperTrend,
    candlestick pattern, doji, hammer, engulfing, K-line pattern, 技术指标, K线形态.
    Blocking: fetching live market data, backtesting, portfolio management, chart rendering.
version: 1.1.2
---

# Tech-Indicators — Local Technical Indicator Calculation Engine

Computes 74 technical indicators and candlestick patterns entirely offline, powered by fast-technical-indicators. No network requests required. Renko is intentionally excluded because its variable-length brick series cannot be aligned truthfully to this CLI's one-row-per-candle output.

## Scripts

Input OHLCV JSON may be an existing source artifact. If the Agent creates a custom indicator-parameter object, write it as a unique UTF-8 workspace file named `tmp-tech-indicators-<id>.json`, pass its path through `--params-file`, and remove it after the call. Do not inline or shell-assemble JSON. The old `--params <file>` spelling remains a compatibility alias.

### calc.mjs — Main calculation script
```bash
node ./scripts/calc.mjs <data.json> <output> [--indicators sma,ema,rsi,...] [--params-file "<workspace>/tmp-tech-indicators-<id>.json"] [--format json|markdown]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--indicators` | `sma,ema,rsi,macd,bollingerbands` | Comma-separated indicator names; use `all` for all 74 |
| `--params-file` | none | UTF-8 JSON file path for custom indicator parameters (`--params` is a compatibility alias) |
| `--format` | `json` | Output format: `json` or `markdown` |
| `--list` | — | List all supported indicator names (no input/output needed) |

## Input Format

JSON array; each record must contain OHLCV fields:
```json
[
  {"date": "2024-01-02", "open": 187.13, "high": 188.44, "low": 186.60, "close": 187.68, "volume": 41266200},
  {"date": "2024-01-03", "open": 184.22, "high": 185.88, "low": 183.43, "close": 185.64, "volume": 47365200}
]
```

Field name aliases: `date/trade_date/time/timestamp/datetime`, `open/Open`, `high/High`, `low/Low`, `close/Close`, `volume/Volume/vol`

Auto-processing:
- Date normalization to ISO 8601 (`20240102`, `2024/1/2` → `2024-01-02`), directly usable for chart temporal axis
- When date field is missing, generates index sequence (1, 2, 3...) as the `date` column; downstream charts should use ordinal/quantitative axis
- Detects descending date order (newest first, e.g. tushare format) and auto-reverses to ascending before calculation — EMA/MACD and other recursive indicators depend on ascending time order

## Supported Indicators

### Trend
SMA, EMA, WMA, WEMA, MACD, PSAR, SuperTrend, Aroon, AroonOscillator, IchimokuCloud, Trix, DPO, LinearRegression, MAEnvelope

### Oscillators
RSI, StochasticRSI, CCI, WilliamsR, ROC, PPO, KST, UltimateOscillator, PriceOscillator, Stochastic, KDJ

### Channels
BollingerBands, DonchianChannels, KeltnerChannels, ChandelierExit

### Volume
OBV, VWAP, ADL, MFI, ForceIndex

### Volatility
ATR, SD (Standard Deviation), VolatilityIndex

### Candlestick Patterns (35 types)
Doji, Hammer, SpinningTop, Marubozu, ShootingStar, BullishEngulfing, BearishEngulfing,
BullishHarami, BearishHarami, MorningStar, EveningStar, ThreeWhiteSoldiers, ThreeBlackCrows,
PiercingLine, DarkCloudCover, DragonflyDoji, GravestoneDoji, HangingMan, TweezerTop, TweezerBottom,
AbandonedBaby, DownsideTasukiGap, etc.

## Custom Params Format

JSON object; keys are indicator names, values are parameter overrides:
```json
{
  "sma": {"period": 20},
  "ema": {"period": 50},
  "rsi": {"period": 14},
  "macd": {"fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9},
  "bollingerbands": {"period": 20, "stdDev": 2},
  "stochastic": {"period": 14, "signalPeriod": 3}
}
```

## Workflow

1. **Prepare data** — Save OHLCV data as a JSON file (use `table-convert` skill to convert from CSV/Excel)
2. **Run calculation** — `node <this_skill_dir>/scripts/calc.mjs data.json result.json --indicators=sma,rsi,macd`
3. **Inspect results** — Output file contains original data plus computed indicator columns

## Examples

```bash
# Default indicators (SMA, EMA, RSI, MACD, BollingerBands)
node ./scripts/calc.mjs ohlcv.json result.json

# Specific indicators
node ./scripts/calc.mjs ohlcv.json result.json --indicators=rsi,macd,stochastic,atr

# Candlestick pattern recognition
node ./scripts/calc.mjs ohlcv.json patterns.json --indicators=doji,hammer,bullishengulfing,threeblackcrows

# All 74 indicators
node ./scripts/calc.mjs ohlcv.json full.json --indicators=all

# Custom parameters
node ./scripts/calc.mjs ohlcv.json result.json --indicators sma,rsi --params-file "<workspace>/tmp-tech-indicators-<id>.json"

# Markdown table output
node ./scripts/calc.mjs ohlcv.json result.md --indicators=sma,rsi,macd --format=markdown

# List all supported indicators
node ./scripts/calc.mjs --list
```

> Resolve `./scripts/*` to absolute paths using this SKILL.md's directory (shown in system prompt `available_skills`).
> Use absolute paths for input/output files. Write output to session task dir.

## Dependencies
Pre-installed in `<hogagent_root>/node_modules/`: `fast-technical-indicators`, `markdown-table`

The official HogAgent package includes these dependencies. Before using a source checkout or an independently copied Skill, install its declared runtime dependencies with `npm install --omit=dev --prefix '<skill_dir>'`. A `package.json` declaration alone does not install the modules.

## Execution safety

Market-data inputs are limited to 100 MiB, custom parameter files to 10 MiB, and records to 1,000,000. Empty/non-finite numeric values, invalid OHLC relationships, negative volume, nested indicator parameters, and unsafe periods are rejected. Serialized output atomically replaces the target only after a complete calculation.
