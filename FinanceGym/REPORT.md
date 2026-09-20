# HogAgent FinanceGym: 20-Question Evaluation Report

The test model is **qwen3.8-flash**, using **standard** mode for all 20 questions. See the [test conditions and requirements](README.md) for configuration details.

## Results

| Metric | Result |
|---|---:|
| Questions evaluated | 20 |
| Answer reports | 20 |
| Completed | 18 / 20 |
| Timed out | 2 / 20 |
| Average time per question | 9.92 minutes |
| Reports meeting the 800–1400-word requirement | 10 / 20 |
| Official quality score (maximum 100) | N/A, not graded |

“Completed” means the task finished within the time budget. It does not establish answer correctness or compliance with official quality standards. Answer reports are also available for the two timed-out questions.

## Grading status

The official formula is `Overall score = 100 × mean normalized score across the 20 questions`, where `Normalized question score = sum of rubric item scores / (4 × number of rubric items)`. Both the 20-question sample and the full 400-question benchmark have a maximum score of 100. This report covers 20 questions. [Official grading guidance](https://huggingface.co/datasets/Rujun/FinanceGym#how-submissions-are-graded)

The official question-specific rubrics are not public, and no official score is available. Question 13 contains information leakage beyond its cutoff. Under the official point-in-time (PIT) rule, this evaluation fails the local validity check and is ineligible for a valid score. This is a local assessment, not a decision issued by the benchmark maintainers. [Official paper, §3.3](https://arxiv.org/pdf/2607.27853)

## Questions and answer reports

| # | Question | Information cutoff | Execution result | Time (minutes) | Words | Report |
|---|---|---|---|---:|---:|---|
| 1 | [Chewy: Executive Selling and Customer Growth](QUESTIONS.md#q01) | 2025-04-28 | Timed out | 12.00 | 1408 | [Answer report](reports/01-chewy.md) |
| 2 | [Edison: Capital Flows and Wildfire Liabilities](QUESTIONS.md#q02) | 2025-05-27 | Completed | 9.75 | 1378 | [Answer report](reports/02-edison.md) |
| 3 | [Caesars: Digital Business and Las Vegas Revenue](QUESTIONS.md#q03) | 2025-05-21 | Completed | 10.73 | 1610 | [Answer report](reports/03-caesars.md) |
| 4 | [NIO: Multiple Brands and International Distribution](QUESTIONS.md#q04) | 2025-06-29 | Completed | 6.20 | 1375 | [Answer report](reports/04-nio.md) |
| 5 | [AppLovin: Excess Returns and Fundamentals](QUESTIONS.md#q05) | 2025-07-09 | Timed out | 12.00 | 1704 | [Answer report](reports/05-applovin.md) |
| 6 | [Rivian: Positive Gross Margins and the Path to Profitability](QUESTIONS.md#q06) | 2025-05-27 | Completed | 9.03 | 1193 | [Answer report](reports/06-rivian.md) |
| 7 | [Zebra: Earnings, Leverage, and Price Target Cuts](QUESTIONS.md#q07) | 2025-06-10 | Completed | 9.78 | 1407 | [Answer report](reports/07-zebra.md) |
| 8 | [U.S. Agricultural Processing: Soybean and Beef Prices](QUESTIONS.md#q08) | 2025-09-02 | Completed | 10.93 | 1512 | [Answer report](reports/08-us-agriculture.md) |
| 9 | [Barrick: Mining Taxes and Operational Risks in Mali](QUESTIONS.md#q09) | 2025-04-28 | Completed | 9.87 | 1432 | [Answer report](reports/09-barrick.md) |
| 10 | [PTTEP: Asset Portfolio Changes and Production Targets](QUESTIONS.md#q10) | 2025-07-21 | Completed | 11.60 | 1643 | [Answer report](reports/10-pttep.md) |
| 11 | [North American Soybeans: Inventories, Exports, and Chinese Demand](QUESTIONS.md#q11) | 2025-11-04 | Completed | 9.11 | 1400 | [Answer report](reports/11-north-american-soybeans.md) |
| 12 | [United Therapeutics: Competition and Label Expansion](QUESTIONS.md#q12) | 2025-08-05 | Completed | 8.82 | 1303 | [Answer report](reports/12-united-therapeutics.md) |
| 13 | [U.S. Retail: Diverging Trends in Discretionary and Essential Spending](QUESTIONS.md#q13) | 2025-07-21 | Completed | 9.45 | 1491 | [Answer report](reports/13-us-retail.md) |
| 14 | [Mercedes-Benz: North American Capacity, Costs, and Tariffs](QUESTIONS.md#q14) | 2025-08-05 | Completed | 7.82 | 1395 | [Answer report](reports/14-mercedes-benz.md) |
| 15 | [Aon: The NFP Acquisition, Synergies, and Debt](QUESTIONS.md#q15) | 2025-04-23 | Completed | 10.60 | 1496 | [Answer report](reports/15-aon.md) |
| 16 | [Snap-on: Executive Selling and Segment Profitability](QUESTIONS.md#q16) | 2025-04-23 | Completed | 11.26 | 1375 | [Answer report](reports/16-snap-on.md) |
| 17 | [SolarWinds: Take-Private Valuation and Capital Flows](QUESTIONS.md#q17) | 2025-04-23 | Completed | 10.83 | 1386 | [Answer report](reports/17-solarwinds.md) |
| 18 | [Amcor: Acquisition Financing and Combined Leverage](QUESTIONS.md#q18) | 2025-03-16 | Completed | 11.53 | 1735 | [Answer report](reports/18-amcor.md) |
| 19 | [ICON: Institutional Holdings and Valuation Sentiment](QUESTIONS.md#q19) | 2025-07-21 | Completed | 9.96 | 1209 | [Answer report](reports/19-icon.md) |
| 20 | [United Airlines: Regulation, Unit Revenue, and Fleet Strategy](QUESTIONS.md#q20) | 2025-02-19 | Completed | 7.22 | 1394 | [Answer report](reports/20-united-airlines.md) |

[Full text of all 20 questions](QUESTIONS.md) · [Questions JSONL](questions.jsonl) · [Answers JSONL](answers.jsonl)
