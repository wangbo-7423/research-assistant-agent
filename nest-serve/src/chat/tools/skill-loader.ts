import { Injectable, Optional } from '@nestjs/common';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as yamlParse } from 'yaml';
import { ChatCompletionTool } from 'openai/resources/chat/completions';

// ============================================================
// Skill 加载器 · 渐进式披露（Anthropic Skill 模型）
//
// 第一层（启动时加载）：YAML 头信息 —— 路由层只读这部分，约 200 tokens
// 第二层（调用时加载）：Markdown 正文 —— 作为完整 Prompt 注入
//
// 容错原则（R5）：
//   单点故障隔离 → 一个 skill 文件损坏不影响其他 skill
//   永不崩溃     → YAML 解析失败 → 降级到文件名推断配置 → 再失败 → 内置 Prompt
//   可观测性     → 所有降级事件记录日志 + 健康检查可查询
// ============================================================

export type RagBinding = 'none' | 'strong' | 'loose';
export type SkillCategory = 'intent_router' | 'rag_strong' | 'rag_loose' | 'post_process';
export type SkillLoadStatus = 'ok' | 'degraded' | 'failed';

export interface TriggerConfig {
    keywords?: string[];
    patterns?: string[];
    input_length_threshold?: number | null;
    trigger_mode?: 'automatic' | 'manual';
    invoke_condition?: string;
}

export interface ParameterSchema {
    name: string;
    type: string;
    required: boolean;
    description: string;
    enum?: string[];
}

export interface SkillMeta {
    name: string;
    version?: string;
    category: SkillCategory;
    description: string;
    triggers: TriggerConfig;
    ragBinding: RagBinding;
    maxRecursionDepth: number;
    tokenBudget: number;
    parameters: ParameterSchema[];
    /** 解析出的额外配置块（retrieval_config / dimension_config / fallback_config 等） */
    raw: Record<string, any>;
    /** 第二层：完整 Prompt 正文（懒加载，调用时才读取） */
    promptInstructions?: string;
    // —— 容错字段 ——
    loadStatus: SkillLoadStatus;
    parseWarnings: string[];
    fallbackTriggers?: TriggerConfig;
}

export interface SkillLoaderHealthReport {
    totalSkills: number;
    loadedOk: number;
    degraded: number;
    failed: number;
    details: Array<{ name: string; status: SkillLoadStatus; warnings: string[] }>;
}

@Injectable()
export class SkillLoader {
    /** 四工具架构的核心 skill：缺失时自动降级注册，保证路由永不裸奔（R5） */
    private static readonly CORE_SKILLS = ['clarify', 'fact_retriever', 'perspective_analyzer', 'confidence_checker'];

    private skills: Map<string, SkillMeta> = new Map();
    private fallbackRegistry: Map<string, SkillMeta> = new Map();
    private readonly skillDir: string;

    // 注意：skillDir 是可选参数。若写成裸的 `constructor(skillDir?: string)`，
    // NestJS 的 reflect-metadata 会把 String 当作注入 token，因 ChatModule
    // 未提供该 provider 而抛 UnknownDependenciesException。加 @Optional() 后，
    // 运行时（Nest DI）找不到 String provider 就注入 undefined，自动回落到
    // 环境变量 / resolveSkillDir()；而 spec 里的 `new SkillLoader(dir)` 直接构造，
    // 仍会把 dir 作为首个参数传入，测试行为不变。
    constructor(@Optional() skillDir?: string) {
        // 优先级：显式传入 > 环境变量 > 自动探测（兼容 dev / 编译后 / 资源拷贝多种部署形态）
        this.skillDir = skillDir || process.env.SKILL_DIR || this.resolveSkillDir();
    }

