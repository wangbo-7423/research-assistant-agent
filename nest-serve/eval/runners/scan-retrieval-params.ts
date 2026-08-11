// ============================================================
// L0 评测 runner · 检索参数联合扫参（P0 优化 · 设计文档 2.1 深水区）
//
// 扫三个维度的组合：RRF 权重(vectorWeight) × rerank 阈值 × topK
// 目标：解决 Precision@3 仅 0.24~0.28 的噪声问题 —— 找出能同时
//      提升 Precision 又不牺牲 Recall 的参数组合。
//
// 性能设计（评测提速）：
//   - 对每个 (query, vectorWeight) 组合只跑一次 hybridSearch + rerank，
//     得到全量候选的真实 rerank 分数；
//   - rerank 阈值 / topK 在本地过滤，零额外 API 调用；
//   - embedding 已由 FileanagementService 内存缓存。
//
// 用法（需真实环境）：
//   npx ts-node --transpile-only eval/runners/scan-retrieval-params.ts \
//     --dataset eval/datasets/retrieval-2026-08-11-large.jsonl \
//     --userId <userId> [--out report.json]
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { FileanagementService } from '../../src/fileanagement/fileanagement.service';
import { recallAtK, precisionAtK, mrr, hitRateAtK } from '../metrics/retrieval-metrics';

loadEnv();

interface Sample {
    qid: string;
    query: string;
    relevant_chunks: string[];
    has_basis?: boolean;
}

interface ParsedArgs {
    dataset: string;
    userId: string;
    out?: string;
}

const VECTOR_WEIGHTS = [0.5, 0.6, 0.7, 0.8, 0.9];
const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8];
const TOP_KS = [2, 3, 5];
const CANDIDATE_LIMIT = 20;

