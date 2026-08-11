import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

// ============================================================
// 置信度检验 Agent（后处理中间件）
//
// 务实版（Phase 1-2）：基于命中数 / 出处完整性 / 跨源一致性 的
// 规则打分，返回 pass / warn / fail + 可执行的 recommended_action。
// 后续可接入 LLM 做语义级一致性判断（接口保持不变）。
//
// v2 复用化改造：
//   - 魔法数字全部外置为可注入的 ConfidenceConfig（缺省 = 原硬编码值，
//     对外行为完全不变），并计算 configHash 版本指纹，供 trace/评测回溯。
//   - 新增 normalizeResults() 输入收敛：校验 + 缺省填充，在线链路与
//     离线评测 runner 共用同一套输入处理。
// ============================================================

export interface RagResultItem {
    docId?: string;
    docTitle?: string;
    docText?: string;
    score?: number;
}

/** 置信度评分配置（全部可选，缺省用原硬编码默认值） */
export interface ConfidenceConfig {
    /** pass 阈值，overall_confidence >= 此值判 pass，默认 0.8 */
    passThreshold?: number;
    /** warn 阈值，>= 此值且 < pass 判 warn，默认 0.5 */
    warnThreshold?: number;
    /** 四维度权重，默认 { source:0.25, relevance:0.3, citation:0.2, consistency:0.25 } */
    weights?: {
        source_reliability?: number;
        content_relevance?: number;
        citation_completeness?: number;
        cross_source_consistency?: number;
    };
    /** 来源可靠性：单源 / 多源，默认 0.6 / 0.85 */
    singleSourceReliability?: number;
    multiSourceReliability?: number;
    /** 跨源一致性：单源 / 多源，默认 0.6 / 0.8 */
    singleSourceConsistency?: number;
    multiSourceConsistency?: number;
    /** 多源分歧判定：相关性分数标准差超过此值视为分歧，默认 0.15 */
    divergenceStdDev?: number;
    /** mode 加权：strict / normal / relaxed，默认 1.1 / 1 / 0.9 */
    modeWeights?: { strict?: number; normal?: number; relaxed?: number };
}

export type ResolvedConfidenceConfig = Required<Omit<ConfidenceConfig, 'weights' | 'modeWeights'>> & {
    weights: Required<NonNullable<ConfidenceConfig['weights']>>;
    modeWeights: Required<NonNullable<ConfidenceConfig['modeWeights']>>;
};

export interface ConfidenceCheckResult {
    check_result: 'pass' | 'warn' | 'fail';
    overall_confidence: number;
    dimension_scores: {
        source_reliability: number;
        content_relevance: number;
        citation_completeness: number;
        cross_source_consistency: number;
    };
    warnings: string[];
    recommended_action: {
        action: 'proceed' | 'annotate_with_uncertainty' | 'narrow_claim_scope' | 'highlight_conflict' | 'suggest_more_sources' | 'reject_or_fallback';
        detail: string;
        affected_dimensions?: string[];
        auto_executable: boolean;
        user_message?: string;
    };
}

/** 合并用户配置与默认值，得到完整解析配置（构造与 hash 共用） */
export function resolveConfidenceConfig(config: ConfidenceConfig = {}): ResolvedConfidenceConfig {
    return {
        passThreshold: config.passThreshold ?? 0.8,
        warnThreshold: config.warnThreshold ?? 0.5,
        weights: {
            source_reliability: config.weights?.source_reliability ?? 0.25,
            content_relevance: config.weights?.content_relevance ?? 0.3,
            citation_completeness: config.weights?.citation_completeness ?? 0.2,
            cross_source_consistency: config.weights?.cross_source_consistency ?? 0.25,
        },
        singleSourceReliability: config.singleSourceReliability ?? 0.6,
        multiSourceReliability: config.multiSourceReliability ?? 0.85,
        singleSourceConsistency: config.singleSourceConsistency ?? 0.6,
        multiSourceConsistency: config.multiSourceConsistency ?? 0.8,
        divergenceStdDev: config.divergenceStdDev ?? 0.15,
        modeWeights: {
            strict: config.modeWeights?.strict ?? 1.1,
            normal: config.modeWeights?.normal ?? 1,
            relaxed: config.modeWeights?.relaxed ?? 0.9,
        },
    };
}

