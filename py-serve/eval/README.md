# 召回评测：chunk 向量检索 vs QA 问题检索 vs 融合

核心问题：分块策略不变（递归字符 800/100），把「检索匹配单元」从 chunk 本身换成
「每个 chunk 预先用模型生成的多个问题」（检索时问题对问题匹配，命中问题即召回其源 chunk），
哪种召回更合适？

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

## 复现

```bash
python eval/scripts/ingest_corpus.py      # docs/ 论文 → 生产链路入库 _evalcorpus
python eval/scripts/dump_chunks.py        # 拉取语料（分页+互验，向量重算保证对齐）
python eval/scripts/gen_qa_index.py       # 生成 QA 索引（支持断点续跑）
python eval/scripts/gen_eval_queries.py   # 生成测试查询（另一模型，防同源偏差）
python eval/scripts/run_recall_eval.py    # 跑五臂对比 + 按论文细分
```

明细：`data/recall_eval_results.json`（含 QA 赢/输样本、按论文细分）；v1 小语料数据存档于
`data/v1_small_204chunks/`。
