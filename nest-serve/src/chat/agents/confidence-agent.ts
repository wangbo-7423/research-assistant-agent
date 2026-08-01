import { Injectable } from '@nestjs/common';

// ============================================================
// 置信度检验 Agent（后处理中间件）
//
// 务实版（Phase 1-2）：基于命中数 / 出处完整性 / 跨源一致性 的
// 规则打分，返回 pass / warn / fail + 可执行的 recommended_action。
// 后续可接入 LLM 做语义级一致性判断（接口保持不变）。
// ============================================================

export interface RagResultItem {
    docId?: string;
    docTitle?: string;
    docText?: string;
    score?: number;
}

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

@Injectable()
export class ConfidenceAgent {
    /** 对一组 RAG 结果做置信度检验 */
    check(results: RagResultItem[], _originalQuestion: string, mode: 'strict' | 'normal' | 'relaxed' = 'normal'): ConfidenceCheckResult {
        const warnings: string[] = [];

        // 无命中 → fail
        if (!results || results.length === 0) {
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
        const withCitation = results.filter((r) => r.docTitle && r.docText).length;
        const citation_completeness = withCitation / results.length;
        if (citation_completeness < 1) warnings.push('citation_incomplete');

        // 来源可靠性：单源偏低，多源较高（务实启发式，非真实渠道校验）
        const distinctDocs = new Set(results.map((r) => r.docTitle || r.docId || 'unknown')).size;
        const source_reliability = distinctDocs >= 2 ? 0.85 : 0.6;
        if (source_reliability < 0.8) warnings.push('single_source');

        // 内容相关性：基于 rerank 近似分（无分则取中值）
        const scores = results.map((r) => (typeof r.score === 'number' ? r.score : 0.6));
        const content_relevance = scores.reduce((a, b) => a + b, 0) / scores.length;

        // 跨源一致性：多源一致假设 0.8，单源 0.6
        const cross_source_consistency = distinctDocs >= 2 ? 0.8 : 0.6;
        if (distinctDocs < 2) warnings.push('cross_source_unverified');

        const modeWeight = mode === 'strict' ? 1.1 : mode === 'relaxed' ? 0.9 : 1;
        const overall_confidence =
            (source_reliability * 0.25 +
                content_relevance * 0.3 +
                citation_completeness * 0.2 +
                cross_source_consistency * 0.25) *
            modeWeight;

        let check_result: 'pass' | 'warn' | 'fail';
        let recommended_action: ConfidenceCheckResult['recommended_action'];

        if (overall_confidence >= 0.8) {
            check_result = 'pass';
            recommended_action = { action: 'proceed', detail: '依据充分，正常输出', auto_executable: true };
        } else if (overall_confidence >= 0.5) {
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
        return stdDev > 0.15;
    }
}