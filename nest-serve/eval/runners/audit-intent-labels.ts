// ============================================================
// 评测集 intent 标注校对工具
//
// 背景（实测发现）：造集脚本让 LLM 标 intent，但"差异/优势"等词被 LLM 标成
// perspective，而路由器触发词表里没有这些词 → 路由评测准确率被错误标注拉低。
//
// 本工具用「路由器判定 + 触发词命中」交叉校验 LLM 标注：
//   - 一致（AGREE）→ 可信，无需人工看
//   - 冲突（CONFLICT）→ 列出触发词，输出校对清单，人工确认后修正
//   - 附带 classify 明细便于快速定位
//
// 用法：
//   npx ts-node --transpile-only eval/runners/audit-intent-labels.ts \
//     --dataset eval/datasets/retrieval-2026-08-11-large.jsonl [--out audit.json]
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { IntentRouter } from '../../src/chat/routers/intent-router';
import { SkillLoader } from '../../src/chat/tools/skill-loader';

interface Sample {
    qid: string;
    query: string;
    intent?: string;
    has_basis?: boolean;
    chunk_snippet?: string;
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
        console.error('用法: --dataset <jsonl> [--out audit.json]');
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const samples = readDataset(args.dataset).filter((s) => s.intent && s.intent !== '');
    console.log(`[audit] 载入 ${samples.length} 条带 intent 的样本`);

    const loader = new SkillLoader();
    await loader.loadAllMetas();
    const router = new IntentRouter(loader);

    const conflicts: Array<{ qid: string; query: string; golden: string; predicted: string; matched: string[] }> = [];
    const agree: Array<{ qid: string; query: string; golden: string; predicted: string }> = [];
    const rows: Array<{ qid: string; query: string; golden: string; predicted: string; matched: string[]; agree: boolean }> = [];

    for (const s of samples) {
        const route = await router.classifyIntent(s.query);
        const golden = (s.intent as string).toLowerCase();
        const matched = route.matchedTriggers ?? [];
        const isAgree = golden === route.intent;
        rows.push({ qid: s.qid, query: s.query.slice(0, 60), golden, predicted: route.intent, matched, agree: isAgree });
        if (isAgree) {
            agree.push({ qid: s.qid, query: s.query.slice(0, 60), golden, predicted: route.intent });
        } else {
            conflicts.push({ qid: s.qid, query: s.query.slice(0, 60), golden, predicted: route.intent, matched });
        }
    }

    console.log(`一致: ${agree.length}（${(agree.length / rows.length * 100).toFixed(0)}%）  冲突: ${conflicts.length}`);
    console.log('\n===== 冲突清单（需人工确认 intent）=====');
    for (const c of conflicts) {
        console.log(`[${c.qid}] LLM标=${c.golden}  路由判=${c.predicted}`);
        console.log(`    query: ${c.query}`);
        console.log(`    触发词: ${c.matched.length ? c.matched.join(' | ') : '(无，默认 fact)'}`);
    }

    const report = {
        dataset: args.dataset,
        ts: new Date().toISOString(),
        total: rows.length,
        agree: agree.length,
        conflicts: conflicts.length,
        conflict_ratio: rows.length ? +(conflicts.length / rows.length).toFixed(3) : NaN,
        rows,
    };
    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`\n校对明细已写入: ${args.out}`);
    }
}

main().catch((e) => {
    console.error('[audit] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