function parseArgs(argv: string[]): ParsedArgs {
    const get = (k: string) => {
        const i = argv.indexOf(k);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dataset = get('--dataset');
    const userId = get('--userId');
    if (!dataset || !userId) {
        console.error('用法: --dataset <jsonl> --userId <userId> [--out report.json]');
        process.exit(1);
    }
    return { dataset, userId, out: get('--out') };
}

function readDataset(path: string): Sample[] {
    return readFileSync(path, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

/** 匹配检索结果与相关标注（docId 精确 或 文本片段包含），返回映射后的 id 列表 */
function toRankedIds(results: Array<{ docId?: string; docText?: string }>, relevant: string[]): string[] {
    return results.map((r) => {
        const hit = relevant.find(
            (rel) => rel === r?.docId || (rel.length >= 4 && !!r?.docText && r.docText.includes(rel)),
        );
        return hit ?? `miss:${r?.docId ?? 'x'}`;
    });
}

function round3(n: number): number {
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const samples = readDataset(args.dataset);
    const kbSamples = samples.filter((s) => s.has_basis !== false);
    console.log(`[scan] 载入 ${kbSamples.length} 条库内样本，扫 ${VECTOR_WEIGHTS.length} 权重 × ${THRESHOLDS.length} 阈值 × ${TOP_KS.length} topK`);

    const service = new FileanagementService({} as never, new ConfigService());

    // 1. 预取：每个 (query, weight) 组合一次检索 + rerank，缓存全量候选
    const cached = new Map<string, Array<{ docId?: string; docText?: string; score: number }>>();
    for (const vw of VECTOR_WEIGHTS) {
        for (const s of kbSamples) {
            const key = `${vw}|${s.qid}`;
            const fused = await service.hybridSearch(s.query, args.userId, CANDIDATE_LIMIT, {
                vectorWeight: vw,
                keywordWeight: 1 - vw,
            });
            const candidates = (fused.results || []).filter((r) => r.docText);
            // rerank 真实打分（失败降级为 rrfScore 归一化，与生产 preciseSearch 一致）
            let scored = candidates.map((c) => ({
                docId: c.docId,
                docText: c.docText,
                score: typeof (c as any).rrfScore === 'number' ? Math.min(1, (c as any).rrfScore) : 0,
            }));
            try {
                const reranked = await service.rerank(
                    s.query,
                    candidates.map((c) => c.docText),
                    candidates.length,
                );
                if (reranked && reranked.length) {
                    scored = reranked
                        .map((r) => {
                            const c = candidates[r.index];
                            return c ? { docId: c.docId, docText: c.docText, score: r.score } : null;
                        })
                        .filter((x): x is NonNullable<typeof x> => x !== null);
                }
            } catch {
                /* rerank 失败沿用候选分 */
            }
            cached.set(key, scored);
        }
        console.log(`[scan] 权重=${vw} 预取完成（${kbSamples.length} 条）`);
    }

    // 2. 本地扫阈值 × topK
    const results: any[] = [];
    for (const vw of VECTOR_WEIGHTS) {
        for (const thr of THRESHOLDS) {
            for (const topK of TOP_KS) {
                let recallSum = 0, precisionSum = 0, mrrSum = 0, hitSum = 0;
                let n = 0;
                for (const s of kbSamples) {
                    const scored = cached.get(`${vw}|${s.qid}`) ?? [];
                    const passed = scored.filter((r) => r.score >= thr).slice(0, topK);
                    const ranked = toRankedIds(passed, s.relevant_chunks);
                    const relIds = [...new Set(s.relevant_chunks.filter((r) => r))];
                    recallSum += recallAtK(ranked, relIds, topK);
                    precisionSum += precisionAtK(ranked, relIds, topK);
                    mrrSum += mrr(ranked, relIds);
                    hitSum += hitRateAtK(ranked, relIds, topK);
                    n++;
                }
                results.push({
                    vector_weight: vw,
                    keyword_weight: round3(1 - vw),
                    rerank_threshold: thr,
                    top_k: topK,
                    recall_at_k: round3(recallSum / n),
                    precision_at_k: round3(precisionSum / n),
                    mrr: round3(mrrSum / n),
                    hit_rate_at_k: round3(hitSum / n),
                });
            }
        }
    }

    // 3. 排序：以 Precision@k 为主目标（噪声最小化），约束 Recall ≥ 0.8
    const ranked = [...results].sort(
        (a, b) => b.precision_at_k - a.precision_at_k || b.recall_at_k - a.recall_at_k,
    );
    const best = ranked.find((r) => r.recall_at_k >= 0.8) ?? ranked[0];

    console.log('\n===== 联合扫参结果（按 Precision@k 排序，约束 Recall≥0.8）=====');
    for (const r of ranked.slice(0, 12)) {
        console.log(
            `vw=${r.vector_weight} kw=${r.keyword_weight} thr=${r.rerank_threshold} topK=${r.top_k}` +
            `  Precision@k=${r.precision_at_k}  Recall@k=${r.recall_at_k}  MRR=${r.mrr}  Hit@k=${r.hit_rate_at_k}`,
        );
    }
    console.log(`\n=== 推荐组合 ===`);
    console.log(
        `vectorWeight=${best.vector_weight} keywordWeight=${best.keyword_weight} rerankThreshold=${best.rerank_threshold} topK=${best.top_k}` +
        `\n  Precision@k=${best.precision_at_k} Recall@k=${best.recall_at_k} MRR=${best.mrr}`,
    );
    console.log('（对比当前生产参数：vectorWeight=0.7 keywordWeight=0.3 rerankThreshold=0.75 topK=3）');

    const report = {
        dataset: args.dataset,
        userId: args.userId,
        ts: new Date().toISOString(),
        current_production: { vectorWeight: 0.7, keywordWeight: 0.3, rerankThreshold: 0.75, topK: 3 },
        best,
        top_results: ranked.slice(0, 30),
        all: results,
    };
    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`\n报告已写入: ${args.out}`);
    }
}

main().catch((e) => {
    console.error('[scan] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
