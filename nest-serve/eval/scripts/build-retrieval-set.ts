// ============================================================
// 造集脚本 · 检索评测集（LLM 反向生成 + 人工校对）
//
// 用法（需真实环境：MILVUS_ADDRESS / QWEN_API_KEY 已配置）：
//   npx ts-node eval/scripts/build-retrieval-set.ts \
//     --userId <userId> [--count 60] [--out eval/datasets/retrieval-<date>.jsonl]
//
// 流程：
//   1. 从用户 Milvus 集合随机抽 count 个 chunk（docId + docText 文本片段）
//   2. 对每个 chunk 用 LLM 反向生成一个该 chunk 能回答的问题
//   3. 按意图（fact/perspective）打标，relevant_chunks 记录 docId + 文本片段
//   4. 额外追加 out_of_kb 条库外问题（relevant_chunks 为空, has_basis=false）
//   5. 输出 JSONL —— 注意：生成结果需人工校对后才是正式评测集
// ============================================================

import { writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

// 独立脚本：手动加载 nest-serve/.env（Nest ConfigModule 才会自动加载）
loadEnv();

interface ParsedArgs {
    userId: string;
    count: number;
    out: string;
    outOfKb: number;
}

function parseArgs(argv: string[]): ParsedArgs {
    const get = (k: string) => {
        const i = argv.indexOf(k);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const userId = get('--userId');
    if (!userId) {
        console.error('用法: --userId <userId> [--count 60] [--outOfKb 20] [--out path]');
        process.exit(1);
    }
    const date = new Date().toISOString().slice(0, 10);
    return {
        userId,
        count: Number(get('--count') ?? 60),
        outOfKb: Number(get('--outOfKb') ?? 20),
        out: get('--out') ?? `eval/datasets/retrieval-${date}.jsonl`,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = new ConfigService();
    const qwenKey = config.get<string>('QWEN_API_KEY');
    if (!qwenKey) throw new Error('QWEN_API_KEY 未配置');

    const milvus = new MilvusClient({ address: config.get<string>('MILVUS_ADDRESS') || 'localhost:19530' });
    const collectionName = `_${args.userId}`;
    const has = await milvus.hasCollection({ collection_name: collectionName });
    if (!has.value) throw new Error(`集合不存在: ${collectionName}（用户未上传知识库）`);

    // 1. 拉取 chunk 并按 docId 分组，轮流取保证覆盖所有文件（避免单文件垄断）
    const queryRes = await milvus.query({
        collection_name: collectionName,
        output_fields: ['docId', 'docTitle', 'docText'],
        limit: Math.max(args.count * 5, 100),
    });
    const allChunks = (queryRes.data || []).filter((c: any) => c.docText && String(c.docText).trim());
    const byDoc = new Map<string, any[]>();
    for (const c of allChunks) {
        const key = c.docId || 'unknown';
        if (!byDoc.has(key)) byDoc.set(key, []);
        byDoc.get(key)!.push(c);
    }
    console.log(`[造集] 集合 ${collectionName} 共 ${allChunks.length} chunk / ${byDoc.size} 个文件`);
    // 轮流取样：每轮每文件取 1 个，直到取满 count
    const chunks: any[] = [];
    const queues = [...byDoc.values()].map((arr) => [...arr]);
    let round = 0;
    while (chunks.length < args.count && queues.some((q) => q.length > 0)) {
        for (const q of queues) {
            if (chunks.length >= args.count) break;
            if (q.length > 0) chunks.push(q.splice(Math.floor(Math.random() * q.length), 1)[0]);
        }
        round++;
        if (round > 50) break; // 防死循环
    }
    console.log(`[造集] 均衡抽到 ${chunks.length} 个 chunk（覆盖 ${new Set(chunks.map((c) => c.docId)).size} 个文件）`);

    const openai = new OpenAI({
        apiKey: qwenKey,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        timeout: 120000,
        maxRetries: 2,
    });
    const model = config.get<string>('QWEN_TEXT_MODEL') || 'qwen3.7-plus';

    // 2. LLM 反向生成问题 + 意图标注（一次调用处理 3 个 chunk 提效，避免超时）
    //    丢批修复（2026-08-11）：单批失败重试 2 次（原 95 目标只成功 53，超时/解析失败即丢整批）
    const lines: any[] = [];
    const BATCH = 3;
    const MAX_RETRY = 2;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const payload = batch.map((c: any, j: number) => ({ idx: j, text: String(c.docText).slice(0, 600) }));
        let list: any[] = [];
        for (let attempt = 0; attempt <= MAX_RETRY && list.length === 0; attempt++) {
            if (attempt > 0) {
                console.warn(`\n[造集] 第 ${i / BATCH + 1} 批第 ${attempt} 次重试（上次失败）`);
                await sleep(2000 * attempt);
            }
            try {
                const resp = await openai.chat.completions.create({
                    model,
                    messages: [
                        {
                            role: 'system',
                            content:
                                '你是评测集生成器。针对每个文本片段，生成 1 个该片段能直接回答的科研问题，并标注意图：' +
                                'fact（定义/概念/事实/公式/步骤）或 perspective（优缺点/评价/对比/分析）。' +
                                '只输出 JSON 数组：[{"idx":0,"query":"...","intent":"fact"}]，不要输出其他内容。',
                        },
                        { role: 'user', content: JSON.stringify(payload) },
                    ],
                    temperature: 0.7,
                    max_tokens: 800,
                    response_format: { type: 'json_object' },
                });
                const raw = resp.choices?.[0]?.message?.content?.trim() || '';
                const parsed = JSON.parse(raw);
                list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.questions) ? parsed.questions : [];
            } catch (e) {
                console.warn(`\n[造集] 第 ${i / BATCH + 1} 批调用失败:`, (e as Error).message);
            }
        }
        for (const item of list) {
            const c = batch[item.idx];
            if (!c || !item.query) continue;
            lines.push({
                qid: `r${String(lines.length + 1).padStart(3, '0')}`,
                query: item.query,
                // 文件级标注：relevant_chunks 只存 docId，文本片段仅作人工校对辅助
                relevant_chunks: [c.docId],
                chunk_snippet: String(c.docText).slice(0, 60),
                intent: item.intent === 'perspective' ? 'perspective' : 'fact',
                has_basis: true,
            });
        }
        process.stdout.write(`\r[造集] 已生成 ${lines.length}/${args.count}`);
    }
    console.log('');

    // 3. 库外问题（has_basis=false，评测拒答/熔断路径）
    const outOfKbQueries = [
        '量子计算在商业密码学中的具体应用案例有哪些',
        '2025 年全球半导体行业最新的市场研究报告结论',
        '我国新能源汽车电池回收的完整政策法规清单',
        '深度学习模型在医学影像诊断中的最新临床标准',
        '这份知识库里完全没有提到过的边缘计算协议',
        '区块链在供应链金融中的最新落地案例',
        '2024 年诺贝尔物理学奖得主的主要贡献',
        '跨境电商出口退税的最新政策规定',
        '脑机接口技术在医疗康复领域的最新进展',
        '我国碳中和目标下的碳交易市场机制',
        '大模型训练中的分布式集群调度最佳实践',
        '细胞基因治疗产品的临床注册审评指南',
        '全球主要央行 2025 年的货币政策走向',
        '智慧城市建设的顶层设计与评价指标体系',
        '高性能陶瓷材料在航空发动机中的应用研究现状',
    ];
    for (let i = 0; i < args.outOfKb && i < outOfKbQueries.length; i++) {
        lines.push({
            qid: `o${String(i + 1).padStart(3, '0')}`,
            query: outOfKbQueries[i % outOfKbQueries.length],
            relevant_chunks: [],
            intent: 'fact',
            has_basis: false,
        });
    }

    writeFileSync(args.out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    console.log(`[造集] 完成：${lines.length} 条 → ${args.out}`);
    console.log('⚠️  请人工校对 query 与 relevant_chunks 的相关性后再作为正式评测集使用！');
}

main().catch((e) => {
    console.error('[造集] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
