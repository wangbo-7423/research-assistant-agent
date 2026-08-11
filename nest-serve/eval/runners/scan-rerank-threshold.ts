// ============================================================
// L0 评测 runner · rerank 阈值联合扫参（设计文档 2.1 落地）
//
// 对 rerank_threshold ∈ {0.5, 0.6, 0.7, 0.75, 0.8, 0.85} 每个值：
//   - 跑 preciseSearch(topK=3, threshold=X) 算 Recall@3 / Precision@3 / MRR / 无命中率 / lowConfidence 率
//   - 同时对每个阈值跑 ConfidenceAgent（默认配置）记录 warn/fail 占比
// 输出：最优阈值应满足「Precision@3 高 + 无命中率不过高 + 置信度 warn/fail 占比可控」。
//
// 用法（需真实环境）：
//   npx ts-node --transpile-only eval/runners/scan-rerank-threshold.ts \
//     --dataset eval/datasets/retrieval-2026-08-11.jsonl --userId <userId> [--out report.json]
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { FileanagementService } from '../../src/fileanagement/fileanagement.service';
import { ConfidenceAgent } from '../../src/chat/agents/confidence-agent';
import { recallAtK, precisionAtK, mrr } from '../metrics/retrieval-metrics';

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

function toRankedIds(results: Array<{ docId?: string; docText?: string }>, relevant: string[]): string[] {
    return results.map((r) => {
        const hit = relevant.find((rel) => rel === r?.docId || (rel.length >= 4 && !!r?.docText && r.docText.includes(rel)));
        return hit ?? `miss:${r?.docId ?? 'x'}`;
    });
}

function round3(n: number): number {
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const samples = readDataset(args.dataset);
    console.log(`[scan] 载入 ${samples.length} 条样本，扫描阈值: ${THRESHOLDS.join(', ')}`);

    const service = new FileanagementService({} as never, new ConfigService());
    const confidence = new ConfidenceAgent();

    const results: any[] = [];
    for (const threshold of THRESHOLDS) {
        let recallSum = 0, precisionSum = 0, mrrSum = 0, noHit = 0, lowConf = 0;
        let warnFail = 0;
        let n = 0;
        for (const s of samples) {
            const precise = await service.preciseSearch(s.query, args.userId, { topK: 3, rerankThreshold: threshold });
            const relIds = [...new Set(s.relevant_chunks.filter((r) => r))];
            const ranked = toRankedIds(precise.results, s.relevant_chunks);
            recallSum += recallAtK(ranked, relIds, 3);
            precisionSum += precisionAtK(ranked, relIds, 3);
            mrrSum += mrr(ranked, relIds);
            if (precise.results.length === 0) noHit++;
            if (precise.lowConfidence) lowConf++;
            const conf = confidence.check(precise.results, s.query);
            if (conf.check_result !== 'pass') warnFail++;
            n++;
        }
        const avg = {
            threshold,
            recall_at_3: round3(recallSum / n),
            precision_at_3: round3(precisionSum / n),
            mrr: round3(mrrSum / n),
            no_hit_rate: round3(noHit / n),
            low_confidence_rate: round3(lowConf / n),
            confidence_warn_fail_rate: round3(warnFail / n),
        };
        results.push(avg);
        console.log(
            `threshold=${threshold}  Recall@3=${avg.recall_at_3}  Precision@3=${avg.precision_at_3}  MRR=${avg.mrr}` +
            `  无命中=${avg.no_hit_rate}  低置信兜底=${avg.low_confidence_rate}  置信度warn/fail=${avg.confidence_warn_fail_rate}`,
        );
    }

    // 排序建议：以 Precision@3 为主目标，同时约束 no_hit_rate ≤ 0.2
    const ranked = [...results].sort(
        (a, b) => b.precision_at_3 - a.precision_at_3 || a.no_hit_rate - b.no_hit_rate,
    );
    const suggestion = ranked.find((r) => r.no_hit_rate <= 0.2) ?? ranked[0];
    console.log(`\n建议阈值: ${suggestion.threshold}（Precision@3=${suggestion.precision_at_3}，无命中率=${suggestion.no_hit_rate}）`);

    const report = {
        dataset: args.dataset,
        userId: args.userId,
        ts: new Date().toISOString(),
        suggestion,
        scan: results,
    };
    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`报告已写入: ${args.out}`);
    }
}

main().catch((e) => {
    console.error('[scan] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
