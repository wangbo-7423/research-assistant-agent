// ============================================================
// L2 指标函数层 · 高复用纯函数
// 输入 (rankedIds, relevantIds) 输出分数，与 RAG 实现完全解耦。
// 供离线评测 runner / CI 门禁复用，不依赖任何框架。
// ============================================================

/** 归一化：去重 + 只保留字符串 id */
export function normalizeIds(ids: Array<string | number | undefined | null>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (id === undefined || id === null) continue;
        const key = String(id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

/** 前 k 条中命中相关数 / 该问题相关总数（无相关标注时为 0） */
export function recallAtK(rankedIds: Array<string | number>, relevantIds: Array<string | number>, k: number): number {
    const rel = new Set(normalizeIds(relevantIds));
    if (rel.size === 0) return 0;
    const top = normalizeIds(rankedIds).slice(0, k);
    const hits = top.filter((id) => rel.has(id)).length;
    return hits / rel.size;
}

/** 前 k 条中相关数 / k（k 为 0 时为 0） */
export function precisionAtK(rankedIds: Array<string | number>, relevantIds: Array<string | number>, k: number): number {
    if (k <= 0) return 0;
    const rel = new Set(normalizeIds(relevantIds));
    const top = normalizeIds(rankedIds).slice(0, k);
    const hits = top.filter((id) => rel.has(id)).length;
    return hits / k;
}

/** 第一个相关结果的倒数排名均值；无命中返回 0 */
export function mrr(rankedIds: Array<string | number>, relevantIds: Array<string | number>): number {
    const rel = new Set(normalizeIds(relevantIds));
    if (rel.size === 0) return 0;
    const ranked = normalizeIds(rankedIds);
    for (let i = 0; i < ranked.length; i++) {
        if (rel.has(ranked[i])) return 1 / (i + 1);
    }
    return 0;
}

/** 前 k 条是否至少命中 1 条相关 */
export function hitRateAtK(rankedIds: Array<string | number>, relevantIds: Array<string | number>, k: number): number {
    const rel = new Set(normalizeIds(relevantIds));
    if (rel.size === 0) return 0;
    const top = normalizeIds(rankedIds).slice(0, k);
    return top.some((id) => rel.has(id)) ? 1 : 0;
}

/**
 * nDCG@k（二元相关性：命中=1，未命中=0）。
 * DCG = Σ (rel_i / log2(i+2))；nDCG = DCG / IDCG（IDCG 按理想排序计算）。
 */
export function ndcgAtK(rankedIds: Array<string | number>, relevantIds: Array<string | number>, k: number): number {
    const rel = new Set(normalizeIds(relevantIds));
    if (rel.size === 0) return 0;
    const ranked = normalizeIds(rankedIds).slice(0, k);
    const dcg = ranked.reduce((sum, id, i) => sum + (rel.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
    const idcg = Array.from({ length: Math.min(k, rel.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    return idcg > 0 ? dcg / idcg : 0;
}

export interface RetrievalMetrics {
    recall_at_3: number;
    recall_at_5: number;
    recall_at_20: number;
    precision_at_3: number;
    precision_at_5: number;
    mrr: number;
    ndcg_at_5: number;
    hit_rate_at_3: number;
}

/** 一次检索的标准指标包 */
export function computeRetrievalMetrics(
    rankedIds: Array<string | number>,
    relevantIds: Array<string | number>,
): RetrievalMetrics {
    return {
        recall_at_3: round3(recallAtK(rankedIds, relevantIds, 3)),
        recall_at_5: round3(recallAtK(rankedIds, relevantIds, 5)),
        recall_at_20: round3(recallAtK(rankedIds, relevantIds, 20)),
        precision_at_3: round3(precisionAtK(rankedIds, relevantIds, 3)),
        precision_at_5: round3(precisionAtK(rankedIds, relevantIds, 5)),
        mrr: round3(mrr(rankedIds, relevantIds)),
        ndcg_at_5: round3(ndcgAtK(rankedIds, relevantIds, 5)),
        hit_rate_at_3: round3(hitRateAtK(rankedIds, relevantIds, 3)),
    };
}

/** 批量评测：对每条样本算指标，返回均值 + 明细 */
export interface BatchEvalResult<T = Record<string, unknown>> {
    avg: RetrievalMetrics;
    per_query: Array<{ qid: string; metrics: RetrievalMetrics; extra: T }>;
    total: number;
}

export function runRetrievalEval<T = Record<string, unknown>>(
    samples: Array<{ qid: string; rankedIds: Array<string | number>; relevantIds: Array<string | number>; extra?: T }>,
): BatchEvalResult<T> {
    const per_query = samples.map((s) => ({
        qid: s.qid,
        metrics: computeRetrievalMetrics(s.rankedIds, s.relevantIds),
        extra: (s.extra ?? {}) as T,
    }));
    const keys = Object.keys(per_query[0]?.metrics ?? {}) as Array<keyof RetrievalMetrics>;
    const avg = {} as RetrievalMetrics;
    for (const key of keys) {
        avg[key] = round3(per_query.reduce((sum, q) => sum + q.metrics[key], 0) / Math.max(per_query.length, 1));
    }
    return { avg, per_query, total: per_query.length };
}

/** 保留 3 位小数 */
function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
