# 检索失败归因实验报告

## 设置

- 语料：14 篇论文，2181 个 chunk（当前生产切分）
- 检索：向量 + 关键词 RRF（0.7/0.3，k=60），候选 10，取 top5
- 查询：正文 chunk 生成 2 条/块；图表标题生成 1 条/个

## 召回

| 查询类型 | 数量 | Recall@1 | Recall@5 | MRR | 可答率（success+recovered） |
|---|---|---|---|---|---|
| 正文查询 | 140 | 45.0% | 72.9% | 0.555 | 85.0% |
| 图表查询 | 48 | 27.1% | 58.3% | 0.398 | 70.8% |

## 失败归因

| 类型 | 数量 | 说明 |
|---|---|---|
| ranking_miss | 19 | 金标在库，但没进 top5 |
| coverage_* | 16 | 索引里没有回答问题所需内容（figure 12、table 4） |
| 失败合计 | 35 | 不含 success / recovered |
| 归因失败 | 0 | LLM 调用或解析异常 |

## 判定

覆盖缺口 46%、排序问题 54%，两者接近：建议先做成本最低的图注/图片覆盖（覆盖缺口集中在 figure），同时补 BM25/rerank，不建议只做其中一项。

说明：pypdf 会把表格数值抽成纯文本，部分“表格问题”仍能由检索到的文本片段回答（图表查询中 34/48 条属于这种情况，可能是图注所在 chunk 本身，也可能是相邻正文），所以表格的结构化收益主要在准确率与可读性，而不是“从无到有”。本次覆盖缺口最集中的是 figure（12 条），它才是必须靠版面/视觉解析才能补的部分。

## 样例

### ranking_miss
- 「在WSJ数据集上，只用有监督数据训练时，4层Transformer的句法分析F1分数是多少？」
  - 文档：Attention Is All You Need｜章节：Results > English Constituency Parsing｜金标排名：未进 top5
  - 归因：检索片段仅提及Table 4但未给出具体F1数值，金标表格中明确给出4层Transformer在WSJ only设置下F1为91.3。
- 「BERT之前大家一般怎么预训练语言表示啊？有哪些常见的做法？」
  - 文档：BERT｜章节：Related Work｜金标排名：未进 top5
  - 归因：检索片段只提到BERT不用传统从左到右/从右到左语言模型预训练，但没有介绍BERT之前常见的预训练做法；金标片段（Related Work）则明确回顾了此前基于特征的无监督预训练方法（如词嵌入、语言建模目标等）。
- 「为什么加深网络反而会让训练误差变大？按说深层网络至少不会比浅层差吧？」
  - 文档：Deep Residual Learning for Image Recognition｜章节：Introduction｜金标排名：未进 top5
  - 归因：检索片段仅展示退化现象和残差框架，未解释深层网络训练误差变大的原因；金标片段通过恒等映射构造解说明深层网络本不应更差，并指出当前求解器无法找到该解。

### coverage_table
- 「如果不用双向结构，只用从左到右的语言模型来预训练，跟BERT比效果会掉多少？」
  - 文档：BERT｜章节：Ablation Studies｜金标排名：未进 top5
  - 归因：检索片段和金标片段都只描述了LTR & No NSP实验设置，未给出与BERT相比的具体性能下降数值，该数值应在消融实验表格中。
- 「在Codeforces Rating这项上，GPT-4和GPT-3.5各自的估计百分位下限大概是多少？」
  - 文档：GPT-4｜章节：Capabilities｜金标排名：未进 top5
  - 归因：检索片段仅展示图表标题和坐标轴，未给出Codeforces Rating的具体百分位数值；金标片段为表格但未包含Codeforces Rating行，因此均无法回答。
- 「GPT-4在DROP这个数据集上具体比不过哪个模型？它在那项上的分数是多少？」
  - 文档：GPT-4｜章节：Capabilities｜金标排名：2
  - 归因：片段仅说明GPT-4在DROP上未超过SOTA，但未给出具体是哪个模型及其分数，所需数值应在表格中。

### coverage_figure
- 「GPT-4在代码上的表现比小模型强多少？」
  - 文档：GPT-4｜章节：Predictable Scaling > Scaling of Capabilities on HumanEval｜金标排名：未进 top5
  - 归因：检索片段未提供GPT-4与小模型在代码上的具体性能对比数值，金标片段为图注，关键数据在图中，需查看图表才能回答。
- 「34层plain net和18层plain net在训练过程中的训练误差具体差多少，是不是34层的始终更高？」
  - 文档：Deep Residual Learning for Image Recognition｜章节：Experiments > ImageNet Classiﬁcation｜金标排名：1
  - 归因：片段仅定性说明34层plain net训练误差全程更高，但具体差值需从Figure 4的训练误差曲线读取，文本和表格未给出该数值。
- 「图里56层网络的训练误差大概比20层的高多少？测试误差那边差距又是多少？」
  - 文档：Deep Residual Learning for Image Recognition｜章节：Introduction｜金标排名：1
  - 归因：片段仅给出图1的坐标轴与图注，未提供56层与20层网络训练/测试误差的具体数值，需从图中读取曲线差值。
