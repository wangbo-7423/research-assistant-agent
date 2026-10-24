# 图表召回实验：图注 vs 正文引用 vs VLM 描述

## 数据集

- 有裁剪图与 VLM 描述的元素：165 个
- 文字型图（instructions/excerpt/prompt 等）：28 个
- 正文中无引用句的图：30 个
- 查询：{'caption': 165, 'ref': 135, 'visual': 60}

## 结果（ElementRecall@5）

| 实验臂 | 正文引用 | 图注 | 看图提问 |
|---|---|---|---|
| A_caption | 65.2% | 97.6% | 30.0% |
| B_caption_refs | 83.7% | 93.3% | 31.7% |
| C_caption_desc | 57.0% | 89.7% | 73.3% |
| D_all | 83.7% | 90.3% | 71.7% |
| E_B+C_rrf | 63.0% | 89.7% | 46.7% |
| F_A+B+C_rrf | 60.7% | 92.1% | 40.0% |
| G_views_max | 85.2% | 97.6% | 76.7% |
| H_B+C_score | 68.2% | 92.1% | 60.0% |
| I_A+B+C_score | 66.7% | 93.9% | 51.7% |

## 结果（CaptionChunkRecall@5，现有正文 chunk 的间接召回）

| 实验臂 | 正文引用 | 图注 | 看图提问 |
|---|---|---|---|
| A_caption | 34.8% | 52.1% | 30.0% |
| B_caption_refs | 34.8% | 53.3% | 28.3% |
| C_caption_desc | 33.3% | 51.5% | 23.3% |
| D_all | 33.3% | 51.5% | 21.7% |
| E_B+C_rrf | 35.6% | 53.3% | 25.0% |
| F_A+B+C_rrf | 35.6% | 52.7% | 28.3% |
| G_views_max | 32.6% | 49.7% | 23.3% |
| H_B+C_score | 35.6% | 53.3% | 25.0% |
| I_A+B+C_score | 35.6% | 52.7% | 25.0% |

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