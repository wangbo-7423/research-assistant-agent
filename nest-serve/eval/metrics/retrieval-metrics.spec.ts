import {
    recallAtK,
    precisionAtK,
    mrr,
    hitRateAtK,
    ndcgAtK,
    computeRetrievalMetrics,
    runRetrievalEval,
} from './retrieval-metrics';

describe('retrieval-metrics · L2 指标纯函数', () => {
    const relevant = ['a', 'b', 'c'];
    const ranked = ['x', 'a', 'y', 'b', 'z', 'c'];

    it('Recall@k：前 k 命中数 / 相关总数', () => {
        expect(recallAtK(ranked, relevant, 3)).toBe(1 / 3); // 只命中 a
        expect(recallAtK(ranked, relevant, 5)).toBe(2 / 3); // a + b
        expect(recallAtK(ranked, relevant, 20)).toBe(1); // 全部命中
        expect(recallAtK([], relevant, 5)).toBe(0);
        expect(recallAtK(ranked, [], 5)).toBe(0); // 无相关标注 → 0
    });

    it('Precision@k：前 k 中相关数 / k', () => {
        expect(precisionAtK(ranked, relevant, 3)).toBe(1 / 3);
        expect(precisionAtK(ranked, relevant, 5)).toBe(2 / 5);
        expect(precisionAtK(ranked, relevant, 0)).toBe(0);
    });

    it('MRR：第一个相关结果的倒数排名', () => {
        expect(mrr(ranked, relevant)).toBe(1 / 2); // a 在 rank 2
        expect(mrr(['x', 'y'], relevant)).toBe(0);
        expect(mrr(ranked, [])).toBe(0);
    });

    it('HitRate@k：前 k 至少命中 1 条', () => {
        expect(hitRateAtK(ranked, relevant, 1)).toBe(0);
        expect(hitRateAtK(ranked, relevant, 3)).toBe(1);
    });

    it('nDCG@k：位置折损', () => {
        // 理想排序 = 前 3 全是相关 → IDCG = 1/log2(2)+1/log2(3)+1/log2(4) = 1 + 0.6309 + 0.5 = 2.1309
        // 实际：a@2、b@4 → DCG = 1/log2(3) + 1/log2(5) = 0.6309 + 0.4307 = 1.0616
        const ndcg = ndcgAtK(ranked, relevant, 5);
        expect(ndcg).toBeCloseTo(1.0616 / 2.1309, 3);
        // 理想排序本身 = 1
        expect(ndcgAtK(['a', 'b', 'c'], relevant, 5)).toBeCloseTo(1, 5);
    });

    it('computeRetrievalMetrics 返回标准指标包', () => {
        const m = computeRetrievalMetrics(ranked, relevant);
        expect(m.recall_at_3).toBeCloseTo(1 / 3, 3);
        expect(m.recall_at_5).toBeCloseTo(2 / 3, 3);
        expect(m.recall_at_20).toBe(1);
        expect(m.mrr).toBe(0.5);
        expect(m.ndcg_at_5).toBeGreaterThan(0);
        expect(m.hit_rate_at_3).toBe(1);
    });

    it('runRetrievalEval 批量聚合：均值 + 明细', () => {
        const res = runRetrievalEval([
            { qid: 'q1', rankedIds: ranked, relevantIds: relevant },
            { qid: 'q2', rankedIds: ['a', 'b', 'c'], relevantIds: ['a', 'b'], extra: { intent: 'fact' } },
        ]);
        expect(res.total).toBe(2);
        expect(res.per_query).toHaveLength(2);
        expect(res.per_query[1].extra.intent).toBe('fact');
        expect(res.avg.mrr).toBeCloseTo((0.5 + 1) / 2, 3);
        // 注意 avg 是 round3 后的均值，期望值按 round3 后的分子计算
        expect(res.avg.recall_at_5).toBeCloseTo((0.667 + 1) / 2, 2);
    });

    it('normalizeIds 去重且忽略空值', () => {
        expect(recallAtK(['a', 'a', 'b'], ['a', 'b'], 5)).toBe(1);
        // @ts-expect-error 故意传脏数据验证健壮性
        expect(recallAtK([undefined, null, 'a'], ['a'], 5)).toBe(1);
    });
});
