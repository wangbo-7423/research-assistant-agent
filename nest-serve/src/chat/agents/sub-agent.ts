import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { FileanagementService } from '../../fileanagement/fileanagement.service';
import { SkillLoader } from '../tools/skill-loader';

// ============================================================
// 透视子 Agent（Perspective-Analyzer 专用）
//
// 职责：
//   1. splitDimensions  —— 轻量 LLM 将评价类问题拆为 2~4 个维度
//   2. retrieveDimension —— 每维度独立检索（hybridSearch），单维 token 预算浓缩
//   3. 并行执行 + 超时熔断（8s），先到的先返回
//
// 维度数量 / 超时 / 单维 token 预算以 perspective_analyzer skill 的
// dimension_config 为准，此处常量仅为 skill 缺失时的兜底默认值。
// 务实版：单维浓缩采用「截断 + 标记」方案（设计要求的 LLM 浓缩为后续增强）。
// ============================================================

export interface Dimension {
    name: string;
    query: string;
    weight?: number;
}

export interface DimensionResult {
    name: string;
    status: 'completed' | 'timeout' | 'empty' | 'error';
    sources: Array<{ doc_title: string; excerpt: string }>;
    rawText: string;
    confidence: number;
    summarized: boolean;
    note?: string;
}

export interface DimensionConfig {
    min_dimensions?: number;
    max_dimensions?: number;
    parallel_execution?: boolean;
    streaming_aggregation?: boolean;
    sub_agent_timeout_ms?: number;
    token_budget_per_dimension?: number;
    summarization_action?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TOKEN_BUDGET_PER_DIMENSION = 400; // 设计值
const DEFAULT_MIN_DIMENSIONS = 2;
const DEFAULT_MAX_DIMENSIONS = 4;
const CHAR_PER_TOKEN = 3; // 粗估

@Injectable()
export class PerspectiveAgent {
    private openai: OpenAI;
    private readonly textModel: string;

    constructor(
        private readonly fileanagementService: FileanagementService,
        private readonly configService: ConfigService,
        private readonly skillLoader: SkillLoader,
    ) {
        const qwenApiKey = this.configService.get<string>('QWEN_API_KEY');
        this.openai = new OpenAI({
            apiKey: qwenApiKey,
            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            timeout: 30000,
            maxRetries: 1,
        });
        this.textModel = this.configService.get<string>('QWEN_TEXT_MODEL') || 'qwen3.7-plus';
    }

    /** 维度配置：skill 文件为准，内置常量兜底 */
    private get dimensionConfig(): Required<Pick<DimensionConfig, 'min_dimensions' | 'max_dimensions' | 'sub_agent_timeout_ms' | 'token_budget_per_dimension' | 'summarization_action'>> {
        const cfg = this.skillLoader.getRawConfig<DimensionConfig>('perspective_analyzer', 'dimension_config') ?? {};
        return {
            min_dimensions: cfg.min_dimensions ?? DEFAULT_MIN_DIMENSIONS,
            max_dimensions: cfg.max_dimensions ?? DEFAULT_MAX_DIMENSIONS,
            sub_agent_timeout_ms: cfg.sub_agent_timeout_ms ?? DEFAULT_TIMEOUT_MS,
            token_budget_per_dimension: cfg.token_budget_per_dimension ?? DEFAULT_TOKEN_BUDGET_PER_DIMENSION,
            summarization_action: cfg.summarization_action ?? 'condense',
        };
    }

    /** 轻量拆解维度（不查库） */
    async splitDimensions(question: string): Promise<Dimension[]> {
        const { min_dimensions, max_dimensions } = this.dimensionConfig;
        try {
            const res = await this.openai.chat.completions.create({
                model: this.textModel,
                messages: [
                    {
                        role: 'system',
                        content:
                            `你是科研问答的维度拆解器。将用户的评价类问题拆解为 ${min_dimensions}~${max_dimensions} 个角度互不重叠的评价维度。` +
                            '每个维度都能转化为一个具体的事实检索问题。只输出 JSON 数组，格式：' +
                            '[{"name":"维度名","query":"该维度对应的检索问题","weight":0.8}]，不要输出任何其他内容。',
                    },
                    { role: 'user', content: question },
                ],
                temperature: 0,
                max_tokens: 400,
                response_format: { type: 'json_object' },
            });
            const raw = res.choices?.[0]?.message?.content?.trim() || '';
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
            const dims = list
                .filter((d: any) => d && typeof d.name === 'string' && typeof d.query === 'string')
                .slice(0, max_dimensions)
                .map((d: any) => ({ name: d.name, query: d.query, weight: typeof d.weight === 'number' ? d.weight : 0.7 }));
            if (dims.length >= min_dimensions) return dims;
        } catch (e) {
            console.warn('[PerspectiveAgent] 维度拆解失败，使用默认维度:', (e as Error).message);
        }
        // 兜底：通用二维度
        return [
            { name: '核心要点', query: `${question} 的核心要点与依据`, weight: 0.8 },
            { name: '局限与争议', query: `${question} 的局限、不足或不同观点`, weight: 0.6 },
        ];
    }

