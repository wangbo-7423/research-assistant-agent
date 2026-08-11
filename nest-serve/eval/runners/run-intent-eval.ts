// ============================================================
// L0 评测 runner · 路由评测（设计文档 2.2 落地）
//
// 用评测集里带 intent 标注的 query 跑 IntentRouter.classifyIntent，
// 输出：三分类准确率 + 混淆矩阵 + hybrid 触发统计。
//
// 注意：评测集的 intent 是标注时由 LLM 打的（fact/perspective），
// 与路由器的实际判定对比即可得混淆矩阵。clarify 样本需额外构造
// （评测集里一般没有纯模糊输入），本 runner 附带 5 条 clarify 冒烟。
//
// 用法（无真实环境依赖，只读 skill 文件）：
//   npx ts-node --transpile-only eval/runners/run-intent-eval.ts \
//     --dataset eval/datasets/retrieval-2026-08-11.jsonl [--out report.json]
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { IntentRouter } from '../../src/chat/routers/intent-router';
import { SkillLoader } from '../../src/chat/tools/skill-loader';

interface Sample {
    qid: string;
    query: string;
    intent?: string;
    has_basis?: boolean;
}

interface ParsedArgs {
    dataset: string;
    out?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const get = (k: string) => {
        const i = argv.indexOf(k);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dataset = get('--dataset');
    if (!dataset) {
        console.error('用法: --dataset <jsonl> [--out report.json]');
        process.exit(1);
    }
    return { dataset, out: get('--out') };
}

function readDataset(path: string): Sample[] {
    return readFileSync(path, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

/** 附带 clarify 冒烟样本：纯模糊/续问/短确认 */
const CLARIFY_SMOKE: Array<{ query: string; expected: string }> = [
    { query: '这个', expected: 'clarify' },
    { query: '你再说一遍', expected: 'clarify' },
    { query: '什么意思', expected: 'clarify' },
    { query: '有没有更详细的', expected: 'clarify' },
    { query: '嗯', expected: 'clarify' },
];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    // 只评测库内样本：库外问题（has_basis=false）的 intent 是造集脚本硬编码的 fact，
    // 非真实语义标注，计入混淆矩阵会污染路由准确率
    const samples = readDataset(args.dataset).filter((s) => s.intent && s.intent !== '' && s.has_basis !== false);
    console.log(`[intent-eval] 载入 ${samples.length} 条库内带 intent 标注的样本（已排除库外硬编码样本）`);

    // 无参构造：SkillLoader 自动探测 skill 目录；IntentRouter 只依赖 SkillLoader
    // 注意：SkillLoader 无内置生命周期钩子，必须显式 loadAllMetas()（生产由 chat.service 触发）
    const loader = new SkillLoader();
    await loader.loadAllMetas();
    const router = new IntentRouter(loader);

    // 混淆矩阵：行 = 标注（golden），列 = 预测（router）
    const labels = ['fact', 'perspective', 'clarify'] as const;
    const matrix: Record<string, Record<string, number>> = {};
    for (const l of labels) matrix[l] = { fact: 0, perspective: 0, clarify: 0 };

    let correct = 0;
    let hybridCount = 0;
    const perQuery: Array<{ qid: string; query: string; golden: string; predicted: string; confidence: number; hybrid: boolean }> = [];

    for (const s of samples) {
        const golden = (s.intent as string).toLowerCase();
        if (!(golden in matrix)) continue; // 只统计 fact/perspective
        const route = await router.classifyIntent(s.query);
        const predicted = route.intent;
        matrix[golden][predicted]++;
        if (route.hybrid) hybridCount++;
        if (golden === predicted) correct++;
        perQuery.push({
            qid: s.qid,
            query: s.query.slice(0, 40),
            golden,
            predicted,
            confidence: route.confidence,
            hybrid: !!route.hybrid,
        });
    }

    // clarify 冒烟
    let clarifyOk = 0;
    for (const c of CLARIFY_SMOKE) {
        const route = await router.classifyIntent(c.query);
        if (route.intent === c.expected) clarifyOk++;
    }

    console.log('\n===== 混淆矩阵（golden × predicted）=====');
    console.log('         fact      perspective  clarify');
    for (const g of labels) {
        console.log(
            `${g.padEnd(11)} ${String(matrix[g].fact).padStart(5)}    ${String(matrix[g].perspective).padStart(11)}    ${String(matrix[g].clarify).padStart(7)}`,
        );
    }
    const total = samples.filter((s) => (s.intent as string).toLowerCase() in matrix).length;
    const accuracy = total ? correct / total : NaN;
    console.log(`\n三分类准确率: ${round3(accuracy)}（${correct}/${total}）`);
    console.log(`hybrid 触发数: ${hybridCount}`);
    console.log(`clarify 冒烟通过: ${clarifyOk}/${CLARIFY_SMOKE.length}`);

    const report = {
        dataset: args.dataset,
        ts: new Date().toISOString(),
        accuracy: round3(accuracy),
        correct,
        total,
        hybrid_count: hybridCount,
        clarify_smoke: { ok: clarifyOk, total: CLARIFY_SMOKE.length },
        confusion_matrix: matrix,
        per_query: perQuery,
    };
    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`报告已写入: ${args.out}`);
    }
}

function round3(n: number): number {
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

main().catch((e) => {
    console.error('[intent-eval] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
