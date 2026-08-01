import { Injectable } from '@nestjs/common';
import { SkillLoader } from '../tools/skill-loader';

// ============================================================
// 意图路由器 · 四工具 RAG 架构
//
// 用户只看到三种分类：clarify / fact / perspective
// hybrid 是服务端内部的组合策略，不是路由结果类型（R1）
// ============================================================

export type IntentType = 'clarify' | 'fact' | 'perspective';
export type InternalStrategy = 'single' | 'hybrid';

export interface IntentRouteResult {
    intent: IntentType;
    /** 归一化到 [0,1] 的置信度 */
    confidence: number;
    reasoning: string;
    matchedTriggers?: string[];
    /** 内部标记：是否命中 fact+perspective 双触发（hybrid 组合策略，用户不可见） */
    hybrid?: boolean;
}

export interface InternalExecutionPlan {
    userFacingIntent: IntentType;
    internalStrategy: InternalStrategy;
}

// —— pendingConfirmation 状态机 ——
export interface ClarifyState {
    mode: 'pending_confirmation' | null;
    setAt: number;
    clarificationId: string;
    inferredIntents: Array<{ text: string; confidence: number }>;
    maxTurns: number;
    currentTurn: number;
}

export const PENDING_TTL_MS = 60_000;
export const PENDING_MAX_TURNS = 3;

// —— Fact fallback 连续熔断 ——
export const MAX_CONSECUTIVE_FALLBACKS = 2;

export interface FallbackCounter {
    count: number;
    lastResetAt: number;
}

@Injectable()
export class IntentRouter {
    constructor(private readonly skillLoader: SkillLoader) {}

    /**
     * 轻量分类：只读 skill 的 YAML triggers（不加载 Markdown 正文）。
     * pendingConfirmation 的前置检查在调用方（chat.service）完成，
     * 因此此方法的输入是「未被 pending 拦截」的用户输入。
     */
    async classifyIntent(userInput: string, _conversationContext?: string): Promise<IntentRouteResult> {
        const input = userInput.trim();
        const metas = this.skillLoader.getAllMetas();
        const clarify = metas.find((m) => m.name === 'clarify');
        const fact = metas.find((m) => m.name === 'fact_retriever');
        const perspective = metas.find((m) => m.name === 'perspective_analyzer');

        const clarifyMatch = clarify ? this.matchDetail(input, clarify.triggers) : { score: 0, matched: [] };
        const factMatch = fact ? this.matchDetail(input, fact.triggers) : { score: 0, matched: [] };
        const perspectiveMatch = perspective ? this.matchDetail(input, perspective.triggers) : { score: 0, matched: [] };

        const hasEntity = /[A-Za-z一-鿿]{2,}/.test(input);
        const hybridActive = factMatch.score > 0 && perspectiveMatch.score > 0 && hasEntity;

        // 1) 纯模糊/续问：无事实或评价触发词 → clarify
        if (clarifyMatch.score > 0 && factMatch.score === 0 && perspectiveMatch.score === 0) {
            return {
                intent: 'clarify',
                confidence: this.toConfidence(clarifyMatch.score),
                reasoning: '命中 clarify 触发词且无 fact/perspective 触发词',
                matchedTriggers: clarifyMatch.matched,
            };
        }

        // 2) 同时命中 fact + perspective + 有实体 → hybrid（用户态为 perspective）
        if (hybridActive) {
            return {
                intent: 'perspective',
                confidence: this.toConfidence(Math.max(factMatch.score, perspectiveMatch.score)),
                reasoning: '同时命中 fact+perspective 触发词且有实体，按 hybrid 内部策略处理',
                matchedTriggers: [...factMatch.matched, ...perspectiveMatch.matched],
                hybrid: true,
            };
        }

        // 3) 事实类优先于评价类（事实问题更明确）
        if (factMatch.score > 0) {
            return {
                intent: 'fact',
                confidence: this.toConfidence(factMatch.score),
                reasoning: '命中 fact 触发词',
                matchedTriggers: factMatch.matched,
            };
        }
        if (perspectiveMatch.score > 0) {
            return {
                intent: 'perspective',
                confidence: this.toConfidence(perspectiveMatch.score),
                reasoning: '命中 perspective 触发词',
                matchedTriggers: perspectiveMatch.matched,
                hybrid: false,
            };
        }

        // 4) 默认：事实检索（多数科研问题需要查库）
        return { intent: 'fact', confidence: 0.3, reasoning: '未命中明确触发词，默认按事实检索' };
    }

    /** 构建内部执行计划：是否启用 hybrid（用户不可见）。统一复用 classifyIntent 的判定结果，避免双套规则分叉 */
    buildExecutionPlan(route: IntentRouteResult, userInput: string): InternalExecutionPlan {
        // route.hybrid 由 classifyIntent 写入；外部构造的 route 缺省时按旧规则兜底重算
        const hybridActive =
            route.hybrid ??
            (route.intent === 'perspective' &&
                /(是什么|谁是|何时|多少|哪里|定义|概念|原理|公式|步骤)/.test(userInput.trim()) &&
                /[A-Za-z一-鿿]{2,}/.test(userInput.trim()));
        return {
            userFacingIntent: route.intent,
            internalStrategy: hybridActive ? 'hybrid' : 'single',
        };
    }

