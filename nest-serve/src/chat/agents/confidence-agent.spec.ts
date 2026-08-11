import { ConfidenceAgent, ConfidenceConfig, resolveConfidenceConfig, computeConfigHash } from './confidence-agent';

describe('ConfidenceAgent · 规则打分', () => {
  let agent: ConfidenceAgent;

  beforeEach(() => {
    agent = new ConfidenceAgent();
  });

  it('无命中结果 → fail + reject_or_fallback + 用户引导文案', () => {
    const r = agent.check([], '任意问题');
    expect(r.check_result).toBe('fail');
    expect(r.overall_confidence).toBe(0);
    expect(r.recommended_action.action).toBe('reject_or_fallback');
    expect(r.recommended_action.user_message).toContain('上传');
    expect(r.warnings).toContain('no_results');
  });

  it('多来源 + 高相关分 + 出处完整 → pass', () => {
    const r = agent.check(
      [
        { docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.92 },
        { docId: 'd2', docTitle: 'B.pdf', docText: '内容B', score: 0.88 },
      ],
      '问题',
    );
    expect(r.check_result).toBe('pass');
    expect(r.recommended_action.action).toBe('proceed');
    expect(r.overall_confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.warnings).toHaveLength(0);
  });

  it('单一来源 → source_reliability 降低并给出 single_source 警告，且推荐 suggest_more_sources（R3）', () => {
    const r = agent.check([{ docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.9 }], '问题');
    expect(r.check_result).toBe('warn');
    expect(r.warnings).toContain('single_source');
    expect(r.warnings).toContain('cross_source_unverified');
    expect(r.recommended_action.action).toBe('suggest_more_sources');
    expect(r.recommended_action.user_message).toContain('上传');
    expect(r.recommended_action.auto_executable).toBe(true);
  });

  it('低相关分 + 出处不完整 → fail', () => {
    const r = agent.check([{ docId: 'd1', docText: '', score: 0.1 }], '问题');
    expect(r.check_result).toBe('fail');
    expect(r.overall_confidence).toBeLessThan(0.5);
    expect(r.warnings).toContain('citation_incomplete');
    expect(r.recommended_action.action).toBe('reject_or_fallback');
  });

  it('多来源 + 引用不完整 → warn 且推荐 narrow_claim_scope（R3）', () => {
    const r = agent.check(
      [
        { docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.85 },
        { docId: 'd2', docTitle: 'B.pdf', docText: '', score: 0.8 },
      ],
      '问题',
    );
    expect(r.check_result).toBe('warn');
    expect(r.warnings).toContain('citation_incomplete');
    expect(r.recommended_action.action).toBe('narrow_claim_scope');
    expect(r.recommended_action.user_message).toContain('收窄');
  });

  it('多来源 + 相关性离散度大 → warn 且推荐 highlight_conflict（R3）', () => {
    const r = agent.check(
      [
        { docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.7 },
        { docId: 'd2', docTitle: 'B.pdf', docText: '内容B', score: 0.2 },
      ],
      '问题',
    );
    expect(r.check_result).toBe('warn');
    expect(r.recommended_action.action).toBe('highlight_conflict');
    expect(r.recommended_action.user_message).toContain('分歧');
  });

  it('strict 模式上调置信度，relaxed 模式下调', () => {
    const results = [
      { docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.75 },
      { docId: 'd2', docTitle: 'B.pdf', docText: '内容B', score: 0.75 },
    ];
    const normal = agent.check(results, '问题', 'normal');
    const strict = agent.check(results, '问题', 'strict');
    const relaxed = agent.check(results, '问题', 'relaxed');
    expect(strict.overall_confidence).toBeGreaterThan(normal.overall_confidence);
    expect(relaxed.overall_confidence).toBeLessThan(normal.overall_confidence);
  });

  it('dimension_scores 四项齐全且保留两位小数', () => {
    const r = agent.check([{ docId: 'd1', docTitle: 'A.pdf', docText: 'x', score: 0.83 }], '问题');
    const ds = r.dimension_scores;
    expect(ds.source_reliability).toBeDefined();
    expect(ds.content_relevance).toBeDefined();
    expect(ds.citation_completeness).toBeDefined();
    expect(ds.cross_source_consistency).toBeDefined();
    for (const v of Object.values(ds)) {
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });

  it('无参构造与显式默认配置：configHash 相同、判定结果一致（向后兼容）', () => {
    const a1 = new ConfidenceAgent();
    const a2 = new ConfidenceAgent({});
    expect(a1.configHash).toBe(a2.configHash);
    const results = [
      { docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.92 },
      { docId: 'd2', docTitle: 'B.pdf', docText: '内容B', score: 0.88 },
    ];
    expect(a1.check(results, '问题')).toEqual(a2.check(results, '问题'));
  });

  it('自定义配置改变判定阈值（passThreshold 从 0.8 调低到 0.7）', () => {
    const relaxed = new ConfidenceAgent({ passThreshold: 0.7 });
    // 单源 0.9 分：默认 0.8 阈值下为 warn，0.7 阈值下为 pass
    const r = relaxed.check([{ docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.9 }], '问题');
    expect(r.check_result).toBe('pass');
    const rDefault = agent.check([{ docId: 'd1', docTitle: 'A.pdf', docText: '内容A', score: 0.9 }], '问题');
    expect(rDefault.check_result).toBe('warn');
    expect(relaxed.configHash).not.toBe(agent.configHash);
  });

  it('normalizeResults 收敛输入：score 缺省填 0.6，字段保留', () => {
    const out = ConfidenceAgent.normalizeResults([
      { docId: 'd1' } as any,
      null as any,
      { docId: 'd2', docTitle: 'B.pdf', docText: 'x', score: 0.7 },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].score).toBe(0.6);
    expect(out[0].docId).toBe('d1');
    expect(out[1].score).toBe(0.6);
    expect(out[2].score).toBe(0.7);
  });

  it('resolveConfidenceConfig / computeConfigHash 纯函数可用（供评测 runner 扫参）', () => {
    const cfg: ConfidenceConfig = { passThreshold: 0.75, weights: { content_relevance: 0.4 } };
    const resolved = resolveConfidenceConfig(cfg);
    expect(resolved.passThreshold).toBe(0.75);
    expect(resolved.weights.content_relevance).toBe(0.4);
    expect(resolved.weights.source_reliability).toBe(0.25); // 其余保持默认
    // 不同配置 hash 不同，相同配置 hash 相同
    expect(computeConfigHash(cfg)).not.toBe(computeConfigHash({}));
    expect(computeConfigHash(cfg)).toBe(computeConfigHash({ ...cfg }));
  });
});
