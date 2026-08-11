// ============================================================
// L0 评测 runner · 检索对比实验（P0 最小闭环）
//
// 用法（需真实环境：MILVUS_ADDRESS / QWEN_API_KEY 已配置，知识库有数据）：
//   npx ts-node eval/runners/run-retrieval-eval.ts \
//     --dataset eval/datasets/retrieval-2026-08-11.jsonl \
//     --userId <userId> [--confidence] [--out report.json]
//
// 对每条评测样本：
//   - hybridSearch(limit=3/5/20)   → 混合检索（RRF 融合，当前线上默认）
//   - preciseSearch(topK=3/5/20)   → Rerank 精排（qwen3-rerank 或 RRF 降级近似）
// 计算 Recall@k / Precision@k / MRR / nDCG@5 / HitRate@3 并输出对比报告。
// --confidence 时额外跑 ConfidenceAgent 自评测：fail 召回率 / pass 误杀率。
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { FileanagementService } from '../../src/fileanagement/fileanagement.service';
import { ConfidenceAgent } from '../../src/chat/agents/confidence-agent';
import { runRetrievalEval, RetrievalMetrics } from '../metrics/retrieval-metrics';

// 独立脚本：手动加载 nest-serve/.env（Nest ConfigModule 才会自动加载）
loadEnv();

interface RetrievalSample {
    qid: string;
    query: string;
    relevant_chunks: string[];
    intent?: string;
    has_basis?: boolean;
}

