# 召回评测：chunk 向量检索 vs QA 问题检索 vs 融合

核心问题：分块策略不变（递归字符 800/100），把「检索匹配单元」从 chunk 本身换成
「每个 chunk 预先用模型生成的多个问题」（检索时问题对问题匹配，命中问题即召回其源 chunk），
哪种召回更合适？

## 实验设置

| 项 | 值 |
|---|---|
| 语料 | Milvus 真实生产数据：RAG 论文（Lewis et al. 2020）204 个 chunk |
| QA 索引 | 每个 chunk 用 `deepseek-flash` 生成 5~6 个索引问题，共 **1145** 条，通义 `text-embedding-v3`（1024 维）向量化 |
| 测试查询 | 每个 chunk 用 **`deepseek-v4-pro`**（与索引生成不同模型）生成 2 条用户口语化问题，共 **408** 条 |
| 金标 | 每条查询的源 chunk（单一金标），指标为 Recall@k（=HitRate@k）与 MRR@5 |
| 生产参数 | RRF k=60，向量 0.7 / 关键词 0.3，最终 Top5 送入生成 |

### 偏差控制（怎么测才可信）

1. **生成器隔离**：索引问题（flash，术语密集风格）与测试查询（v4-pro，口语化、禁止照抄原文措辞）
   由不同模型、不同提示词独立生成，避免「自己问自己」的同源泄漏；
2. **残余偏差**：测试查询仍然是从同一 chunk 生成出来的，分布上更接近「问题对问题」，
   QA 路的成绩存在被高估的可能，解读结论时要打折；
3. **生产对齐**：向量臂直接使用 Milvus 中已存的 chunk 向量；关键词臂复用生产
   `extract_keywords`（DeepSeek 提词），词面匹配按命中数排序近似 Milvus LIKE 语义。

## 结果（408 条查询）

| 检索臂 | Recall@1 | Recall@3 | Recall@5 | MRR@5 |
|---|---|---|---|---|
| A chunk_vec（纯向量，query↔chunk） | 44.9% | 65.4% | 74.5% | 0.573 |
| B qa（query↔索引问题→chunk） | **51.0%** | **74.5%** | 80.1% | 0.638 |
| C chunk+qa（A+B RRF 融合） | **51.7%** | 73.3% | **80.6%** | **0.645** |
| D prod_hybrid（向量+关键词，生产现状） | 42.2% | 63.5% | 74.3% | 0.560 |
| E prod+qa（D+B RRF 融合） | 51.5% | 72.8% | **80.6%** | 0.644 |

## 结论

1. **QA 问题检索明确优于 chunk 直接检索**：Recall@5 +5.6pt（74.5%→80.1%）、Recall@3 +9.1pt、
   MRR +0.065。典型赢法是口语化/模糊指代的查询（"生成部分用的是啥模型？"），问题对问题
   匹配抹平了「用户问法」与「论文书面语」之间的语义鸿沟。
2. **融合略优于单用 QA**：Recall@5 80.6%、MRR@5 0.645 均为全场最高。QA 输的场景是
   概念对比类问题（"纯参数化模型有啥缺点？"），chunk 向量反而排第 1——两条路互补，
   融合能兜住彼此的盲区。
3. **现有混合检索里关键词路贡献为负**：D 比 A 还低 0.2~2.7pt。DeepSeek 提词质量不差，
   但口语化查询提出来的词与论文用语不一致，LIKE 词面匹配基本失效。
4. **落地建议**：检索链路改为「chunk 向量 + QA 问题向量」双路 RRF 融合，替换或弱化
   关键词路。预生成问题索引的成本：每 chunk 1 次 LLM 调用 + 5~6 次 embedding，
   上传时离线完成即可。

## 复现

```bash
python eval/scripts/dump_chunks.py        # 拉取语料
python eval/scripts/gen_qa_index.py       # 生成 QA 索引（支持断点续跑）
python eval/scripts/gen_eval_queries.py   # 生成测试查询
python eval/scripts/run_recall_eval.py    # 跑五臂对比
```

明细数据在 `data/recall_eval_results.json`（含 QA 赢/输样本清单）。
