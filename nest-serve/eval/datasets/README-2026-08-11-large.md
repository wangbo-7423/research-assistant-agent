# 评测集说明：retrieval-2026-08-11-large.jsonl（100 条）

## 构成
- 库内 85 条（has_basis=true）：从用户 `6a62f8b81fee7cc0d9799323` 知识库
  （2 篇论文：Attention Is All You Need / RAG 论文，159 chunk）按 docId 均衡抽样，
  LLM 反向生成问题，relevant_chunks 为文件级 docId 标注。
- 库外 15 条（has_basis=false）：预置主题问题，relevant_chunks 为空。

## intent 标注校对结论（2026-08-11 · audit-intent-labels 交叉校验）
- 100 条中 83 条与路由器判定一致（83%），17 条冲突。
- **17 条冲突逐条人工复核结论：评测集标注基本正确**，冲突分两类：
  1. **15 条：路由器触发词表缺词（非标注错误）**
     LLM 标 perspective，路由器判 fact，但 query 语义确属评价类
     （challenges / advantages / benefits / downsides / differences / 为什么 / 局限性 / 相比）。
     例：[r006] "challenges of English constituency parsing"、[r085] "主要局限性是什么"。
     → 修复方向：perspective-analyzer.skill.md 触发词表补词（涉及生产行为，需评审）。
  2. **2 条：造集脚本硬编码问题（非语义标注）**
     库外样本 intent 被脚本硬编码为 fact（如 [o014] "评价指标体系" 实为 perspective）。
     → run-intent-eval.ts 已改为排除 has_basis=false 样本，不再污染路由混淆矩阵。

## 使用方法
- 路由评测：`npx ts-node --transpile-only eval/runners/run-intent-eval.ts --dataset eval/datasets/retrieval-2026-08-11-large.jsonl`
- 检索对比：`npm run eval:retrieval -- --dataset eval/datasets/retrieval-2026-08-11-large.jsonl --userId 6a62f8b81fee7cc0d9799323 --confidence`
- 阈值扫参：`npx ts-node --transpile-only eval/runners/scan-rerank-threshold.ts --dataset eval/datasets/retrieval-2026-08-11-large.jsonl --userId 6a62f8b81fee7cc0d9799323`

## 已知局限
- 知识库仅 2 篇论文，库内问题全部来自这两个主题，主题多样性受限；
  后续接入更多文档后需重建评测集（脚本与流程可复用）。