interface ParsedArgs {
    dataset: string;
    userId: string;
    withConfidence: boolean;
    out?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const get = (k: string) => {
        const i = argv.indexOf(k);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dataset = get('--dataset');
    const userId = get('--userId');
    if (!dataset || !userId) {
        console.error('用法: --dataset <jsonl> --userId <userId> [--confidence] [--out report.json]');
        process.exit(1);
    }
    return { dataset, userId, withConfidence: argv.includes('--confidence'), out: get('--out') };
}

function readDataset(path: string): RetrievalSample[] {
    return readFileSync(path, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

/**
 * 结果与相关标注的匹配：
 * - relevant_chunks 里的值等于结果 docId → 文件级匹配；
 * - relevant_chunks 里的值（>=4 字符）出现在 docText 中 → chunk 级文本匹配。
 * 空 relevant_chunks = 库外问题，永不匹配。
 */
function isMatch(result: { docId?: string; docText?: string }, relevant: string[]): boolean {
    if (!relevant.length) return false;
    return relevant.some(
        (r) => r === result?.docId || (r.length >= 4 && !!result?.docText && result.docText.includes(r)),
    );
}

function toRankedIds(results: Array<{ docId?: string; docText?: string }>, relevant: string[]): string[] {
    // 命中 → 映射为相关标注原值（指标函数按 id 相等对齐）；未命中 → miss: 前缀占位
    return results.map((r) => {
        const hit = relevant.find(
            (rel) => rel === r?.docId || (rel.length >= 4 && !!r?.docText && r.docText.includes(rel)),
        );
        return hit ?? `miss:${r?.docId ?? 'x'}`;
    });
}

function toRelevantIds(relevant: string[]): string[] {
    return [...new Set(relevant.filter((r) => r))];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const samples = readDataset(args.dataset);
    console.log(`[eval] 载入 ${samples.length} 条样本: ${args.dataset}`);

    // 手工实例化 FileanagementService（只依赖 ConfigService；评测不触碰 model）
    const service = new FileanagementService({} as never, new ConfigService());
    const confidence = args.withConfidence ? new ConfidenceAgent() : null;

    // Rerank 连通性探测：preciseSearch 内部 rerank 失败会静默降级回 RRF 近似分，
    // 报告里显式标记，避免把降级结果误当真实 rerank 结论。
    let rerankProbe: { ok: boolean; detail: string } = { ok: false, detail: '未探测' };
    if (samples[0]) {
        try {
            const probe = await service.rerank(samples[0].query, ['探测片段 A', '探测片段 B'], 2);
            rerankProbe = probe && probe.length
                ? { ok: true, detail: `真实 rerank 生效，top score=${probe[0].score.toFixed(3)}` }
                : { ok: false, detail: 'rerank 返回 null —— 正在降级回 RRF 近似分' };
        } catch (e: any) {
            rerankProbe = { ok: false, detail: `rerank 探测异常: ${e?.message}` };
        }
        console.log(`[eval] Rerank 连通性: ${rerankProbe.ok ? 'OK' : '降级中'} — ${rerankProbe.detail}`);
    }

    const hybridRuns = { k3: [] as any[], k5: [] as any[], k20: [] as any[] };
    const preciseRuns = { k3: [] as any[], k5: [] as any[], k20: [] as any[] };
    const confidenceRows: Array<{ qid: string; has_basis: boolean; check_result: string; overall: number }> = [];

    for (const s of samples) {
        const relevantIds = toRelevantIds(s.relevant_chunks);
        for (const [key, limit] of [['k3', 3], ['k5', 5], ['k20', 20]] as const) {
            const hybrid = await service.hybridSearch(s.query, args.userId, limit);
            const precise = await service.preciseSearch(s.query, args.userId, { topK: limit });
            hybridRuns[key].push({
                qid: s.qid,
                rankedIds: toRankedIds(hybrid.results || [], s.relevant_chunks),
                relevantIds,
                extra: { intent: s.intent ?? '', fromVector: hybrid.fromVector, fromKeyword: hybrid.fromKeyword },
            });
            preciseRuns[key].push({
                qid: s.qid,
                rankedIds: toRankedIds(precise.results, s.relevant_chunks),
                relevantIds,
                extra: {
                    intent: s.intent ?? '',
                    totalCandidates: precise.totalCandidates,
                    aboveThreshold: precise.aboveThreshold,
                    lowConfidence: precise.lowConfidence,
                },
            });
        }
        if (confidence) {
            const precise = await service.preciseSearch(s.query, args.userId, { topK: 3 });
            // 对齐 fail 修复后的生产链路（handleFact）：lowConfidence 兜底 → check() 传空数组
            const confInput = precise.lowConfidence ? [] : precise.results;
            const cr = confidence.check(confInput, s.query);
            confidenceRows.push({ qid: s.qid, has_basis: !!s.has_basis, check_result: cr.check_result, overall: cr.overall_confidence });
        }
    }

    const report: Record<string, unknown> = {
        dataset: args.dataset,
        userId: args.userId,
        ts: new Date().toISOString(),
        rerank_probe: rerankProbe,
    };
    console.log('\n===== 检索对比（avg）=====');
    for (const key of ['k3', 'k5', 'k20'] as const) {
        const h = runRetrievalEval(hybridRuns[key]);
        const p = runRetrievalEval(preciseRuns[key]);
        report[`hybrid_${key}`] = h.avg;
        report[`precise_${key}`] = p.avg;
        console.log(`\n[${key}]`);
        console.log(`  hybridSearch  Recall@3=${h.avg.recall_at_3} Recall@5=${h.avg.recall_at_5} MRR=${h.avg.mrr} nDCG@5=${h.avg.ndcg_at_5}`);
        console.log(`  preciseSearch Recall@3=${p.avg.recall_at_3} Recall@5=${p.avg.recall_at_5} MRR=${p.avg.mrr} nDCG@5=${p.avg.ndcg_at_5}`);
    }

    if (confidence) {
        const failRows = confidenceRows.filter((r) => r.has_basis === false);
        const passRows = confidenceRows.filter((r) => r.has_basis === true);
        const failRecall = failRows.length ? failRows.filter((r) => r.check_result === 'fail').length / failRows.length : NaN;
        const passMiss = passRows.length ? passRows.filter((r) => r.check_result !== 'pass').length / passRows.length : NaN;
        const conf = { fail_recall_rate: round3(failRecall), pass_miss_rate: round3(passMiss), rows: confidenceRows };
        report.confidence_self_eval = conf;
        console.log('\n===== ConfidenceAgent 自评测 =====');
        console.log(`fail 召回率（库外问题被 fail 的比例）: ${round3(failRecall)}`);
        console.log(`pass 误杀率（库内问题未被 pass 的比例）: ${round3(passMiss)}`);
        console.log(`configHash: ${confidence.configHash}`);
    }

    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`\n报告已写入: ${args.out}`);
    }
}

function round3(n: number): number {
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

main().catch((e) => {
    console.error('[eval] 运行失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
