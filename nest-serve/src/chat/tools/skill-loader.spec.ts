import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillLoader } from './skill-loader';

describe('SkillLoader · 真实 skill 目录', () => {
  let loader: SkillLoader;

  beforeAll(async () => {
    loader = new SkillLoader(__dirname); // spec 与 .skill.md 同目录
    await loader.loadAllMetas();
  });

  it('4 个核心 skill 全部以 ok 状态加载', () => {
    const health = loader.getHealthReport();
    expect(health.totalSkills).toBe(4);
    expect(health.loadedOk).toBe(4);
    expect(health.degraded).toBe(0);
  });

  it('元数据包含 triggers / ragBinding / tokenBudget 等第一层信息', () => {
    const clarify = loader.getSkill('clarify');
    expect(clarify).toBeDefined();
    expect(clarify!.triggers.keywords).toContain('然后呢');
    expect(clarify!.ragBinding).toBe('none');
    const fact = loader.getSkill('fact_retriever');
    expect(fact!.ragBinding).toBe('strong');
  });

  it('getAllMetas 不泄露 Markdown 正文（渐进式披露：路由层只读 YAML 头）', () => {
    const metas = loader.getAllMetas();
    expect(metas.length).toBe(4);
    for (const m of metas) {
      expect(m.promptInstructions).toBeUndefined();
      expect(m.triggers).toBeDefined();
    }
  });

  it('loadFullPrompt 按需返回第二层完整 Prompt 正文', async () => {
    const prompt = await loader.loadFullPrompt('clarify');
    expect(prompt).toContain('模糊意图澄清');
    expect(prompt).toContain('pendingConfirmation');
  });

  it('loadFullPrompt 对不存在的 skill 抛错', async () => {
    await expect(loader.loadFullPrompt('not_exist')).rejects.toThrow('Skill not found');
  });

  it('getRawConfig 读取扩展配置块', () => {
    const retrieval = loader.getRawConfig<{ top_k: number; rerank_threshold: number }>('fact_retriever', 'retrieval_config');
    expect(retrieval?.top_k).toBe(3);
    expect(retrieval?.rerank_threshold).toBe(0.75);
    const dimension = loader.getRawConfig<{ max_dimensions: number; sub_agent_timeout_ms: number }>(
      'perspective_analyzer',
      'dimension_config',
    );
    expect(dimension?.max_dimensions).toBe(4);
    expect(dimension?.sub_agent_timeout_ms).toBe(8000);
    const fallback = loader.getRawConfig<{ max_consecutive_fallbacks: number }>('fact_retriever', 'fallback_config');
    expect(fallback?.max_consecutive_fallbacks).toBe(2);
  });

  it('toToolSchema 将 parameters 转换为 OpenAI Tool Schema', () => {
    const fact = loader.getSkill('fact_retriever')!;
    const schema = loader.toToolSchema(fact);
    expect(schema.type).toBe('function');
    const fn = (schema as any).function;
    expect(fn.name).toBe('fact_retriever');
    const params = fn.parameters;
    expect(params.required).toContain('query');
    expect(params.properties.query.type).toBe('string');
    // array[string] → array + items
    expect(params.properties.entities.type).toBe('array');
    expect(params.properties.entities.items).toEqual({ type: 'string' });
    // enum 透传
    expect(params.properties.expected_answer_type.enum).toContain('definition');
  });
});

describe('SkillLoader · 容错降级（R5）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skill-loader-'));
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('单个文件 YAML 损坏 → 该 skill 降级为文件名推断配置，不影响其他 skill', async () => {
    writeFileSync(join(tempDir, 'clarify.skill.md'), '---\nname: clarify\ntriggers: [非法yaml: {{\n---\n正文');
    writeFileSync(
      join(tempDir, 'fact_retriever.skill.md'),
      '---\nname: fact_retriever\ncategory: rag_strong\ndescription: d\ntriggers:\n  keywords: ["是什么"]\nrag_binding: strong\n---\n正文',
    );
    const loader = new SkillLoader(tempDir);
    await loader.loadAllMetas();

    const clarify = loader.getSkill('clarify')!;
    expect(clarify.loadStatus).toBe('degraded');
    expect(clarify.triggers.keywords).toContain('然后呢'); // 文件名推断的保底触发词
    const fact = loader.getSkill('fact_retriever')!;
    expect(fact.loadStatus).toBe('ok');
  });

  it('核心 skill 文件缺失 → 自动注册内置降级配置，路由不裸奔', async () => {
    // 空目录：四个核心 skill 都缺失
    const loader = new SkillLoader(tempDir);
    await loader.loadAllMetas();

    const health = loader.getHealthReport();
    expect(health.totalSkills).toBe(4);
    expect(health.loadedOk).toBe(0);
    expect(health.degraded).toBe(4);
    // 降级配置仍带可用触发词与内置 Prompt
    expect(loader.getSkill('fact_retriever')!.triggers.keywords).toContain('是什么');
    await expect(loader.loadFullPrompt('perspective_analyzer')).resolves.toContain('多维评价分析助手');
  });

  it('技能目录不存在 → 仅使用内置降级配置，不抛错', async () => {
    const loader = new SkillLoader(join(tempDir, 'not-exist-dir'));
    await expect(loader.loadAllMetas()).resolves.toBeDefined();
    expect(loader.getHealthReport().totalSkills).toBe(4);
    expect(loader.getSkill('confidence_checker')!.loadStatus).toBe('degraded');
  });
});
