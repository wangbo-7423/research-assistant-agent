// ============================================================
// 置信度模块阈值校准脚本（P1 · 设计文档 2.4 落地）
//
// 对评测集每条 query 跑一次 preciseSearch，然后用多个
// ConfidenceConfig 分别判定，量化最优阈值：
//   - fail 召回率（库外问题被 fail 的比例）应尽量高
//   - pass 误杀率（库内问题未被 pass 的比例）应尽量低
// 同时检查低分 Top1 兜底对 fail 判定的影响。
//
// 用法：
//   npx ts-node --transpile-only eval/runners/calibrate-confidence.ts \
//     --dataset eval/datasets/retrieval-2026-08-11.jsonl --userId <userId> [--out report.json]
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { FileanagementService } from '../../src/fileanagement/fileanagement.service';
import { ConfidenceAgent, ConfidenceConfig, computeConfigHash } from '../../src/chat/agents/confidence-agent';

loadEnv();

interface Sample {
    qid: string;
    query: string;
    relevant_chunks: string[];
    has_basis?: boolean;
}

interface ScanConfig {
    name: string;
    config: ConfidenceConfig;
}

const SCAN_CONFIGS: ScanConfig[] = [
    { name: '默认(0.8/0.5)', config: {} },
    { name: 'pass降0.7', config: { passThreshold: 0.7 } },
    { name: 'pass降0.65', config: { passThreshold: 0.65 } },
    { name: 'pass降0.6', config: { passThreshold: 0.6 } },
    { name: 'pass降0.55', config: { passThreshold: 0.55 } },
    { name: '单源升0.75', config: { singleSourceReliability: 0.75, singleSourceConsistency: 0.75 } },
    { name: '单源升0.8', config: { singleSourceReliability: 0.8, singleSourceConsistency: 0.8 } },
    { name: '组合(pass0.65+单源0.75)', config: { passThreshold: 0.65, singleSourceReliability: 0.75, singleSourceConsistency: 0.75 } },
];

function parseArgs(argv: string[]): { dataset: string; userId: string; out?: string } {
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

function round3(n: number): number {
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const samples = readDataset(args.dataset);
    console.log(`[calibrate] 载入 ${samples.length} 条样本`);

    const service = new FileanagementService({} as never, new ConfigService());

    // 1. 每条 query 跑一次检索，记录结果 + 检索统计（含低分兜底标记）
    const rows: Array<{ qid: string; has_basis: boolean; results: any[]; lowConfidence: boolean; topScore: number }> = [];
    for (const s of samples) {
        const precise = await service.preciseSearch(s.query, args.userId, { topK: 3 });
        rows.push({
            qid: s.qid,
            has_basis: !!s.has_basis,
            results: precise.results,
            lowConfidence: precise.lowConfidence,
            topScore: precise.results[0]?.score ?? 0,
        });
    }
    console.log(`[calibrate] 检索完成，${rows.length} 条。低分兜底(lowConfidence)命中: ${rows.filter((r) => r.lowConfidence).length} 条`);

    // 2. 每个配置跑一遍判定
    // 注：模拟 fail 链路修复后的生产语义（2026-08-11）：
    //   handleFact 在 hasFactualBasis=false 时向 check() 传空数组（低置信兜底不再喂给 check），
    //   因此这里对 lowConfidence=true 的结果也传空数组，测的是修复后的真实行为。
    console.log('\n===== 阈值扫描（模拟 fail 修复后链路：lowConfidence → 传空数组）=====');
    console.log('配置'.padEnd(26), 'fail召回率', 'pass误杀率', '库内pass数', '库外fail数', 'configHash');
    const results: any[] = [];
    for (const sc of SCAN_CONFIGS) {
        const agent = new ConfidenceAgent(sc.config);
        const checks = rows.map((r) => ({ r, c: agent.check(r.lowConfidence ? [] : r.results, r.qid) }));
        const failRows = checks.filter((x) => !x.r.has_basis);
        const passRows = checks.filter((x) => x.r.has_basis);
        const failRecall = failRows.length ? failRows.filter((x) => x.c.check_result === 'fail').length / failRows.length : NaN;
        const passMiss = passRows.length ? passRows.filter((x) => x.c.check_result !== 'pass').length / passRows.length : NaN;
        const inPass = passRows.filter((x) => x.c.check_result === 'pass').length;
        const outFail = failRows.filter((x) => x.c.check_result === 'fail').length;
        console.log(
            sc.name.padEnd(26),
            round3(failRecall).toFixed(3).padStart(9),
            round3(passMiss).toFixed(3).padStart(10),
            String(inPass).padStart(8),
            String(outFail).padStart(8),
            computeConfigHash(sc.config),
        );
        results.push({
            name: sc.name,
            config: sc.config,
            configHash: computeConfigHash(sc.config),
            fail_recall_rate: round3(failRecall),
            pass_miss_rate: round3(passMiss),
            in_kb_pass_count: inPass,
            out_kb_fail_count: outFail,
        });
    }

    const report = {
        dataset: args.dataset,
        userId: args.userId,
        ts: new Date().toISOString(),
        low_confidence_fallback_count: rows.filter((r) => r.lowConfidence).length,
        total: rows.length,
        scan: results,
    };
    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`\n报告已写入: ${args.out}`);
    }
}

main().catch((e) => {
    console.error('[calibrate] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
