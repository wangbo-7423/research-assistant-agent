# 召回评测：chunk 向量检索 vs QA 问题检索 vs 融合

核心问题：分块策略不变（递归字符 800/100），把「检索匹配单元」从 chunk 本身换成
「每个 chunk 预先用模型生成的多个问题」（检索时问题对问题匹配，命中问题即召回其源 chunk），
哪种召回更合适？

> 注意：溯源改造后生产切分改为「按论文一级章节断开」（`app/file_management/structure.py`），
> 下表是整篇递归切分时代的基线，chunk 边界与当前代码不再一致。绝对数值仍可用于方法论对比，
> 但重跑评测需要按文末流程重新执行 ingest → dump → gen_qa_index → gen_eval_queries。

## v2 实验设置（多文档大语料，当前结论以此为准）

| 项 | 值 |
|---|---|
| 语料 | **10 篇经典论文**（RAG / Attention / Illustrated Transformer / BERT / GPT-3 / GPT-4 / InstructGPT / ResNet / GAN / ViT），生产解析+切片后共 **1523 chunk**（`docs/` → `eval/scripts/ingest_corpus.py` 入库 `_evalcorpus`） |
| QA 索引 | 每个 chunk 用 `deepseek-flash` 生成 5~6 个索引问题，共 **8644** 条，通义 `text-embedding-v3`（1024 维）向量化 |
| 测试查询 | 每个 chunk 用 **`deepseek-v4-pro`**（与索引生成不同模型）生成 2 条用户口语化问题，共 **3046** 条 |
| 金标 | 每条查询的源 chunk；同时报告**文档级召回 DocRecall@k**（top-k 出现源文档任一 chunk 即命中，抗金标噪声） |
| 生产参数 | RRF k=60，向量 0.7 / 关键词 0.3，最终 Top5 送入生成 |

### 偏差控制

1. **生成器隔离**：索引问题（flash，术语密集）与测试查询（v4-pro，口语化、禁止照抄原文）
   由不同模型独立生成，避免「自己问自己」；
2. **残余偏差**：测试查询仍从同一 chunk 生成，分布偏向「问题对问题」，QA 路成绩解读要打折；
3. **多文档干扰**：10 篇论文混在一个集合里，同名概念（如 GPT-3/GPT-4 都讲 few-shot、
   BERT/GPT 都讲预训练）构成真实干扰源，比 v1 单文档严格得多；
4. **数据完整性**：v1 曾因 Milvus 大 limit 拉取向量列跨 segment 错位导致 chunk 向量臂结果作废
   （自相似 0.55 而非 1.0）。v2 的 dump 改为分页拉取标量字段 + 双页大小互验 + 向量按文本重算，
   保证 chunks ↔ vectors 按构造对齐。

## 结果（3046 条查询，chunk 级金标）

| 检索臂 | Recall@1 | Recall@3 | Recall@5 | DocRecall@5 | MRR@5 | macro-Recall@5 |
|---|---|---|---|---|---|---|
| A chunk_vec（纯向量，query↔chunk） | 39.4% | 60.0% | 66.6% | 96.2% | 0.511 | 67.5% |
| B qa（query↔索引问题→chunk） | 45.7% | 66.1% | 73.2% | 97.5% | 0.573 | 75.7% |
| **C chunk+qa（A+B RRF 融合）** | **45.8%** | **68.5%** | **77.6%** | **97.7%** | **0.594** | **79.5%** |
| D prod_hybrid（向量+关键词，生产现状） | 37.2% | 59.0% | 67.5% | 96.3% | 0.501 | 68.4% |
| E prod+qa（D+B 融合） | 45.7% | 68.9% | 77.1% | 97.7% | 0.594 | 78.8% |

### 按论文分组（Recall@5，验证跨文档稳健性）

| 论文 | n | A | B | C | D |
|---|---|---|---|---|---|
| Attention Is All You Need | 114 | .605 | **.798** | .763 | .614 |
| BERT | 186 | .688 | .790 | **.849** | .694 |
| ResNet | 170 | .694 | .806 | **.829** | .694 |
| GPT-3 | 656 | .651 | .726 | **.787** | .671 |
| GPT-4 | 822 | .670 | .706 | **.740** | .670 |
| GAN | 82 | .720 | .793 | **.854** | .720 |
| InstructGPT | 526 | .663 | .703 | **.768** | .673 |
| RAG | 202 | .678 | .728 | .757 | **.708** |
| Illustrated Transformer | 92 | .783 | .804 | **.848** | .783 |
| ViT | 196 | .602 | .719 | **.755** | .617 |

**B 在 10/10 篇上优于 A，C 在 9/10 篇上是该论文最优**（唯一例外 Attention：B 单独最优），
结论不依赖特定论文。

## v1 → v2 对比（规模影响）

| 臂 | v1（1 篇 204 chunk，408 查询）R@5 | v2（10 篇 1523 chunk，3046 查询）R@5 |
|---|---|---|
| A chunk_vec | 74.5% | 66.6% |
| B qa | 80.1% | 73.2% |
| C chunk+qa | 80.6% | 77.6% |

语料扩大 7.5 倍后所有臂的绝对值都下降（干扰变多，符合预期），**但排序完全不变**：
B > A、C > B 的差距稳定在 6~11pt。v1 的方向性结论在更大规模上成立。

## 结论

1. **QA 问题检索稳定优于 chunk 直接检索**（Recall@5 +6.6pt，Recall@1 +6.3pt），
   优势来源是把「用户问法 ↔ 论文书面语」的鸿沟转移到离线阶段由模型弥合；
2. **双路融合（chunk 向量 + QA 问题向量，RRF 0.5/0.5）是最终推荐**：
   全场最高 Recall@5 77.6% / MRR 0.594，且文档级召回 97.7% 基本饱和；