    /** 原始触发分（上限 3）归一化到 [0,1] 置信度 */
    private toConfidence(score: number): number {
        return Math.round((Math.min(score, 3) / 3) * 100) / 100;
    }

    /** 基于 triggers 计算命中分数与命中明细（关键词 +1，正则 +0.8，短输入阈值 +1.5） */
    private matchDetail(
        input: string,
        triggers: { keywords?: string[]; patterns?: string[]; input_length_threshold?: number | null },
    ): { score: number; matched: string[] } {
        let score = 0;
        const matched: string[] = [];
        for (const k of triggers.keywords || []) {
            if (input.includes(k)) {
                score += 1;
                matched.push(`keyword:${k}`);
            }
        }
        for (const p of triggers.patterns || []) {
            try {
                if (new RegExp(p).test(input)) {
                    score += 0.8;
                    matched.push(`pattern:${p}`);
                }
            } catch {
                /* 非法正则忽略 */
            }
        }
        if (triggers.input_length_threshold != null && input.length <= triggers.input_length_threshold) {
            score += 1.5;
            matched.push(`short_input<=${triggers.input_length_threshold}`);
        }
        return { score: Math.min(score, 3), matched };
    }
}

// ============================================================
// 纯函数：pendingConfirmation 状态机（R2）
// 调用方负责从 Redis 读取/写回 ClarifyState
// ============================================================

export function createClarifyState(clarificationId: string, inferredIntents: Array<{ text: string; confidence: number }>): ClarifyState {
    return {
        mode: 'pending_confirmation',
        setAt: Date.now(),
        clarificationId,
        inferredIntents,
        maxTurns: PENDING_MAX_TURNS,
        currentTurn: 0,
    };
}

export function isPendingExpired(state: ClarifyState): boolean {
    const elapsed = Date.now() - state.setAt;
    return elapsed > PENDING_TTL_MS || state.currentTurn >= state.maxTurns;
}

/**
 * 在 pendingConfirmation 状态下解析用户输入（不再重新触发 Clarify）。
 * 返回最终意图 + 解析后的查询，以及是否退出 pending。
 */
export function handlePendingConfirmation(
    userInput: string,
    state: ClarifyState,
): { intent: IntentType; resolvedQuery?: string; exitPending: boolean; reasoning: string } {
    const input = userInput.trim();

    // Case 1: 用户给出了具体问题
    if (input.length > 10 || /[?？]|什么|怎么|为什么|如何/.test(input)) {
        return { intent: 'fact', resolvedQuery: input, exitPending: true, reasoning: 'pending 下给出具体问题，正常处理' };
    }
    // Case 2: 纯确认词 → 映射最高置信度候选项
    if (/^(是|对|好的|没错|嗯|ok|OK|yes)$/.test(input)) {
        const top = state.inferredIntents[0];
        return {
            intent: 'fact',
            resolvedQuery: top?.text ?? input,
            exitPending: true,
            reasoning: '用户确认，映射到最高置信度候选项',
        };
    }
    // Case 3: 否定/选择 → 映射第二候选项
    if (/^(不是|不对|另一个|或者|第.*个)$/.test(input)) {
        const second = state.inferredIntents[1];
        if (second) {
            return { intent: 'fact', resolvedQuery: second.text, exitPending: true, reasoning: '用户否定第一选项，映射到第二候选项' };
        }
        return { intent: 'clarify', exitPending: true, reasoning: '无第二候选项，再次澄清' };
    }
    // Case 4: 其他短输入 → 降级为 normal，不再触发 clarify
    return { intent: 'fact', resolvedQuery: input, exitPending: true, reasoning: 'pending 下降级为 normal 处理' };
}

// ============================================================
// 纯函数：Fact 连续 Fallback 熔断（P4）
// 作用域：调用方按 kbId + userId 维护计数器
// ============================================================

export function onFactResult(
    hasFactualBasis: boolean,
    counter: FallbackCounter,
): { counter: FallbackCounter; action: 'allow' | 'reject'; consecutiveCount: number } {
    // 任何一次成功命中 → 计数器归零
    if (hasFactualBasis) {
        return { counter: { count: 0, lastResetAt: Date.now() }, action: 'allow', consecutiveCount: 0 };
    }
    const newCount = counter.count + 1;
    // 第 3 次（超过上限）直接拒绝
    if (newCount > MAX_CONSECUTIVE_FALLBACKS) {
        return { counter: { count: newCount, lastResetAt: Date.now() }, action: 'reject', consecutiveCount: newCount };
    }
    return { counter: { count: newCount, lastResetAt: Date.now() }, action: 'allow', consecutiveCount: newCount };
}