    /** 探测 skill 目录：依次尝试开发态、编译态、资源拷贝态、__dirname 同目录 */
    private resolveSkillDir(): string {
        const candidates = [
            join(process.cwd(), 'src', 'chat', 'tools'),
            join(process.cwd(), 'dist', 'src', 'chat', 'tools'),
            join(process.cwd(), 'dist', 'chat', 'tools'),
            join(__dirname),
            join(__dirname, '..', 'tools'),
        ];
        for (const c of candidates) {
            if (existsSync(c)) return c;
        }
        return candidates[0];
    }

    /** 启动时加载所有 skill 的元数据（约 50ms，不阻塞服务） */
    async loadAllMetas(): Promise<Map<string, SkillMeta>> {
        if (!existsSync(this.skillDir)) {
            console.warn(`[SkillLoader] 技能目录不存在: ${this.skillDir}，将仅使用内置降级 Prompt`);
            this.ensureCoreSkills();
            return this.skills;
        }
        const files = readdirSync(this.skillDir).filter((f) => f.endsWith('.skill.md'));
        for (const file of files) {
            const fullPath = join(this.skillDir, file);
            const skillName = file.replace('.skill.md', '');
            try {
                const raw = readFileSync(fullPath, 'utf-8');
                const meta = this.parseSkillFile(raw, skillName);
                this.skills.set(meta.name, meta);
            } catch (error) {
                // 单文件解析失败 → 降级，不影响整体
                console.warn(`[SkillLoader] 解析 ${file} 失败:`, (error as Error).message);
                this.registerFallback(skillName, error as Error);
            }
        }
        this.ensureCoreSkills();
        return this.skills;
    }

    /**
     * 核心容错（R5）：核心 skill 文件缺失时（目录空、文件被删、命名不符），
     * 用内置降级配置补齐，保证意图路由始终有 triggers 可用。
     */
    private ensureCoreSkills(): void {
        for (const name of SkillLoader.CORE_SKILLS) {
            if (!this.skills.has(name)) {
                console.warn(`[SkillLoader] 核心 skill "${name}" 缺失，注册内置降级配置`);
                this.registerFallback(name, new Error('skill 文件缺失'));
            }
        }
    }

    /** 解析 .skill.md：拆分 YAML 头 + Markdown 正文 */
    private parseSkillFile(raw: string, skillName: string): SkillMeta {
        const warnings: string[] = [];
        const { frontmatter, body } = this.splitFrontmatter(raw);

        let parsed: any;
        try {
            parsed = yamlParse(frontmatter) as any;
        } catch (e) {
            throw new Error(`YAML 解析失败: ${(e as Error).message}`);
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('YAML 为空或不是对象');
        }

        const meta: SkillMeta = {
            name: parsed.name ?? skillName,
            version: parsed.version,
            category: parsed.category,
            description: parsed.description ?? '',
            triggers: parsed.triggers ?? {},
            ragBinding: parsed.rag_binding ?? 'none',
            maxRecursionDepth: parsed.max_recursion_depth ?? 0,
            tokenBudget: parsed.token_budget ?? 500,
            parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
            raw: parsed,
            promptInstructions: body.trim(),
            loadStatus: 'ok',
            parseWarnings: warnings,
        };

        const validation = this.validateSchema(meta);
        if (!validation.ok) {
            // 字段缺失 → 仍可用，但标记降级并告警
            meta.loadStatus = 'degraded';
            meta.parseWarnings.push(...validation.errors);
            console.warn(`[SkillLoader] skill "${meta.name}" schema 不完整: ${validation.errors.join('; ')}`);
        } else if (validation.warnings.length > 0) {
            meta.parseWarnings.push(...validation.warnings);
        }
        return meta;
    }

