import { join } from 'path';
import { SkillLoader } from '../tools/skill-loader';
import {
  IntentRouter,
  IntentRouteResult,
  createClarifyState,
  isPendingExpired,
  handlePendingConfirmation,
  onFactResult,
  PENDING_TTL_MS,
  PENDING_MAX_TURNS,
  MAX_CONSECUTIVE_FALLBACKS,
  ClarifyState,
  FallbackCounter,
} from './intent-router';

// 使用仓库中真实的 .skill.md 文件，保证测试与线上触发词配置同步
describe('IntentRouter · classifyIntent（真实 skill 文件）', () => {
  let router: IntentRouter;

  beforeAll(async () => {
    const loader = new SkillLoader(join(__dirname, '..', 'tools'));
    await loader.loadAllMetas();
    router = new IntentRouter(loader);
  });

  it('模糊续问词 → clarify', async () => {
    const r = await router.classifyIntent('然后呢');
    expect(r.intent).toBe('clarify');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('纯语气词短输入 → clarify', async () => {
    const r = await router.classifyIntent('嗯');
    expect(r.intent).toBe('clarify');
  });

  it('事实类问题 → fact', async () => {
    const r = await router.classifyIntent('注意力机制的原理是什么');
    expect(r.intent).toBe('fact');
    expect(r.matchedTriggers?.length).toBeGreaterThan(0);
  });

  it('同时命中 fact + perspective 触发词 → 用户态 perspective + hybrid 内部标记', async () => {
    const input = '你怎么看 RAG 检索的原理';
    const r = await router.classifyIntent(input);
    expect(r.intent).toBe('perspective');
    expect(r.hybrid).toBe(true);
    // 执行计划与分类结果一致：hybrid 内部策略
    const plan = router.buildExecutionPlan(r, input);
    expect(plan.userFacingIntent).toBe('perspective');
    expect(plan.internalStrategy).toBe('hybrid');
  });

  it('纯评价类问题 → perspective 且非 hybrid', async () => {
    const input = '如何评价这项技术的长期影响';
    const r = await router.classifyIntent(input);
    expect(r.intent).toBe('perspective');
    expect(r.hybrid).toBe(false);
    expect(router.buildExecutionPlan(r, input).internalStrategy).toBe('single');
  });

  it('未命中任何触发词 → 默认 fact，置信度 0.3', async () => {
    const r = await router.classifyIntent('帮我讲讲量子计算的发展');
    expect(r.intent).toBe('fact');
    expect(r.confidence).toBe(0.3);
  });

  it('confidence 始终归一化在 [0,1] 区间', async () => {
    // 多触发词叠加（keyword + pattern + 短输入阈值）原始分可到上限 3
    for (const input of ['嗯', '然后呢', '是什么', '你怎么看 RAG 的原理', '随机输入一句不算短的话']) {
      const r = await router.classifyIntent(input);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('buildExecutionPlan 对外部构造的 route（无 hybrid 字段）按旧规则兜底重算', () => {
    const externalRoute: IntentRouteResult = { intent: 'perspective', confidence: 0.8, reasoning: '外部来源' };
    expect(router.buildExecutionPlan(externalRoute, '你怎么看这个公式的推导').internalStrategy).toBe('hybrid');
    expect(router.buildExecutionPlan(externalRoute, '你怎么看这项技术的趋势').internalStrategy).toBe('single');
  });
});

describe('pendingConfirmation 状态机（纯函数）', () => {
  const baseState = (): ClarifyState =>
    createClarifyState('c1', [
      { text: '候选A的具体实现', confidence: 0.85 },
      { text: '候选B的对比分析', confidence: 0.6 },
    ]);

  it('createClarifyState 初始化默认值', () => {
    const s = baseState();
    expect(s.mode).toBe('pending_confirmation');
    expect(s.currentTurn).toBe(0);
    expect(s.maxTurns).toBe(PENDING_MAX_TURNS);
    expect(s.inferredIntents).toHaveLength(2);
  });

  it('未超时且未满轮次 → 不过期', () => {
    expect(isPendingExpired(baseState())).toBe(false);
  });

  it('超过 TTL → 过期', () => {
    const s = { ...baseState(), setAt: Date.now() - PENDING_TTL_MS - 1000 };
    expect(isPendingExpired(s)).toBe(true);
  });

  it('达到最大轮次 → 过期', () => {
    const s = { ...baseState(), currentTurn: PENDING_MAX_TURNS };
    expect(isPendingExpired(s)).toBe(true);
  });

  it('pending 下给出具体问题 → 正常处理并退出 pending', () => {
    const r = handlePendingConfirmation('Transformer 的自注意力机制是怎么计算的？', baseState());
    expect(r.exitPending).toBe(true);
    expect(r.intent).toBe('fact');
    expect(r.resolvedQuery).toContain('自注意力');
  });

  it('pending 下纯确认词 → 映射最高置信度候选项', () => {
    const r = handlePendingConfirmation('是', baseState());
    expect(r.exitPending).toBe(true);
    expect(r.resolvedQuery).toBe('候选A的具体实现');
  });

  it('pending 下否定词 → 映射第二候选项', () => {
    const r = handlePendingConfirmation('不是', baseState());
    expect(r.exitPending).toBe(true);
    expect(r.resolvedQuery).toBe('候选B的对比分析');
  });

  it('pending 下否定但无第二候选项 → 再次澄清', () => {
    const s = createClarifyState('c1', [{ text: '唯一候选', confidence: 0.8 }]);
    const r = handlePendingConfirmation('不是', s);
    expect(r.exitPending).toBe(true);
    expect(r.intent).toBe('clarify');
  });

  it('pending 下其他短输入 → 降级为 normal，不再触发 clarify', () => {
    const r = handlePendingConfirmation('好的谢谢', baseState());
    expect(r.exitPending).toBe(true);
    expect(r.intent).toBe('fact');
  });
});

describe('Fact 连续 Fallback 熔断（纯函数）', () => {
  const zero = (): FallbackCounter => ({ count: 0, lastResetAt: Date.now() });

  it('成功命中 → 计数器归零', () => {
    const r = onFactResult(true, { count: 2, lastResetAt: Date.now() });
    expect(r.action).toBe('allow');
    expect(r.counter.count).toBe(0);
    expect(r.consecutiveCount).toBe(0);
  });

  it('上限内的连续失败 → 放行并累加', () => {
    let c = zero();
    for (let i = 1; i <= MAX_CONSECUTIVE_FALLBACKS; i++) {
      const r = onFactResult(false, c);
      expect(r.action).toBe('allow');
      expect(r.consecutiveCount).toBe(i);
      c = r.counter;
    }
  });

  it('第 3 次连续失败（超过上限）→ 拒绝', () => {
    const r = onFactResult(false, { count: MAX_CONSECUTIVE_FALLBACKS, lastResetAt: Date.now() });
    expect(r.action).toBe('reject');
    expect(r.consecutiveCount).toBe(MAX_CONSECUTIVE_FALLBACKS + 1);
  });

  it('失败-成功-失败 → 成功会重置计数', () => {
    const miss1 = onFactResult(false, zero());
    const hit = onFactResult(true, miss1.counter);
    const miss2 = onFactResult(false, hit.counter);
    expect(miss2.consecutiveCount).toBe(1);
    expect(miss2.action).toBe('allow');
  });
});
