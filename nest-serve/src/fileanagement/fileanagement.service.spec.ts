import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { FileanagementService } from './fileanagement.service';
import { Fileanagement } from './fileanagement.schema';

describe('FileanagementService - 混合检索', () => {
  let service: FileanagementService;
  const milvusMock = {
    hasCollection: jest.fn(),
    search: jest.fn(),
    query: jest.fn(),
  };
  const embeddingsCreateMock = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileanagementService,
        { provide: getModelToken(Fileanagement.name), useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ QWEN_API_KEY: 'test-key', QWEN_EMBEDDING_MODEL: 'text-embedding-v3' } as any)[key],
          },
        },
      ],
    }).compile();
    service = module.get(FileanagementService);
    // 替换内部 Milvus / OpenAI 客户端为 mock
    (service as any).milvusClient = milvusMock;
    (service as any).openai = { embeddings: { create: embeddingsCreateMock } };
  });

  it('embedQuery：对用户问题生成向量', async () => {
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] });
    const vec = await (service as any).embedQuery('高血压症状');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(embeddingsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-v3', input: '高血压症状' }),
    );
  });

  it('embedQuery：相同文本命中内存缓存，不再重复调用 API', async () => {
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.5, 0.5], index: 0 }] });
    await (service as any).embedQuery('缓存测试问题');
    await (service as any).embedQuery('缓存测试问题');
    await (service as any).embedQuery('缓存测试问题');
    expect(embeddingsCreateMock).toHaveBeenCalledTimes(1); // 只调一次，其余命中缓存
  });

  it('embedQuery：不同文本不共享缓存', async () => {
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.5, 0.5], index: 0 }] });
    await (service as any).embedQuery('问题A');
    await (service as any).embedQuery('问题B');
    expect(embeddingsCreateMock).toHaveBeenCalledTimes(2);
  });

  it('embedDocuments：超过 10 条时分批且保持顺序', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `文本${i}`);
    embeddingsCreateMock.mockImplementation(async ({ input }: any) => ({
      data: (Array.isArray(input) ? input : [input]).map((_: any, index: number) => ({
        embedding: [index],
        index,
      })),
    }));
    const vectors = await (service as any).embedDocuments(texts);
    expect(vectors).toHaveLength(12);
    // 第一批 10 条 + 第二批 2 条
    expect(embeddingsCreateMock).toHaveBeenCalledTimes(2);
  });

  it('extractKeywords：无 DeepSeek 配置时降级为规则提取，去停用词', async () => {
    // 测试环境未配置 DEEPSEEK_API_KEY，deepseek 为 null，自动走规则降级
    expect((service as any).deepseek).toBeNull();
    const kws = await (service as any).extractKeywords('请问高血压的症状有哪些');
    expect(kws.length).toBeGreaterThan(0);
    expect(kws).toContain('高血压');
    expect(kws).not.toContain('请问');
    expect(kws).not.toContain('哪些');
  });

  it('extractKeywords：DeepSeek 可用时优先用 LLM 提取并归一术语', async () => {
    const createMock = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '{"keywords":["腹泻","急性胃肠炎","止泻药"]}' } }],
    });
    (service as any).deepseek = { chat: { completions: { create: createMock } } };
    (service as any).deepseekModel = 'deepseek-chat';

    const kws = await (service as any).extractKeywords('我拉肚子好几天了吃什么药');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-chat', temperature: 0 }),
    );
    expect(kws).toEqual(['腹泻', '急性胃肠炎', '止泻药']);
  });

  it('extractKeywords：DeepSeek 返回直接数组格式也能解析', async () => {
    (service as any).deepseek = {
      chat: { completions: { create: jest.fn().mockResolvedValue({
        choices: [{ message: { content: '["高血压","降压药"]' } }],
      }) } },
    };
    const kws = await (service as any).extractKeywords('高血压吃什么药');
    expect(kws).toEqual(['高血压', '降压药']);
  });

  it('extractKeywords：DeepSeek 调用失败时降级为规则提取', async () => {
    (service as any).deepseek = {
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error('API 超时')) } },
    };
    jest.spyOn(console, 'warn').mockImplementation();

    const kws = await (service as any).extractKeywords('高血压的症状');
    expect(kws).toContain('高血压');
  });

  it('hybridSearch：向量与关键词结果做 RRF 融合，双路命中排最前', async () => {
    milvusMock.hasCollection.mockResolvedValue({ value: true });
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.1], index: 0 }] });

    // 向量检索：A(第1) B(第2)
    milvusMock.search.mockResolvedValue({
      results: [
        { docId: 'f1', docTitle: 'a.pdf', docText: '高血压的治疗', score: 0.95 },
        { docId: 'f1', docTitle: 'a.pdf', docText: '糖尿病的饮食', score: 0.80 },
      ],
    });
    // 关键词检索：B(第1) C(第1)
    milvusMock.query.mockResolvedValue({
      data: [
        { docId: 'f1', docTitle: 'a.pdf', docText: '糖尿病的饮食' },
        { docId: 'f2', docTitle: 'b.pdf', docText: '高血压并发症' },
      ],
    });

    const res = await service.hybridSearch('高血压怎么治疗', 'u1', 5);

    expect(res.fromVector).toBe(2);
    expect(res.fromKeyword).toBe(2);
    expect(res.results).toHaveLength(3);
    // B「糖尿病的饮食」双路命中，RRF 分数最高
    expect(res.results[0].docText).toBe('糖尿病的饮食');
    expect(res.results[0].hitVector).toBe(true);
    expect(res.results[0].hitKeyword).toBe(true);
    // 分数严格递减
    for (let i = 1; i < res.results.length; i++) {
      expect(res.results[i].rrfScore).toBeLessThanOrEqual(res.results[i - 1].rrfScore);
    }
  });

  it('hybridSearch：关键词检索失败时降级为纯向量检索', async () => {
    milvusMock.hasCollection.mockResolvedValue({ value: true });
    embeddingsCreateMock.mockResolvedValue({ data: [{ embedding: [0.1], index: 0 }] });
    milvusMock.search.mockResolvedValue({
      results: [{ docId: 'f1', docTitle: 'a.pdf', docText: '片段A', score: 0.9 }],
    });
    milvusMock.query.mockRejectedValue(new Error('LIKE 查询不支持'));
    jest.spyOn(console, 'warn').mockImplementation();

    const res = await service.hybridSearch('症状', 'u1', 5);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].docText).toBe('片段A');
  });

  it('hybridSearch：用户集合不存在时返回空结果而不报错', async () => {
    milvusMock.hasCollection.mockResolvedValue({ value: false });
    const res = await service.hybridSearch('任意问题', 'new-user', 5);
    expect(res).toEqual({ success: true, results: [], fromVector: 0, fromKeyword: 0 });
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });
});

