# Snap-on (NYSE: SNA): Do CFO Aldo Pagliari's Insider Sales "Align" With the C&I Group's Margin–Revenue Divergence?

*Point-in-time research report. Information cutoff: 2025-04-23 (inclusive). Facts below are drawn only from documents published on or before that date.*

## Direct answer

The two facts are **co-temporal but only weakly causal**. Snap-on's Form 4 record shows CFO Aldo John Pagliari executing open-market sales at a roughly quarterly cadence through 2024–early 2025 (25,920 shares, ~$8.11M gross proceeds, average ~$312.88), and each sale cluster is paired *same-day* with option exercises (code "M") at strike prices of $138.03–$144.69 and with tax-withholding dispositions (code "F"). Snap-on's own [FY2024 Form 10-K](https://www.sec.gov/Archives/edgar/data/91440/000009144025000010/sna-20241228.htm) describes the arrangement as a Rule 10b5-1 plan (adopted 2024-10-22, expiring 2026-02-10, 35,000 shares) for "exercises of vested stock options expiring in February 2026, and sales of shares to cover exercise price and estimated tax withholding, **with the retention of the remaining shares**." That is compensation mechanics, not a discretionary forecast of the Commercial & Industrial (C&I) Group.

At the same time, the selling was *price-contingent*: it concentrated into the strongest part of the tape ($343–$350 in December 2024, ~$339 in February 2025), exactly when reported C&I margins were at the top of their disclosed range. So the defensible reading is: the sales do not anticipate the revenue decline, but they do coincide with management's *plan design* choosing monetization over accumulation near a cyclical margin peak — a mild, not a decisive, negative signal.

## Premise calibration (important)

Two elements of the question need correcting against the record:

1. **The revenue decline.** In the [April 17, 2025 Q1 release](https://www.businesswire.com/news/home/20250417414385/en/Snap-on-Announces-First-Quarter-2025-Results), C&I segment sales were **$343.9M vs $359.9M**, i.e. −$16.0M = **−4.45%** ([TradingView segment summary](https://tw.tradingview.com/news/tradingview:bf21e30f5e689:0-snap-on-announces-first-quarter-2025-results) reports −2.9% organic and $5.6M unfavorable currency; **2.9% + 1.6% ≈ 4.5%**, which is the figure in the question). Both are the same fact.
2. **The "record operating margins."** No pre-cutoff document retrieved uses "record" for C&I margins, and **Q1 2025 C&I operating margin was ~15.47%** ($53.2M / $343.9M) versus **15.39%** ($55.4M / $359.9M) a year earlier — essentially flat, +8bp, with operating earnings *down* 4.0% ([Investing.com segment table](https://www.investing.com/news/company-news/snapon-q1-2025-slides-sales-decline-35-eps-falls-81-amid-mixed-segment-results-93CH-3990685)). The margin high is a **FY2024/Q4-2024** fact: segment operating earnings $242.1M, **margin 16.4% vs 15.5% in 2023** (10-K), and **16.7% vs 14.9% (+180bp) in Q4 2024** ([Q4 2024 press release](https://www.snapon.com/Snap-on-Files/Investors/2024-Q4/Q4-2024-Release.pdf), [Q4 slides](https://www.snapon.com/Snap-on-Files/Investors/2024-Q4/Q4-2024-Slides.pdf)). Within Q1 2025, the genuine margin win was **gross margin +180bp to 42.6%**. So the "divergence" is best stated as *record-ish FY2024 margin/quarterly gross-margin expansion* versus *a revenue decline that became visible while margins stayed historically high*.

## Evidence: what the filings show

From the SEC-sourced insider-transactions feed queried via the hog-finnhub CLI ([API window 2024-04-24 → 2025-04-23](https://finnhub.io/api/v1/stock/insider-transactions?symbol=SNA&from=2024-04-24&to=2025-04-23)), Pagliari's open-market ("S") dispositions were:

| Trade date | Shares sold | Price range | Paired option exercise |
|---|---|---|---|
| 2024-05-21 | 5,978 | $276.32–$278.81 | 8,000 @ $144.69 |
| 2024-08-22/23 | 6,173 | $277.67–$282.61 | 6,000 @ $144.69 |
| 2024-12-18 | 6,909 | $343.05–$349.72 | 10,000 @ $144.69 |
| 2025-02-20 | 6,860 | $337.79–$341.51 | 10,000 @ $138.03 |
| **Total** | **25,920** | avg ≈ $312.88 | **34,000 exercised** |

Shares sold were **less than** shares exercised (25,920 < 34,000), and post-transaction beneficial ownership reported on the Form 4s rose from the ~97,700–103,700 range (May 2024) to ~107,096–111,748 (February 2025) — see the [Form 4 filed 2025-02-18](https://snapon.gcs-web.com/static-files/f471f878-f7d2-424a-89ab-e4c8f1c6894f). He also received new option/RSU/performance-unit grants in February 2025. No standalone "pure sell" unaccompanied by an exercise appears in the window, and none occurred inside the 30 days before the April 17 print. Chairman/CEO Nicholas Pinchuk shows the same pattern (~92,848 shares sold on 2024-06-04, 2024-08-12, 2024-12-09 and 2025-03-27, each paired with large exercises at $138–$145 strikes); the March 27, 2025 sale predates the quarter end (2025-03-29).

## Evidence: what the April 2025 disclosure shows

Consolidated Q1 2025: net sales $1,141.1M, −3.5% (organic −2.3%, currency −1.2%); diluted EPS $4.51, −8.1%; operating earnings before financial services $243.1M, −10.3%; gross margin 50.7% vs 50.5%; **operating expenses 29.4% of sales vs 27.6%**; total operating margin 25.2% vs 26.5%. Segments: Tools −7.4% with margin 20.0% vs 23.5%; Repair Systems & Information +2.6% with margin 25.7% vs 24.3%; Financial Services revenue +2.5% but **originations −10.9%** to $268.7M. Balance sheet: cash $1,434.9M, net debt −$231.0M (−4.4% of capital), operating cash flow $298.5M vs $348.7M, DSO 66 vs 62 days. CEO Pinchuk attributed the quarter to "heightened macroeconomic uncertainty" and customers' "reluctance to purchase financed products" ([MDM](https://www.mdm.com/news/operations/earnings/snap-on-says-pullback-from-economic-uncertainty-drove-1q-sales-decline)); shares traded −5.21% at $314.70 premarket on April 17. For context, the company had returned capital aggressively in 2024: 952,000 shares repurchased for $290.0M and $406.4M of dividends ([TradingView 10-K summary](https://www.tradingview.com/news/tradingview:cb035260d4d73:0-snap-on-inc-sec-10-k-report)).

## Mechanisms: how the divergence arises, and why the sales happen

*Margin without revenue* is arithmetically normal late-cycle: RCI cost reduction, lower material costs, mix shift toward higher-margin custom-engineered/critical-industry solutions and intersegment sales (C&I booked $312.7M of intersegment sales in 2024), plus price realization — all lift gross margin, while fixed selling costs deleverage as volume falls (Q1 2025 opex +180bp as a % of sales), which is exactly why C&I's gross-margin gain of 180bp translated into only ~8bp of operating margin. *Insider selling* here is driven by an unrelated calendar: options that expire each February, exercise strikes ~2.5x below market, and the cash needed for the exercise price and withholding. The mechanical driver, not information, explains the timing; the **price level** explains why the plans were sized the way they were.

## Counterarguments and scenarios

Against a bearish read: (i) plan-based selling was disclosed in advance in both the FY2023 ([10-K](https://www.snapon.com/Snap-on-Files/Investors/2023-Q4/Q4202310-K.pdf), 34,000 shares) and FY2024 10-Ks (35,000 shares); (ii) the CFO's share count rose while he sold; (iii) sales began in May 2024, when C&I margins were already expanding, so nothing about the pattern is unique to the deterioration. For a cautious read: (i) monetizing ~76% of exercised shares at all-time-high prices, weeks before a −4.5% C&I quarter and a 10.9% drop in financing originations, is at least consistent with viewing reported margins as cyclical peaks; (ii) a record *gross* margin on falling volume is a classic setup for operating deleverage.

Scenarios (analysis, not forecast): **(1) Margin persistence** — C&I holds ~16% operating margin as critical-industry/military-adjacent programs (a decline factor cited by secondary coverage of the quarter, [SmartStockWatch](https://www.youtube.com/watch?v=8KNbV8TeUCU)) stabilize; insider sales prove noise. **(2) Deleverage** — organic declines deepen (Tools −6.8% already), fixed costs and 66-day receivables compress operating margin toward 14–15%, reviving the 2023-level profitability. **(3) Macro/tariff-driven demand deferral** — the "pullback" reverses, and Q1's FX drag (−1.5% for C&I) simply disappears with the dollar. Which scenario plays out is undeterminable from pre-cutoff evidence.

## Gaps and limitations

The Q1 2025 Form 10-Q text was not retrieved, so segment margins are computed from press-release/slide figures rather than quoted from the filing. The Finnhub insider feed is filing-date indexed, capped at 366 days per call and subscription-limited, so pre-May-2024 history and any amendment detail are unverified; "S"/"M" codes are as reported by SEC filings and were not re-derived from the underlying Form 4 exhibits for every date. No OpenBB data was used; none was material, and index/yield observations would be retrospective rather than frozen publication vintages. Statements about *intent* are inference from disclosed plan mechanics, not from any management assertion.

## Sources (with publication dates)

- Snap-on Announces First Quarter 2025 Results — Business Wire, 2025-04-17 — https://www.businesswire.com/news/home/20250417414385/en/Snap-on-Announces-First-Quarter-2025-Results
- TradingView News, "Snap-on Announces First Quarter 2025 Results" (segment summary), 2025-04-17 — https://tw.tradingview.com/news/tradingview:bf21e30f5e689:0-snap-on-announces-first-quarter-2025-results
- Investing.com, "Snap-on Q1 2025 slides: Sales decline 3.5%…", 2025-04-17 — https://www.investing.com/news/company-news/snapon-q1-2025-slides-sales-decline-35-eps-falls-81-amid-mixed-segment-results-93CH-3990685
- Modern Distribution Management, "Snap-on Says Pullback from Economic Uncertainty Drove 1Q Sales Decline", 2025-04-17 — https://www.mdm.com/news/operations/earnings/snap-on-says-pullback-from-economic-uncertainty-drove-1q-sales-decline
- SmartStockWatch, "Snap-on (SNA) 2025 Q1 Earnings Analysis" (secondary, low reliability), 2025-04-17 — https://www.youtube.com/watch?v=8KNbV8TeUCU
- Snap-on FY2024 Form 10-K (sna-20241228), 2025-02-13 — https://www.sec.gov/Archives/edgar/data/91440/000009144025000010/sna-20241228.htm
- Form 4, Pagliari Aldo John, filed 2025-02-18 — https://snapon.gcs-web.com/static-files/f471f878-f7d2-424a-89ab-e4c8f1c6894f
- Snap-on Q4 2024 Press Release, 2025-02-06 — https://www.snapon.com/Snap-on-Files/Investors/2024-Q4/Q4-2024-Release.pdf
- Snap-on Q4-2024 Quarterly Review slides, 2025-02-06 — https://www.snapon.com/Snap-on-Files/Investors/2024-Q4/Q4-2024-Slides.pdf
- TradingView News, "Snap-on Inc SEC 10-K Report", 2025-02-13 — https://www.tradingview.com/news/tradingview:cb035260d4d73:0-snap-on-inc-sec-10-k-report
- Snap-on FY2023 Form 10-K, 2024-02-15 — https://www.snapon.com/Snap-on-Files/Investors/2023-Q4/Q4202310-K.pdf
- Snap-on Q3 2024 Form 10-Q, 2024-10-17 — https://www.snapon.com/Snap-on-Files/Investors/2024-Q3/Q3-2024-10-Q.pdf
- hog-finnhub `getInsiderTransactions` (SEC source), window 2024-04-24 → 2025-04-23 — https://finnhub.io/api/v1/stock/insider-transactions?symbol=SNA&from=2024-04-24&to=2025-04-23

*All figures computed with the task calculator; percentages derived from the dollar amounts cited above. This report is research and analysis of historical filings only; it is not investment advice or a recommendation.*