/** 由完整解析配置计算版本指纹（sha256 前 12 位） */
export function computeConfigHash(config: ConfidenceConfig = {}): string {
    const resolved = resolveConfidenceConfig(config);
    const canonical = JSON.stringify(resolved);
    return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

@Injectable()
export class ConfidenceAgent {
    /** 解析后的完整配置 */
    readonly config: ResolvedConfidenceConfig;
    /** 配置版本指纹：同一行为必有同一 hash，供 trace / 评测结果回溯 */
    readonly configHash: string;

    constructor(config: ConfidenceConfig = {}) {
        this.config = resolveConfidenceConfig(config);
        this.configHash = computeConfigHash(config);
    }

    /**
     * 输入收敛：校验 + 缺省填充。
     * - 保留空数组（调用方据此判 fail）；
     * - score 缺省填 0.6（与原逻辑"无分则取中值"一致）；
     * - docText/docTitle 缺省保留 undefined，由 check() 内部逻辑处理。
     */
    static normalizeResults(results: RagResultItem[]): RagResultItem[] {
        return (results || []).map((r) => ({
            docId: r?.docId,
            docTitle: r?.docTitle,
            docText: r?.docText,
            score: typeof r?.score === 'number' ? r.score : 0.6,
        }));
    }

    /** 对一组 RAG 结果做置信度检验 */
    check(results: RagResultItem[], _originalQuestion: string, mode: 'strict' | 'normal' | 'relaxed' = 'normal'): ConfidenceCheckResult {
        const warnings: string[] = [];
        const normalized = ConfidenceAgent.normalizeResults(results);
        const cfg = this.config;

        // 无命中 → fail
        if (!normalized || normalized.length === 0) {
            return {
                check_result: 'fail',
                overall_confidence: 0,
                dimension_scores: {
                    source_reliability: 0,
                    content_relevance: 0,
                    citation_completeness: 0,
                    cross_source_consistency: 0,
                },
                warnings: ['no_results'],
                recommended_action: {
                    action: 'reject_or_fallback',
                    detail: '所有维度均无命中，无法支撑可靠分析',
                    auto_executable: true,
                    user_message: '现有资料不足以支撑对该问题的可靠分析。如果你有更多相关文档，可以上传后重新提问。',
                },
            };
        }

        // 出处完整性：是否都有标题 + 文本
        const withCitation = normalized.filter((r) => r.docTitle && r.docText).length;
        const citation_completeness = withCitation / normalized.length;
        if (citation_completeness < 1) warnings.push('citation_incomplete');

        // 来源可靠性：单源偏低，多源较高（务实启发式，非真实渠道校验）
        const distinctDocs = new Set(normalized.map((r) => r.docTitle || r.docId || 'unknown')).size;
        const source_reliability = distinctDocs >= 2 ? cfg.multiSourceReliability : cfg.singleSourceReliability;
        if (source_reliability < 0.8) warnings.push('single_source');

        // 内容相关性：基于 rerank 近似分（normalizeResults 已填充缺省 0.6）
        const scores = normalized.map((r) => (typeof r.score === 'number' ? r.score : 0.6));
        const content_relevance = scores.reduce((a, b) => a + b, 0) / scores.length;

        // 跨源一致性：多源一致假设 0.8，单源 0.6
        const cross_source_consistency = distinctDocs >= 2 ? cfg.multiSourceConsistency : cfg.singleSourceConsistency;
        if (distinctDocs < 2) warnings.push('cross_source_unverified');

        const modeWeight = mode === 'strict' ? cfg.modeWeights.strict : mode === 'relaxed' ? cfg.modeWeights.relaxed : cfg.modeWeights.normal;
        const overall_confidence =
            (source_reliability * cfg.weights.source_reliability +
                content_relevance * cfg.weights.content_relevance +
                citation_completeness * cfg.weights.citation_completeness +
                cross_source_consistency * cfg.weights.cross_source_consistency) *
            modeWeight;

        let check_result: 'pass' | 'warn' | 'fail';
        let recommended_action: ConfidenceCheckResult['recommended_action'];

        if (overall_confidence >= cfg.passThreshold) {
            check_result = 'pass';
            recommended_action = { action: 'proceed', detail: '依据充分，正常输出', auto_executable: true };
        } else if (overall_confidence >= cfg.warnThreshold) {
            check_result = 'warn';
            // 根据命中的薄弱维度挑选具体可执行动作（R3）：单一来源 / 引用不完整 / 多源分歧 / 普遍偏弱
            if (distinctDocs < 2) {
                recommended_action = {
                    action: 'suggest_more_sources',
                    detail: '支撑结论的来源仅 1 个，建议补充更多文档',
                    affected_dimensions: ['整体'],
                    auto_executable: true,
                    user_message: '目前支撑该结论的来源比较单一，建议上传更多相关文档以获得更全面的分析。',
                };
            } else if (citation_completeness < 1) {
                recommended_action = {
                    action: 'narrow_claim_scope',
                    detail: '部分引用信息不完整，建议收窄断言范围',
                    affected_dimensions: ['整体'],
                    auto_executable: true,
                    user_message: '部分论点缺乏完整引用出处，相关论断已尽量收窄表述范围，请以原始文献为准。',
                };
            } else if (this.hasDivergence(scores)) {
                recommended_action = {
                    action: 'highlight_conflict',
                    detail: '多来源在相关论点上存在分歧',
                    affected_dimensions: ['整体'],
                    auto_executable: true,
                    user_message: '不同来源在相关论点上存在分歧，请交叉核对原始文献后再下结论。',
                };
            } else {
                recommended_action = {
                    action: 'annotate_with_uncertainty',
                    detail: '部分论点文献支撑较弱，建议在相关论段加不确定性标注',
                    affected_dimensions: ['整体'],
                    auto_executable: true,
                };
            }
        } else {
            check_result = 'fail';
            recommended_action = {
                action: 'reject_or_fallback',
                detail: '整体置信度低于阈值，建议降级或拒绝',
                auto_executable: true,
                user_message: '现有资料不足以支撑对该问题的可靠分析。如果你有更多相关文档，可以上传后重新提问。',
            };
        }

        return {
            check_result,
            overall_confidence: Math.round(overall_confidence * 100) / 100,
            dimension_scores: {
                source_reliability: Math.round(source_reliability * 100) / 100,
                content_relevance: Math.round(content_relevance * 100) / 100,
                citation_completeness: Math.round(citation_completeness * 100) / 100,
                cross_source_consistency: Math.round(cross_source_consistency * 100) / 100,
            },
            warnings,
            recommended_action,
        };
    }

    /**
     * 多源分歧启发式（务实版，非语义级）：
     * 当存在 ≥2 个来源且各来源相关性打分离散度较高时，视为「来源间可能存在分歧」的代理信号，
     * 触发 highlight_conflict 动作。后续可替换为 LLM 语义一致性判断（接口不变）。
     */
    private hasDivergence(scores: number[]): boolean {
        if (scores.length < 2) return false;
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
        const stdDev = Math.sqrt(variance);
        return stdDev > this.config.divergenceStdDev;
    }
}
