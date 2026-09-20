# HogAgent FinanceGym

[Final report](REPORT.md) · [20 questions and answer reports](QUESTIONS.md) · [Questions JSONL](questions.jsonl) · [Answers JSONL](answers.jsonl)

## Test conditions

| Item | Configuration |
|---|---|
| Test model | `qwen3.8-flash` |
| HogAgent version | 1.2.4 |
| Conversation mode | `standard` for all questions |
| Workspace | Dedicated evaluation workspace |
| Benchmark | Rujun/FinanceGym financial deep-research benchmark |
| Scope | A fixed sample of 20 out of 400 questions, preserving the original question, task_id, and cutoff |
| Sampling rule | Compute SHA-256 for `hogagent-financegym-2026-09-19:<task_id>`, sort in ascending order, and select the first 20 questions |
| Execution | Native HogAgent JSONL RPC, with a separate session and task for each question and at most 2 concurrent tasks |
| Time budget | 12 minutes per question |
| Preferred financial data skills | `hog-finnhub`, `hog-openbb` |
| Web retrieval tools | `web_search`, `web_fetch` |
| Calculation tools | `math_calc`; `fin-calc` and `company-valuation` are configured for questions 1 and 9–20 |
| Retrieval budget | At most 6 financial data skill calls and 8 web searches per question, with up to 6 results per search |

## Answer requirements

- Use only information publicly available by each question's cutoff. Distinguish established facts, inferences, and scenario assumptions.
- Prioritize financial data skills and supplement the evidence with web retrieval. Cite verifiable sources and publication dates.
- Answer the question directly and analyze key drivers, counterevidence, risks, and evidence gaps.
- State calculation inputs, units, time periods, and assumptions. Do not treat missing data as zero.
- Submit one English research report of 800–1400 words per question.
- Official scoring normalizes each question's rubric scores, rated from 0 to 4, and then takes the macro-average. The maximum score for 20 questions is 100. See the [final report](REPORT.md) for grading status.

## Sources

- HogAgent website: [ciweiai.com/hogagent.html](https://ciweiai.com/hogagent.html)
- Financial data sources and tools: [Hedgehog Skills](https://github.com/hedgehog-finance/hedgehog-skills/)
- Benchmark and dataset: [FinanceGym](https://financegym.github.io/) · [Rujun/FinanceGym](https://huggingface.co/datasets/Rujun/FinanceGym)

The questions form a 20-question subset of the official public dataset. Original question text is unchanged; short titles are provided for navigation. The dataset is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/); see the [dataset license](DATASET-LICENSE.txt).