    /** 拆分 YAML frontmatter 与正文 */
    private splitFrontmatter(raw: string): { frontmatter: string; body: string } {
        const lines = raw.split('\n');
        if (lines[0]?.trim() !== '---') {
            throw new Error('缺少 YAML 头（应以 --- 开头）');
        }
        // 找到下一个 --- 作为头结束
        let end = -1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
                end = i;
                break;
            }
        }
        if (end === -1) throw new Error('未找到 YAML 头结束标记 ---');
        const frontmatter = lines.slice(1, end).join('\n');
        const body = lines.slice(end + 1).join('\n');
        return { frontmatter, body };
    }

    /** Schema 校验（启动时 + 热更新时） */
    private validateSchema(meta: SkillMeta): { ok: boolean; errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];
        if (!meta.name) errors.push('name is required');
        if (!meta.triggers || Object.keys(meta.triggers).length === 0) {
            warnings.push('No triggers defined - this skill may never be invoked');
        }
        // triggers 下出现非白名单字段 → 通常是顶级字段缩进错误被嵌套进了 triggers
        const knownTriggerKeys = ['keywords', 'patterns', 'input_length_threshold', 'trigger_mode', 'invoke_condition'];
        const nestedKeys = Object.keys(meta.triggers || {}).filter((k) => !knownTriggerKeys.includes(k));
        if (nestedKeys.length > 0) {
            warnings.push(`triggers 包含未知字段: ${nestedKeys.join(', ')}（可能是顶级字段缩进错误，被错误嵌套进 triggers）`);
        }
        if (!['none', 'strong', 'loose'].includes(meta.ragBinding)) {
            errors.push(`ragBinding must be one of none|strong|loose, got: ${meta.ragBinding}`);
        }
        const validCategories = ['intent_router', 'rag_strong', 'rag_loose', 'post_process'];
        if (!validCategories.includes(meta.category)) {
            warnings.push(`category "${meta.category}" 非标准，已忽略`);
        }
        if (meta.tokenBudget > 4000) {
            warnings.push(`tokenBudget ${meta.tokenBudget} 超过推荐上限 4000`);
        }
        return { ok: errors.length === 0, errors, warnings };
    }

    /** 核心容错：YAML 解析失败时的降级策略（R5） */
    private registerFallback(skillName: string, error: Error): void {
        const inferred = this.inferTriggersFromFileName(skillName);
        const builtin = this.inferBuiltinPrompt(skillName);
        const meta: SkillMeta = {
            name: skillName,
            category: inferred.category,
            description: `${skillName} (降级模式)`,
            triggers: inferred.triggers,
            ragBinding: inferred.ragBinding,
            maxRecursionDepth: 0,
            tokenBudget: 500,
            parameters: [],
            raw: {},
            promptInstructions: builtin,
            loadStatus: 'degraded',
            parseWarnings: [`YAML解析失败: ${error.message}，使用从文件名推断的降级配置`],
            fallbackTriggers: inferred.triggers,
        };
        this.fallbackRegistry.set(skillName, meta);
        this.skills.set(skillName, meta);
    }

    /** 从文件名反推基础触发规则（保底，不精确但可用） */
    private inferTriggersFromFileName(fileName: string): {
        triggers: TriggerConfig;
        ragBinding: RagBinding;
        category: SkillCategory;
    } {
        const ruleMap: Record<string, { triggers: TriggerConfig; ragBinding: RagBinding; category: SkillCategory }> = {
            clarify: {
                triggers: {
                    keywords: ['然后呢', '咋整', '所以呢', '接下来', '还有吗'],
                    patterns: ['^.{0,5}$'],
                    input_length_threshold: 5,
                },
                ragBinding: 'none',
                category: 'intent_router',
            },
            fact_retriever: {
                triggers: {
                    keywords: ['是什么', '谁是', '什么时候', '多少', '哪里', '原理', '概念', '公式'],
                    patterns: ['(是什么|谁是|何时)'],
                },
                ragBinding: 'strong',
                category: 'rag_strong',
            },
            perspective_analyzer: {
                triggers: {
                    keywords: ['怎么看', '你认为', '意味着', '评价', '优缺点', '影响', '对比', '分析'],
                    patterns: ['(你怎么看|你认为|你觉得)'],
                },
                ragBinding: 'loose',
                category: 'rag_loose',
            },
            confidence_checker: {
                triggers: { trigger_mode: 'automatic', invoke_condition: 'after_any_rag_call' },
                ragBinding: 'none',
                category: 'post_process',
            },
        };
        return (
            ruleMap[fileName] || {
                triggers: { keywords: [], patterns: [] },
                ragBinding: 'none',
                category: 'intent_router',
            }
        );
    }

    /** 内置降级 Prompt（每个 skill 一个最小可用版本） */
    private inferBuiltinPrompt(skillName: string): string {
        const builtin: Record<string, string> = {
            clarify: '你是意图澄清助手。当用户输入模糊或过短时，基于上下文生成自然语言反问。必须从上下文已有实体中派生候选项，不得引入新实体。',
            fact_retriever: '你是事实检索助手。针对事实类问题执行高精度检索。只返回高置信度结果(Top3)，每条必须附原文出处。',
            perspective_analyzer: '你是多维评价分析助手。将评价类问题拆解为2~4个维度，每维度独立检索后整合输出。',
            confidence_checker: '你是置信度检验助手。检验RAG结果是否有事实依据支撑，返回可执行的行动建议。',
        };
        return builtin[skillName] || '请根据用户问题提供帮助。';
    }

    /** 按需加载单个 skill 的完整 Prompt（第二层） */
    async loadFullPrompt(skillName: string): Promise<string> {
        const meta = this.skills.get(skillName);
        if (!meta) throw new Error(`Skill not found: ${skillName}`);
        if (meta.loadStatus === 'degraded') {
            return meta.promptInstructions || this.inferBuiltinPrompt(skillName);
        }
        return meta.promptInstructions || '';
    }

    getSkill(name: string): SkillMeta | undefined {
        return this.skills.get(name);
    }

    /**
     * 路由层专用：只暴露第一层元数据（YAML 头），剥离 Markdown 正文。
     * 渐进式披露原则——路由分类只需要 triggers 等轻量信息，
     * 完整 Prompt 仅在真正调用该 skill 时通过 loadFullPrompt 获取。
     */
    getAllMetas(): SkillMeta[] {
        return [...this.skills.values()].map((s) => ({ ...s, promptInstructions: undefined }));
    }

    /** 读取 skill 的扩展配置块（retrieval_config / dimension_config / fallback_config 等） */
    getRawConfig<T = Record<string, any>>(skillName: string, key: string): T | undefined {
        return this.skills.get(skillName)?.raw?.[key] as T | undefined;
    }

    /** 将 skill 元数据转换为 OpenAI Tool Schema */
    toToolSchema(meta: SkillMeta): ChatCompletionTool {
        const properties: Record<string, any> = {};
        const required: string[] = [];
        for (const p of meta.parameters || []) {
            properties[p.name] = {
                type: p.type.startsWith('array') ? 'array' : p.type,
                description: p.description,
            };
            if (p.type.startsWith('array')) {
                properties[p.name].items = { type: 'string' };
            }
            if (p.enum) properties[p.name].enum = p.enum;
            if (p.required) required.push(p.name);
        }
        return {
            type: 'function',
            function: {
                name: meta.name,
                description: meta.description || `${meta.name} tool`,
                parameters: {
                    type: 'object',
                    properties,
                    required,
                },
            },
        };
    }

    /** 健康检查接口（供运维/监控使用） */
    getHealthReport(): SkillLoaderHealthReport {
        const all = [...this.skills.values()];
        return {
            totalSkills: all.length,
            loadedOk: all.filter((s) => s.loadStatus === 'ok').length,
            degraded: all.filter((s) => s.loadStatus === 'degraded').length,
            failed: 0, // 失败的也已降级为 degraded，故这里恒为 0
            details: all.map((s) => ({ name: s.name, status: s.loadStatus, warnings: s.parseWarnings })),
        };
    }
}