    /** 单维度检索 + 浓缩（带超时熔断；内部异常收敛为 error 状态，绝不向外 reject） */
    async retrieveDimension(dimension: Dimension, userId: string, _factContext?: string): Promise<DimensionResult> {
        const { sub_agent_timeout_ms } = this.dimensionConfig;
        // 关键健壮性：把 doRetrieve 包一层 catch，使其永远 resolve。
        // 这样即便某一维的 hybridSearch 抛错，Promise.race / Promise.all 也不会被拖垮，
        // 整条 perspective 链路能带着该维的 error 状态继续走完。
        const task = this.doRetrieve(dimension, userId).catch((err) => {
            console.warn('[PerspectiveAgent] 维度检索异常，降级为 error 状态:', dimension.name, (err as Error)?.message);
            return {
                name: dimension.name,
                status: 'error' as const,
                sources: [],
                rawText: '',
                confidence: 0,
                summarized: false,
                note: '该维度检索出错，已跳过',
            };
        });
        const timeout = new Promise<DimensionResult>((resolve) =>
            setTimeout(
                () =>
                    resolve({
                        name: dimension.name,
                        status: 'timeout',
                        sources: [],
                        rawText: '',
                        confidence: 0,
                        summarized: false,
                        note: '该维度检索超时，基于模型通用知识补充',
                    }),
                sub_agent_timeout_ms,
            ),
        );
        return Promise.race([task, timeout]);
    }

    private async doRetrieve(dimension: Dimension, userId: string): Promise<DimensionResult> {
        const searchRes = await this.fileanagementService.hybridSearch(dimension.query, userId, 3);
        const hits = searchRes.results || [];
        if (hits.length === 0) {
            return { name: dimension.name, status: 'empty', sources: [], rawText: '', confidence: 0, summarized: false };
        }
        const sources = hits.map((h) => ({ doc_title: h.docTitle || '未知文档', excerpt: h.docText }));
        const rawText = hits.map((h) => h.docText).join('\n\n');

        // 单维 token 预算浓缩：默认截断方案A；若 skill 配置 summarization_action=condense 则走 LLM 浓缩（方案B），失败降级回截断
        const budgetChars = this.dimensionConfig.token_budget_per_dimension * CHAR_PER_TOKEN;
        let condensed = rawText;
        let summarized = false;
        if (rawText.length > budgetChars) {
            summarized = true;
            if (this.dimensionConfig.summarization_action === 'condense') {
                condensed = await this.condense(dimension.name, rawText, budgetChars).catch(
                    () => rawText.slice(0, budgetChars) + '…（已截断浓缩）',
                );
            } else {
                condensed = rawText.slice(0, budgetChars) + '…（已截断浓缩）';
            }
        }

        // 置信度：用 rerank 近似分均值
        const scores = hits.map((h) => (typeof (h as any).rrfScore === 'number' ? (h as any).rrfScore : 0.6));
        const confidence = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;

        return { name: dimension.name, status: 'completed', sources, rawText: condensed, confidence, summarized };
    }

    /**
     * P5 单维 LLM 摘要浓缩（方案B）。
     * 在 8s 超时竞速之外单独调用轻量模型，保留核心论点/关键数据/来源标题/正反观点，丢弃冗余。
     * 调用失败（模型/网络）由调用方降级为截断方案A，不阻断主流程。
     */
    private async condense(dimensionName: string, rawText: string, budgetChars: number): Promise<string> {
        const res = await this.openai.chat.completions.create({
            model: this.textModel,
            messages: [
                {
                    role: 'system',
                    content:
                        `你是科研资料的摘要浓缩器。针对「${dimensionName}」维度，从给定资料中提取并保留：` +
                        '①核心论点；②关键数据/结论；③来源文档标题；④正反或不同观点。' +
                        `丢弃冗余铺垫、重复内容，输出不超过约 ${budgetChars} 字的中文摘要，保留可追溯的要点，不要编造未出现的信息。`,
                },
                { role: 'user', content: rawText },
            ],
            temperature: 0,
            max_tokens: Math.ceil(budgetChars / CHAR_PER_TOKEN) + 50,
        });
        const condensed = res.choices?.[0]?.message?.content?.trim() || '';
        return condensed ? condensed + '（已 LLM 摘要浓缩）' : rawText.slice(0, budgetChars) + '…（已截断浓缩）';
    }
}