describe('FileanagementService - rerank 响应解析（评测发现回归锁定）', () => {
  let service: FileanagementService;
  const globalFetch = global.fetch;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileanagementService,
        { provide: getModelToken(Fileanagement.name), useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ QWEN_API_KEY: 'test-key', QWEN_EMBEDDING_MODEL: 'text-embedding-v3' } as any)[key],
          },
        },
      ],
    }).compile();
    service = module.get(FileanagementService);
  });

  afterEach(() => {
    global.fetch = globalFetch;
  });

  it('qwen3-rerank 的 {object:list, results:[...]} 结构可解析（2026-08 实测返回结构）', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        object: 'list',
        results: [
          { index: 1, relevance_score: 0.81 },
          { index: 0, relevance_score: 0.22 },
        ],
        model: 'qwen3-rerank',
      }),
    }) as any;
    const out = await service.rerank('q', ['doc0', 'doc1'], 2);
    expect(out).not.toBeNull();
    expect(out).toEqual([
      { index: 1, score: 0.81 },
      { index: 0, score: 0.22 },
    ]);
  });

  it('兼容旧 gte-rerank-v2 的 output.results 结构', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: { results: [{ index: 0, relevance_score: 0.9 }] },
      }),
    }) as any;
    const out = await service.rerank('q', ['doc0'], 1);
    expect(out).toEqual([{ index: 0, score: 0.9 }]);
  });

  it('非 200 响应降级返回 null（不抛错）', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 }) as any;
    jest.spyOn(console, 'warn').mockImplementation();
    const out = await service.rerank('q', ['doc0'], 1);
    expect(out).toBeNull();
  });

  it('未知响应结构返回 null 降级', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ foo: 'bar' }) }) as any;
    const out = await service.rerank('q', ['doc0'], 1);
    expect(out).toBeNull();
  });
});
