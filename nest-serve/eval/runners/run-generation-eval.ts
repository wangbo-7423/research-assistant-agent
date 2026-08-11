// ============================================================
// L0 评测 runner · 生成层程序化校验（P1 · 设计文档 2.3 落地）
//
// 原则（v2）：能用代码判定的绝不用模型。
// 对评测集每条 query 走真实生成链路（检索 → LLM 回答），然后：
//   1. 引用正确率（程序化）：回答中出现的 docTitle 是否真在注入上下文中
//   2. 拒答正确率（程序化）：库外问题是否触发了 fallback/⚠️ 前缀/拒答文案
//   3. 忠实度代理（embedding）：回答拆成句子，与注入上下文算余弦相似度，
//      低于阈值标记为疑似幻觉（只输出疑似项供人工复核，不做自动判定）
//
// 用法（需真实环境 + QWEN_API_KEY / MILVUS_ADDRESS / DASHSCOPE_RERANK_*）：
//   npx ts-node --transpile-only eval/runners/run-generation-eval.ts \
//     --dataset eval/datasets/retrieval-2026-08-11.jsonl \
//     --userId 6a62f8b81fee7cc0d9799323 [--out report.json]
// ============================================================

import { readFileSync, writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { FileanagementService } from '../../src/fileanagement/fileanagement.service';

loadEnv();

interface Sample {
    qid: string;
    query: string;
    relevant_chunks: string[];
    has_basis?: boolean;
    chunk_snippet?: string;
}

interface ParsedArgs {
    dataset: string;
    userId: string;
    out?: string;
    maxSamples?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
    const get = (k: string) => {
        const i = argv.indexOf(k);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dataset = get('--dataset');
    const userId = get('--userId');
    if (!dataset || !userId) {
        console.error('用法: --dataset <jsonl> --userId <userId> [--out report.json] [--max 10]');
        process.exit(1);
    }
    return {
        dataset,
        userId,
        out: get('--out'),
        maxSamples: get('--max') ? Number(get('--max')) : undefined,
    };
}

function readDataset(path: string): Sample[] {
    return readFileSync(path, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

/** 拒答判定：库外问题（has_basis=false）是否被正确拒答 */
function checkRefusal(answer: string, snippets: string[]): { refused: boolean; detail: string } {
    const REFUSAL_MARKERS = [
        '没有检索到相关文档',
        '知识库中未检索到与问题相关的资料',
        '在你的知识库中没有找到与这个问题相关的资料',
        '现有资料不足以支撑',
        '上传到知识库',
        '无法给出',
        '知识库中没有',
        '未检索到',
    ];
    // 空上下文（无注入片段）+ 回答里没有拼凑上下文 → 视为拒答（模型没硬编造库内答案）
    const refusedByMarker = REFUSAL_MARKERS.some((m) => answer.includes(m));
    if (refusedByMarker) return { refused: true, detail: '命中拒答标记' };
    if (snippets.length === 0 && answer.length < 80) {
        return { refused: true, detail: '无注入上下文且回答极短（模型未硬答）' };
    }
    return { refused: false, detail: '未命中拒答标记' };
}

/** 引用正确率：回答中出现的 docTitle 是否真在注入上下文中 */
function checkCitation(answer: string, contextText: string): { cited: string[]; fake: string[]; ok: boolean } {
    // 提取回答中出现的引号标题（「xxx.pdf」/ "xxx.pdf" 或「xxx」格式）；排除注入格式的「片段N」
    const cited = [...answer.matchAll(/「([^」]{3,60})」|"([^"]{3,60})\.pdf"/g)]
        .map((m) => m[1] ?? m[2])
        .filter((t) => t && !/^片段\d+$/.test(t));
    const unique = [...new Set(cited)];
    if (unique.length === 0) return { cited: [], fake: [], ok: true }; // 无引用标注则跳过
    const fake = unique.filter((t) => !contextText.includes(t));
    return { cited: unique, fake, ok: fake.length === 0 };
}

/** 忠实度代理：回答句子与上下文片段的余弦相似度（用现有 embedding 模型） */
function cosine(a: number[], b: number[]): number {
    const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
    const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    return na && nb ? dot / (na * nb) : 0;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const samplesRaw = readDataset(args.dataset);
    const samples = args.maxSamples ? samplesRaw.slice(0, args.maxSamples) : samplesRaw;
    console.log(`[gen-eval] 载入 ${samples.length} 条样本（${args.dataset}）`);

    const config = new ConfigService();
    const qwenKey = config.get<string>('QWEN_API_KEY');
    if (!qwenKey) throw new Error('QWEN_API_KEY 未配置');

    const service = new FileanagementService({} as never, config);
    const openai = new OpenAI({
        apiKey: qwenKey,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        timeout: 120000,
        maxRetries: 2,
    });
    const textModel = config.get<string>('QWEN_TEXT_MODEL') || 'qwen3.7-plus';
    const embeddingModel = config.get<string>('QWEN_EMBEDDING_MODEL') || 'text-embedding-v3';

    const rows: any[] = [];
    let citationOk = 0;
    let citationChecked = 0;
    let refusalOk = 0;
    let refusalChecked = 0;
    let suspected = 0;

    for (const s of samples) {
        // 1. 检索（走与生产一致的 preciseSearch）
        const precise = await service.preciseSearch(s.query, args.userId, { topK: 3 });
        const snippets = precise.results.map((r) => r.docText);
        const contextText = snippets.map((t, i) => `【片段${i + 1}】\n${t}`).join('\n\n');

        // 2. 生成回答（注入上下文，模拟生产 fact 路径 prompt）
        let answer = '';
        if (snippets.length > 0) {
            const resp = await openai.chat.completions.create({
                model: textModel,
                messages: [
                    {
                        role: 'system',
                        content:
                            '你是科研知识库问答助手。严格基于给定的知识库片段回答，引用来源时使用「文档标题」格式，' +
                            '不要编造片段中不存在的信息。若片段不足以回答，请明确说明。',
                    },
                    {
                        role: 'user',
                        content: `知识库检索结果如下：\n${contextText}\n\n请基于上述检索结果回答用户问题：${s.query}`,
                    },
                ],
                temperature: 0.2,
                max_tokens: 500,
            });
            answer = resp.choices?.[0]?.message?.content?.trim() || '';
        }

        // 3. 程序化校验
        const citation = checkCitation(answer, contextText);
        if (citation.cited.length > 0) {
            citationChecked++;
            if (citation.ok) citationOk++;
        }
        const refusal = checkRefusal(answer, snippets);
        if (s.has_basis === false) {
            refusalChecked++;
            if (refusal.refused) refusalOk++;
        }

        // 4. 忠实度代理：回答逐句与上下文片段比相似度
        const sentences = answer.split(/[。！？\n]+/).map((x) => x.trim()).filter((x) => x.length >= 8);
        let lowSentences: Array<{ text: string; sim: number }> = [];
        if (sentences.length > 0 && snippets.length > 0) {
            try {
                const embs = await openai.embeddings.create({
                    model: embeddingModel,
                    input: sentences.slice(0, 5),
                    encoding_format: 'float',
                    dimensions: Number(config.get('QWEN_EMBEDDING_DIMENSIONS')) || 1024,
                });
                const ctxEmb = await openai.embeddings.create({
                    model: embeddingModel,
                    input: [snippets.join('\n').slice(0, 2000)],
                    encoding_format: 'float',
                    dimensions: Number(config.get('QWEN_EMBEDDING_DIMENSIONS')) || 1024,
                });
                const ctxVec = ctxEmb.data[0].embedding;
                sentences.slice(0, 5).forEach((sent, i) => {
                    const sim = cosine(embs.data[i]?.embedding ?? [], ctxVec);
                    if (sim < 0.45) {
                        lowSentences.push({ text: sent, sim: Math.round(sim * 100) / 100 });
                    }
                });
                if (lowSentences.length > 0) suspected++;
            } catch (e) {
                console.warn('[gen-eval] 忠实度 embedding 失败，跳过:', (e as Error).message);
            }
        }

        rows.push({
            qid: s.qid,
            query: s.query.slice(0, 50),
            has_basis: s.has_basis,
            retrieval_count: snippets.length,
            top_score: precise.results[0]?.score ?? 0,
            low_confidence: precise.lowConfidence,
            citation: citation,
            refusal: refusal,
            suspected_hallucinations: lowSentences,
            answer_len: answer.length,
        });
        process.stdout.write(`\r[gen-eval] 已处理 ${rows.length}/${samples.length}`);
    }
    console.log('');

    const report = {
        dataset: args.dataset,
        userId: args.userId,
        ts: new Date().toISOString(),
        summary: {
            total: samples.length,
            citation_checked: citationChecked,
            citation_accuracy: citationChecked ? round3(citationOk / citationChecked) : NaN,
            refusal_checked: refusalChecked,
            refusal_accuracy: refusalChecked ? round3(refusalOk / refusalChecked) : NaN,
            suspected_hallucination_queries: suspected,
        },
        rows,
    };

    console.log('\n===== 生成层程序化校验 =====');
    console.log(`引用正确率: ${report.summary.citation_accuracy}（检查 ${citationChecked} 条有引用的回答）`);
    console.log(`拒答正确率: ${report.summary.refusal_accuracy}（检查 ${refusalChecked} 条库外问题）`);
    console.log(`疑似幻觉 query 数: ${suspected}/${samples.length}（需人工复核）`);

    if (args.out) {
        writeFileSync(args.out, JSON.stringify(report, null, 2));
        console.log(`报告已写入: ${args.out}`);
    }
}

function round3(n: number): number {
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

main().catch((e) => {
    console.error('[gen-eval] 失败:', e instanceof Error ? e.message : e);
    process.exit(1);
});