3. **关键词路价值有限**：D 比 A 只高 0.9pt（DeepSeek 提词 + LIKE 匹配在口语查询下基本失效），
   落地时应把它的算力份额让给 QA 问题路；
4. **落地建议**：上传时离线为每个 chunk 生成 5~6 个索引问题（1 次 LLM + 5~6 次 embedding/chunk），
   在线检索改为「query→chunk 向量」+「query→问题向量→映射 chunk」双路 RRF。

## 失败归因：排序问题 vs 覆盖问题

召回率只能说明「金标有没有进 top-k」，不能区分「没排上来」和「库里根本没有」。
`attribute_failures.py` 用当前生产切分重建语料，并生成两类查询：

- **正文查询**：从随机 chunk 生成用户问题，金标=源 chunk；
- **图表查询**：从 `Table/Figure` 标题生成必须依赖图表内容的问题，金标=图注所在 chunk；

再用生产同款「向量 + 关键词 RRF（0.7/0.3）」检索 top5，对失败样本让 LLM 判断
「答案是否在检索片段/金标片段里」，输出排序失败与覆盖缺口（表格/图片/公式/正文）的分布。

```bash
python eval/scripts/attribute_failures.py            # 首次会解析 docs 并向量化
python eval/scripts/attribute_failures.py --rebuild  # 重新解析论文、重新生成查询
```

首次试验（14 篇论文 / 2181 chunk / 188 条查询）：

| 指标 | 正文查询（140） | 图表查询（48） |
|---|---|---|
| Recall@5 | 72.9% | 58.3% |
| 可答率（top5 中含答案，success+recovered） | 85.0% | 70.8% |

失败 35 条：排序失败 19（54%）、覆盖缺口 16（46%，其中 figure 12、table 4）。
结论：**两者接近**。表格数值常被 pypdf 抽成纯文本，48 条图表查询里 34 条可由检索到的
文本片段回答（含图注所在 chunk 本身），表格结构化的收益主要在准确率与可读性；
真正的硬缺口是图（曲线/示意图，12 条），需要版面分析或视觉模型。报告见
`reports/failure_attribution.md`，原始样本见 `data/failure_attribution.json`。

注意：查询由模型从 chunk/图注生成，不是真实用户分布；归因由 LLM 判断、未经人工复核，
适合做方向性判断，不适合当精确指标。

## QA 问题索引 × 聚合方式（补充实验）

`run_qa_rerank_eval.py` 在 1563 chunk / 8644 个索引问题 / 3046 条查询上，
把「问题对问题」策略拆成 9 组对照（候选深度 20，reranker 未启用）：

| 实验臂 | Recall@1 | Recall@5 | MRR@5 | ΔRecall@5 vs A |
|---|---|---|---|---|
| A chunk 向量 | 39.3% | 66.5% | 0.515 | — |
| B1 QA max | 45.6% | 73.0% | 0.562 | +6.5pt |
| B2 QA mean | 28.4% | 53.1% | 0.376 | -13.3pt |
| B3 QA RRF | 45.7% | 73.2% | 0.563 | +6.7pt |
| C1 chunk+QA (max) | 46.1% | 78.7% | 0.598 | +12.2pt |
| **C2 chunk+QA (RRF)** | **46.1%** | **78.8%** | **0.598** | **+12.3pt** |
| D 生产 hybrid | 36.1% | 65.1% | 0.492 | -1.4pt |
| E1 D+QA (max) | 45.9% | 78.5% | 0.596 | +12.0pt |
| E2 D+QA (RRF) | 45.9% | 78.5% | 0.597 | +12.1pt |

结论：

1. **「每个 chunk 生成多个问题」有效**：单路 +6.7pt，和 chunk 向量融合 +12.3pt；
2. **聚合方式很关键**：max 与 RRF 基本等价，mean 会把唯一匹配的问题稀释掉（-19.9pt vs max）；
3. **关键词路没有增量**：D 比 A 还低 1.4pt，D+QA 与 A+QA 持平，说明 QA 路已经覆盖其收益；
4. **rerank 的天花板**：A / D / E1 的 top20 候选召回分别为 81.6% / 84.3% / 91.3%，
   接 reranker 后理论上还有提升空间；本地模型实验暂缓，后续可试 DashScope 的 rerank API。

```bash
python eval/scripts/run_qa_rerank_eval.py --sample 0 --skip-rerank --skip-keyword  # A/B/C 全量
python eval/scripts/run_qa_rerank_eval.py --sample 0 --skip-rerank                # 九组全量（关键词路要调 LLM）
```

明细：`data/qa_rerank_eval_full3046.json`；报告：`reports/qa_rerank_eval_full3046.md`。

> 与旧五臂结果的差异：本次候选深度为 20（旧实验为 10），D 的数值会略低；
> 语料是改造前 1563 chunk（1523 个有 QA 索引），不代表当前 v3 切分下的绝对值。

## 复现

```bash
python eval/scripts/ingest_corpus.py      # docs/ 论文 → 生产链路入库 _evalcorpus
python eval/scripts/dump_chunks.py        # 拉取语料（分页+互验，向量重算保证对齐）
python eval/scripts/gen_qa_index.py       # 生成 QA 索引（支持断点续跑）
python eval/scripts/gen_eval_queries.py   # 生成测试查询（另一模型，防同源偏差）
python eval/scripts/run_recall_eval.py    # 跑五臂对比 + 按论文细分
python eval/scripts/run_qa_rerank_eval.py # QA 索引 × 聚合 × reranker 对照
```

明细：`data/recall_eval_results.json`（含 QA 赢/输样本、按论文细分）；v1 小语料数据存档于
`data/v1_small_204chunks/`。
