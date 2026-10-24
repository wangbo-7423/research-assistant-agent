# 图表召回实验：图注 vs 正文引用 vs VLM 描述

## 数据集

- 有裁剪图与 VLM 描述的元素：126 个
- 文字型图（instructions/excerpt/prompt 等）：9 个
- 正文中无引用句的图：10 个
- 查询：{'caption': 126, 'ref': 116, 'visual': 53}

## 结果（ElementRecall@5）

| 实验臂 | 正文引用 | 图注 | 看图提问 |
|---|---|---|---|
| A_caption | 64.7% | 97.6% | 34.0% |
| B_caption_refs | 83.6% | 92.9% | 32.1% |
| C_caption_desc | 56.0% | 92.1% | 75.5% |
| D_all | 85.3% | 92.9% | 73.6% |
| E_B+C_rrf | 64.7% | 92.1% | 49.1% |
| F_A+B+C_rrf | 62.1% | 93.7% | 41.5% |
| G_views_max | 86.2% | 97.6% | 79.2% |
| H_B+C_score | 69.0% | 93.7% | 64.1% |
| I_A+B+C_score | 66.4% | 95.2% | 54.7% |

## 结果（CaptionChunkRecall@5，现有正文 chunk 的间接召回）

| 实验臂 | 正文引用 | 图注 | 看图提问 |
|---|---|---|---|
| A_caption | 36.2% | 61.1% | 32.1% |
| B_caption_refs | 36.2% | 61.9% | 30.2% |
| C_caption_desc | 35.3% | 61.1% | 24.5% |
| D_all | 35.3% | 61.1% | 22.6% |
| E_B+C_rrf | 37.1% | 61.9% | 26.4% |
| F_A+B+C_rrf | 37.1% | 61.9% | 30.2% |
| G_views_max | 34.5% | 60.3% | 24.5% |
| H_B+C_score | 37.1% | 62.7% | 26.4% |
| I_A+B+C_score | 37.1% | 61.9% | 26.4% |

## 样例

- 「随着训练 tokens 从 0 增加到 300B，验证损失（实线）和训练损失（虚线）之间的差距如何变化？在约 200B tokens 处，模型参数量最大的那条曲线（紫色）的验证损失与训练损失之差大约是多少 nat/token？」
  - 图注：Figure 4.1: GPT-3 Training Curves We measure model performance during training on a deduplicated validationsplit of our 
  - A 未召回 / D 排名：1
- 「在训练初期（横坐标较小区域），BERT_BASE (Masked LM) 和 BERT_BASE (Left-to-Right) 的性能差距是否显著？随着横坐标增大，两者差距如何变化？」
  - 图注：Figure 5: Ablation over number of training steps. Thisshows the MNLI accuracy after ﬁne-tuning, startingfrom model param
  - A 未召回 / D 排名：未进 top5
- 「在上图中，ResNet-110（黑色实线）的层标准差在原始层序下何时首次降至接近0.5以下？」
  - 图注：Figure 7. Standard deviations (std) of layer responses on CIFAR-10. The responses are the outputs of each 3×3 layer, aft
  - A 未召回 / D 排名：2

## 口径与限制

- 查询由模型从引用句/图注/图片生成，不是真实用户分布；
- `visual` 查询由 qwen3-vl-plus 看图生成，和 C/D 的描述同源，存在一定偏置；
- 语料是改造前的 1523 个 QA chunk 对应的 2181 个正文 chunk，不代表当前 v3 切分的绝对值；
- 文字型图（InstructGPT 的 instructions 等）不参与看图查询，但仍参与引用/图注查询。