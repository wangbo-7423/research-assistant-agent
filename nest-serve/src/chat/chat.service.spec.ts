import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ChatService } from './chat.service';
import { ChatData } from './chat.schema';
import { Fileanagement } from '../fileanagement/fileanagement.schema';
import { ConfigService } from '@nestjs/config';
import { FileanagementService } from '../fileanagement/fileanagement.service';
import { SkillLoader } from './tools/skill-loader';
import { IntentRouter } from './routers/intent-router';
import { PerspectiveAgent } from './agents/sub-agent';
import { ConfidenceAgent } from './agents/confidence-agent';

describe('ChatService', () => {
  let service: ChatService;
  const redisMock = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const fileModelMock = { find: jest.fn() };
  const chatModelMock = { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), updateOne: jest.fn() };
  const configMock = {
    get: jest.fn((key: string) => (key === 'RAG_REFACTOR_ENABLED' ? 'true' : 'test-qwen-key')),
  };
  const fileServiceMock = { hybridSearch: jest.fn(), preciseSearch: jest.fn() };
  const skillLoaderMock = {
    loadAllMetas: jest.fn().mockResolvedValue(new Map()),
    getHealthReport: jest.fn().mockReturnValue({ totalSkills: 0, loadedOk: 0, degraded: 0, failed: 0, details: [] }),
    loadFullPrompt: jest.fn().mockResolvedValue('你是意图澄清助手'),
    getSkill: jest.fn(),
    getRawConfig: jest.fn().mockReturnValue(undefined),
  };
  const intentRouterMock = {
    classifyIntent: jest.fn(),
    buildExecutionPlan: jest.fn().mockReturnValue({ userFacingIntent: 'fact', internalStrategy: 'single' }),
  };
  const perspectiveAgentMock = { splitDimensions: jest.fn(), retrieveDimension: jest.fn() };
  const confidenceAgentMock = {
    check: jest.fn().mockReturnValue({
      check_result: 'pass',
      overall_confidence: 0.9,
      dimension_scores: {},
      warnings: [],
      recommended_action: { action: 'proceed', detail: '', auto_executable: true },
    }),
  };
  const streamMock = { write: jest.fn(), end: jest.fn() } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    chatModelMock.create.mockResolvedValue({ _id: new Types.ObjectId() });
    chatModelMock.updateOne.mockResolvedValue({ acknowledged: true });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getModelToken(Fileanagement.name), useValue: fileModelMock },
        { provide: getModelToken(ChatData.name), useValue: chatModelMock },
        { provide: 'default_IORedisModuleConnectionToken', useValue: redisMock },
        { provide: ConfigService, useValue: configMock },
        { provide: FileanagementService, useValue: fileServiceMock },
        { provide: SkillLoader, useValue: skillLoaderMock },
        { provide: IntentRouter, useValue: intentRouterMock },
        { provide: PerspectiveAgent, useValue: perspectiveAgentMock },
        { provide: ConfidenceAgent, useValue: confidenceAgentMock },
      ],
    }).compile();
    service = module.get(ChatService);
    // 默认让模型正常返回一条助手回复，避免真实调用大模型
    jest.spyOn(service, 'modelResult').mockResolvedValue({ role: 'assistant', content: '助手回复' });
  });

  it('新会话（sessionId=null）时直接以当前消息开启历史，不查历史库', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    await service.combineConvo(
      new Types.ObjectId(),
      'null',
      '你好',
      undefined,
      streamMock,
      undefined,
      undefined,
    );
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(chatModelMock.find).not.toHaveBeenCalled();
    const logged = JSON.parse(logSpy.mock.calls[1][0]);
    expect(logged).toEqual([expect.objectContaining({ role: 'user', content: '你好' })]);
    logSpy.mockRestore();
  });

  it('新会话先把用户消息写入mongodb生成会话id，回复后追加助手消息并刷新redis', async () => {
    jest.spyOn(console, 'log').mockImplementation();
    const userId = new Types.ObjectId();
    const newSessionId = new Types.ObjectId();
    chatModelMock.create.mockResolvedValue({ _id: newSessionId });
    await service.combineConvo(userId, 'null', '你好', undefined, streamMock, undefined, undefined);
    // 1. 创建会话文档，chatList含首条用户消息
    expect(chatModelMock.create).toHaveBeenCalledWith({
      userId,
      chatList: [expect.objectContaining({ role: 'user', content: '你好' })],
    });
    // 2. 新会话id通过流推给前端
    const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
    expect(writes.some((w: string) => w.includes('sessionId') && w.includes(newSessionId.toString()))).toBe(true);
    // 3. 回复完成后只追加助手消息（用户消息已随创建写入）
    expect(chatModelMock.updateOne).toHaveBeenCalledWith(
      { _id: newSessionId, userId },
      { $push: { chatList: { $each: [{ role: 'assistant', content: '助手回复' }] } } },
    );
    // 4. redis缓存完整对话，3小时过期
    const setCall = redisMock.set.mock.calls.find(
      (c: any[]) => c[0] === `chat_history:${userId}:${newSessionId}`,
    );
    expect(setCall).toBeDefined();
    expect(setCall[2]).toBe('EX');
    expect(setCall[3]).toBe(10800);
    expect(JSON.parse(setCall[1])).toEqual([
      expect.objectContaining({ role: 'user', content: '你好' }),
      { role: 'assistant', content: '助手回复' },
    ]);
    jest.restoreAllMocks();
  });

  it('已有会话且 redis 命中时使用缓存历史', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify([{ role: 'user', content: '旧消息' }]));
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const sessionId = new Types.ObjectId().toString();
    await service.combineConvo(
      new Types.ObjectId(),
      sessionId as any,
      '新消息',
      undefined,
      streamMock,
      undefined,
      undefined,
    );
    expect(chatModelMock.find).not.toHaveBeenCalled();
    const logged = JSON.parse(logSpy.mock.calls[1][0]);
    expect(logged).toEqual([
      { role: 'user', content: '旧消息' },
      expect.objectContaining({ content: '新消息' }),
    ]);
    logSpy.mockRestore();
  });

  it('已有会话回复后把用户消息和助手回复一起追加到mongodb', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify([{ role: 'user', content: '旧消息' }]));
    jest.spyOn(console, 'log').mockImplementation();
    const userId = new Types.ObjectId();
    const sessionId = new Types.ObjectId().toString();
    await service.combineConvo(userId, sessionId as any, '新消息', undefined, streamMock, undefined, undefined);
    expect(chatModelMock.updateOne).toHaveBeenCalledWith(
      { _id: sessionId, userId },
      {
        $push: {
          chatList: {
            $each: [
              expect.objectContaining({ role: 'user', content: '新消息' }),
              { role: 'assistant', content: '助手回复' },
            ],
          },
        },
      },
    );
    // redis缓存被刷新为完整对话（含助手回复）
    const setCall = redisMock.set.mock.calls.find(
      (c: any[]) => c[0] === `chat_history:${userId}:${sessionId}`,
    );
    expect(JSON.parse(setCall[1])).toEqual([
      { role: 'user', content: '旧消息' },
      expect.objectContaining({ role: 'user', content: '新消息' }),
      { role: 'assistant', content: '助手回复' },
    ]);
    jest.restoreAllMocks();
  });

  it('模型没有产出回复时仍保留用户消息，不写入空助手消息', async () => {
    (service.modelResult as jest.Mock).mockResolvedValue(undefined);
    redisMock.get.mockResolvedValue(JSON.stringify([]));
    jest.spyOn(console, 'log').mockImplementation();
    const userId = new Types.ObjectId();
    const sessionId = new Types.ObjectId().toString();
    await service.combineConvo(userId, sessionId as any, '新消息', undefined, streamMock, undefined, undefined);
    expect(chatModelMock.updateOne).toHaveBeenCalledWith(
      { _id: sessionId, userId },
      {
        $push: {
          chatList: {
            $each: [expect.objectContaining({ role: 'user', content: '新消息' })],
          },
        },
      },
    );
    jest.restoreAllMocks();
  });

  it('mongodb写入失败时不影响对话流程，仅记录日志', async () => {
    chatModelMock.updateOne.mockRejectedValue(new Error('mongo挂了'));
    redisMock.get.mockResolvedValue(JSON.stringify([]));
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    await expect(
      service.combineConvo(
        new Types.ObjectId(),
        new Types.ObjectId().toString() as any,
        '新消息',
        undefined,
        streamMock,
        undefined,
        undefined,
      ),
    ).resolves.toBeUndefined();
    expect(logSpy.mock.calls.some((c) => c[0] === '对话记录持久化失败')).toBe(true);
    logSpy.mockRestore();
  });

  it('redis 未命中且 mongo 中不存在会话时不再崩溃，历史为空', async () => {
    redisMock.get.mockResolvedValue(null);
    chatModelMock.find.mockResolvedValue([]); // 关键回归点：chatData[0] 为 undefined
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    await expect(
      service.combineConvo(
        new Types.ObjectId(),
        new Types.ObjectId().toString() as any,
        'hi',
        undefined,
        streamMock,
        undefined,
        undefined,
      ),
    ).resolves.toBeUndefined();
    expect(redisMock.set).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('携带文档时会查询文件并把文档内容拼入消息', async () => {
    const selectMock = jest.fn().mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        fileName: 'a.pdf',
        fileSize: 12,
        fileType: 'pdf',
        fileText: '文档内容',
      },
    ]);
    fileModelMock.find.mockReturnValue({ select: selectMock });
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    await service.combineConvo(
      new Types.ObjectId(),
      'null',
      '总结一下',
      [{ fileName: 'a.pdf', fileSize: '12KB', fileType: 'pdf', docId: new Types.ObjectId().toString() }],
      streamMock,
      true, // 携带文档时应被强制禁用知识库
      undefined,
    );
    expect(fileModelMock.find).toHaveBeenCalled();
    expect(streamMock.write).toHaveBeenCalledWith(
      expect.stringContaining('正在阅读文档'),
    );
    const messages = JSON.parse(logSpy.mock.calls[1][0]);
    expect(messages[0].content).toContain('文档内容');
    expect(messages[0].displayContent).toBe('总结一下');
    logSpy.mockRestore();
  });

  describe('渐进式披露：系统提示词分层', () => {
    it('第一轮意图识别调用只注入核心身份层，不含知识库规则', async () => {
      const createMock = jest.spyOn((service as any).openai.chat.completions, 'create')
        .mockResolvedValue((async function* () {})() as any);

      await service.callingModel([{ role: 'user', content: '高血压症状' }], true);

      const systemMsg = (createMock.mock.calls[0][0] as any).messages[0];
      expect(systemMsg.content).toContain('AI科研助手');
      expect(systemMsg.content).not.toContain('知识库问答规则');
      expect(systemMsg.content).not.toContain('&没有检索到相关文档&');
    });

    it('知识库检索后的第二轮调用才注入知识库问答规则层', async () => {
      const createMock = jest.spyOn((service as any).openai.chat.completions, 'create')
        .mockResolvedValue((async function* () {})() as any);

      await service.callingModel([{ role: 'user', content: 'x' }], false, undefined, true);

      const systemMsg = (createMock.mock.calls[0][0] as any).messages[0];
      expect(systemMsg.content).toContain('AI科研助手');
      expect(systemMsg.content).toContain('知识库问答规则');
      expect(systemMsg.content).toContain('&没有检索到相关文档&');
    });
  });

  describe('queryKb 知识库检索流程', () => {
    const mockModelStream = (chunks: string[]) => {
      const createMock = jest.spyOn((service as any).openai.chat.completions, 'create')
        .mockResolvedValue((async function* () {
          for (const c of chunks) {
            yield { choices: [{ delta: { content: c } }] };
          }
        })() as any);
      return createMock;
    };

    it('检索命中时通知前端文件列表并流式输出答案', async () => {
      fileServiceMock.hybridSearch.mockResolvedValue({
        success: true,
        results: [
          { docId: 'd1', docTitle: '高血压指南.pdf', docText: '高血压常用降压药包括...', rrfScore: 0.01 },
        ],
        fromVector: 1,
        fromKeyword: 1,
      });
      const createMock = mockModelStream(['高血压', '常用药物有...']);

      await service.queryKb(streamMock, '高血压吃什么药', [{ role: 'user', content: '高血压吃什么药' }], 'u1', undefined);

      // 1. 用户问题交给混合检索（内部含 embedding + 向量 + 关键词）
      expect(fileServiceMock.hybridSearch).toHaveBeenCalledWith('高血压吃什么药', 'u1', 5);
      // 2. 前端收到检索进行中与完成通知，完成通知含命中文件
      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('正在检索知识库'))).toBe(true);
      expect(writes.some((w: string) => w.includes('知识库检索完成') && w.includes('高血压指南.pdf'))).toBe(true);
      // 3. 检索片段被拼进发给模型的消息
      const calledMessages: any[] = (createMock.mock.calls[0][0] as any).messages;
      const lastMsg = calledMessages[calledMessages.length - 1];
      expect(lastMsg.content).toContain('高血压常用降压药包括');
      expect(lastMsg.content).toContain('高血压吃什么药');
      // 4. 模型答案逐块推流并结束响应
      expect(writes.some((w: string) => w.includes('高血压') && w.includes('answer'))).toBe(true);
      expect(streamMock.end).toHaveBeenCalled();
    });

    it('检索无命中时向模型注入占位符 &没有检索到相关文档&', async () => {
      fileServiceMock.hybridSearch.mockResolvedValue({ success: true, results: [], fromVector: 0, fromKeyword: 0 });
      const createMock = mockModelStream(['我没有查询到相关文档，但我可以告诉你']);

      await service.queryKb(streamMock, '感冒怎么办', [{ role: 'user', content: '感冒怎么办' }], 'u1', undefined);

      const calledMessages: any[] = (createMock.mock.calls[0][0] as any).messages;
      expect(calledMessages[calledMessages.length - 1].content).toContain('&没有检索到相关文档&');
      expect(streamMock.end).toHaveBeenCalled();
    });

    it('检索服务异常时优雅降级并通知前端', async () => {
      fileServiceMock.hybridSearch.mockRejectedValue(new Error('Milvus 连接失败'));
      jest.spyOn(console, 'log').mockImplementation();

      await service.queryKb(streamMock, '感冒怎么办', [{ role: 'user', content: '感冒怎么办' }], 'u1', undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('知识库检索失败'))).toBe(true);
      expect(streamMock.end).toHaveBeenCalled();
    });
  });

  describe('助手回复收集（持久化数据源）', () => {
    const mockModelStream = (chunks: any[]) => {
      return jest.spyOn((service as any).openai.chat.completions, 'create')
        .mockResolvedValue((async function* () {
          for (const c of chunks) {
            yield c;
          }
        })() as any);
    };

    it('非知识库路径流式推送answer并返回完整助手消息', async () => {
      jest.restoreAllMocks(); // 恢复beforeEach中对modelResult的spy，调用真实实现
      jest.spyOn(console, 'log').mockImplementation();
      mockModelStream([
        { choices: [{ delta: { content: '你好' } }] },
        { choices: [{ delta: { content: '，我是助手' } }] },
      ]);
      const result = await service.modelResult(
        [{ role: 'user', content: 'hi' }],
        streamMock,
        undefined,
        'u1',
        's1',
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual({ role: 'assistant', content: '你好，我是助手' });
      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('answer') && w.includes('你好'))).toBe(true);
      expect(streamMock.end).toHaveBeenCalled();
    });

    it('携带文档时助手消息附带阅读文档信息', async () => {
      jest.restoreAllMocks();
      jest.spyOn(console, 'log').mockImplementation();
      mockModelStream([{ choices: [{ delta: { content: '文档总结' } }] }]);
      const readFileList = {
        type: 'readDocument' as const,
        statusInfo: 'completed' as const,
        promptInfo: '已阅读文档',
        fileList: ['a.pdf'],
      };
      const result = await service.modelResult(
        [{ role: 'user', content: '总结一下' }],
        streamMock,
        undefined,
        'u1',
        's1',
        [{ fileName: 'a.pdf', fileSize: '12KB', fileType: 'pdf', docId: 'd1' }],
        readFileList,
        undefined,
      );
      expect(result).toEqual({
        role: 'assistant',
        content: '文档总结',
        readFileData: readFileList,
      });
    });

    it('知识库路径返回带检索信息的助手消息', async () => {
      fileServiceMock.hybridSearch.mockResolvedValue({
        success: true,
        results: [{ docId: 'd1', docTitle: '高血压指南.pdf', docText: '内容', rrfScore: 0.01 }],
        fromVector: 1,
        fromKeyword: 0,
      });
      mockModelStream([{ choices: [{ delta: { content: '知识库答案' } }] }]);
      const result = await service.queryKb(
        streamMock,
        '高血压吃什么药',
        [{ role: 'user', content: '高血压吃什么药' }],
        'u1',
        undefined,
      );
      expect(result).toEqual({
        role: 'assistant',
        content: '知识库答案',
        readFileData: expect.objectContaining({ type: 'queryKB', fileList: ['高血压指南.pdf'] }),
      });
    });
  });

  describe('会话列表与历史记录查询', () => {
    it('会话列表按创建时间倒序返回，首条用户消息原文作为标题', async () => {
      const sessionId = new Types.ObjectId();
      const sortMock = jest.fn().mockResolvedValue([
        {
          _id: sessionId,
          createDate: '2026-07-28',
          createTime: 1753690000000,
          chatList: [
            { role: 'user', content: '用户上传的文档内容如下:xxx', displayContent: '帮我总结这份文档' },
            { role: 'assistant', content: '好的' },
          ],
        },
      ]);
      const selectMock = jest.fn().mockReturnValue({ sort: sortMock });
      chatModelMock.find.mockReturnValue({ select: selectMock });
      const userId = new Types.ObjectId();

      const result = await service.getSessionList(userId);

      expect(chatModelMock.find).toHaveBeenCalledWith({ userId });
      expect(result).toEqual([
        {
          sessionId: sessionId.toString(),
          createDate: '2026-07-28',
          createTime: 1753690000000,
          title: '帮我总结这份文档',
          messageCount: 2,
        },
      ]);
    });

    it('标题超过30个字符时截断并加省略号', async () => {
      const longTitle = '这是一个非常非常非常长的用户问题，用来验证标题截断逻辑是否正常工作';
      const sortMock = jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          createDate: '2026-07-28',
          createTime: 1753690000000,
          chatList: [{ role: 'user', content: longTitle }],
        },
      ]);
      chatModelMock.find.mockReturnValue({ select: jest.fn().mockReturnValue({ sort: sortMock }) });

      const result = await service.getSessionList(new Types.ObjectId());

      expect(result[0].title).toBe(longTitle.slice(0, 30) + '...');
    });

    it('历史记录redis命中时直接返回缓存，不查mongodb', async () => {
      const chatList = [{ role: 'user', content: '旧消息' }];
      redisMock.get.mockResolvedValue(JSON.stringify(chatList));
      const userId = new Types.ObjectId();
      const sessionId = new Types.ObjectId().toString();

      const result = await service.getHistory(userId, sessionId);

      expect(result).toEqual({ sessionId, chatList });
      expect(chatModelMock.findOne).not.toHaveBeenCalled();
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('历史记录redis未命中时回源mongodb并回填缓存', async () => {
      redisMock.get.mockResolvedValue(null);
      const chatList = [{ role: 'user', content: '旧消息' }, { role: 'assistant', content: '旧回复' }];
      chatModelMock.findOne.mockResolvedValue({ chatList });
      const userId = new Types.ObjectId();
      const sessionId = new Types.ObjectId().toString();

      const result = await service.getHistory(userId, sessionId);

      expect(chatModelMock.findOne).toHaveBeenCalledWith({ userId, _id: sessionId });
      expect(result).toEqual({ sessionId, chatList });
      expect(redisMock.set).toHaveBeenCalledWith(
        `chat_history:${userId}:${sessionId}`,
        JSON.stringify(chatList),
        'EX',
        10800,
      );
    });

    it('sessionId不是合法ObjectId时返回空对话列表，不查库', async () => {
      const result = await service.getHistory(new Types.ObjectId(), 'not-an-object-id');

      expect(result).toEqual({ sessionId: 'not-an-object-id', chatList: [] });
      expect(redisMock.get).not.toHaveBeenCalled();
      expect(chatModelMock.findOne).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 四工具 RAG 架构（configMock 中 RAG_REFACTOR_ENABLED=true）
  // ============================================================
  describe('四工具 RAG 架构 · 意图路由新链路', () => {
    const mockModelStream = (chunks: any[]) =>
      jest.spyOn((service as any).openai.chat.completions, 'create').mockResolvedValue(
        (async function* () {
          for (const c of chunks) yield c;
        })() as any,
      );

    it('clarify 意图：生成自然语言反问并写入 pendingConfirmation 状态', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'clarify', confidence: 0.9, reasoning: 'r' });
      jest.spyOn((service as any).openai.chat.completions, 'create').mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                display_text: '你是想问 RAG 的重排序怎么做吗？',
                inferred_intents: [{ text: 'RAG 的重排序怎么做', confidence: 0.85 }],
                entity_pool: ['RAG'],
              }),
            },
          },
        ],
      });
      const userId = new Types.ObjectId();
      await service.combineConvo(userId, 'null', '然后呢', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('你是想问 RAG 的重排序怎么做吗？'))).toBe(true);
      // pendingConfirmation 状态写入 redis（EX 过期）
      const setCall = redisMock.set.mock.calls.find((c: any[]) => (c[0] as string).startsWith(`chat_clarify:${userId}:`));
      expect(setCall).toBeDefined();
      expect(setCall[2]).toBe('EX');
      const state = JSON.parse(setCall[1]);
      expect(state.mode).toBe('pending_confirmation');
      expect(state.inferredIntents[0].text).toBe('RAG 的重排序怎么做');
      expect(streamMock.end).toHaveBeenCalled();
    });

    it('fact 意图：精确检索命中后流式回答，fallback 计数器归零', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [{ docId: 'd1', docTitle: 'RAG综述.pdf', docText: 'RAG 是检索增强生成...', score: 0.92 }],
        totalCandidates: 12,
        aboveThreshold: 1,
        lowConfidence: false,
      });
      mockModelStream([
        { choices: [{ delta: { content: 'RAG 是' } }] },
        { choices: [{ delta: { content: '检索增强生成' } }] },
      ]);
      const userId = new Types.ObjectId();
      await service.combineConvo(userId, 'null', 'RAG 是什么', undefined, streamMock, true, undefined);

      // 检索参数来自 skill 的 retrieval_config（mock 未配置时用默认值）
      expect(fileServiceMock.preciseSearch).toHaveBeenCalledWith('RAG 是什么', userId.toString(), {
        topK: 3,
        rerankThreshold: 0.75,
        requireSource: true,
      });
      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('检索增强生成'))).toBe(true);
      // 命中后 fallback 计数器被重置为 0
      const fbSet = redisMock.set.mock.calls.find((c: any[]) => c[0] === `chat_fallback:${userId}`);
      expect(JSON.parse(fbSet[1]).count).toBe(0);
      // 助手回复落库
      expect(chatModelMock.updateOne).toHaveBeenCalledWith(expect.anything(), {
        $push: {
          chatList: {
            $each: [expect.objectContaining({ role: 'assistant', content: 'RAG 是检索增强生成' })],
          },
        },
      });
    });

    it('fact 意图连续无命中达到上限 → 熔断拒绝并引导上传文档，不再调用 LLM', async () => {
      const userId = new Types.ObjectId();
      redisMock.get.mockImplementation(async (key: string) => {
        if (key === `chat_fallback:${userId}`) return JSON.stringify({ count: 2, lastResetAt: Date.now() });
        return null;
      });
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [],
        totalCandidates: 0,
        aboveThreshold: 0,
        lowConfidence: false,
      });
      const createSpy = jest.spyOn((service as any).openai.chat.completions, 'create');

      await service.combineConvo(userId, 'null', '一个知识库里没有的问题', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('可以上传到知识库后再问我'))).toBe(true);
      expect(createSpy).not.toHaveBeenCalled();
      expect(streamMock.end).toHaveBeenCalled();
    });

    it('Confidence-Checker 判定 warn → 回答末尾追加依据强度提示', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [{ docId: 'd1', docTitle: 'A.pdf', docText: '内容', score: 0.7 }],
        totalCandidates: 5,
        aboveThreshold: 1,
        lowConfidence: false,
      });
      confidenceAgentMock.check.mockReturnValue({
        check_result: 'warn',
        overall_confidence: 0.6,
        dimension_scores: {},
        warnings: ['single_source'],
        recommended_action: { action: 'annotate_with_uncertainty', detail: '', auto_executable: true },
      });
      mockModelStream([{ choices: [{ delta: { content: '回答正文' } }] }]);

      await service.combineConvo(new Types.ObjectId(), 'null', 'A 讲了什么', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('依据强度提示'))).toBe(true);
    });

    it('Confidence-Checker 判定 fail → 追加推荐的用户提示文案（不再静默通过）', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [{ docId: 'd1', docTitle: 'A.pdf', docText: '内容', score: 0.2 }],
        totalCandidates: 5,
        aboveThreshold: 1,
        lowConfidence: false,
      });
      confidenceAgentMock.check.mockReturnValue({
        check_result: 'fail',
        overall_confidence: 0.3,
        dimension_scores: {},
        warnings: [],
        recommended_action: {
          action: 'reject_or_fallback',
          detail: '',
          auto_executable: true,
          user_message: '现有资料不足以支撑可靠分析，请补充文档。',
        },
      });
      mockModelStream([{ choices: [{ delta: { content: '回答正文' } }] }]);
      jest.spyOn(console, 'warn').mockImplementation();

      await service.combineConvo(new Types.ObjectId(), 'null', 'A 讲了什么', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('现有资料不足以支撑可靠分析'))).toBe(true);
      jest.restoreAllMocks();
    });

    it('pendingConfirmation 状态下用户说"是" → 映射最高置信候选后正常路由', async () => {
      const userId = new Types.ObjectId();
      const sessionId = new Types.ObjectId().toString();
      redisMock.get.mockImplementation(async (key: string) => {
        if (key === `chat_clarify:${userId}:${sessionId}`) {
          return JSON.stringify({
            mode: 'pending_confirmation',
            setAt: Date.now(),
            clarificationId: sessionId,
            inferredIntents: [{ text: 'RAG 的重排序怎么做', confidence: 0.85 }],
            maxTurns: 3,
            currentTurn: 0,
          });
        }
        if (key === `chat_history:${userId}:${sessionId}`) {
          return JSON.stringify([{ role: 'user', content: 'RAG 是什么' }]);
        }
        return null;
      });
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [],
        totalCandidates: 0,
        aboveThreshold: 0,
        lowConfidence: false,
      });
      mockModelStream([{ choices: [{ delta: { content: '重排序回答' } }] }]);

      await service.combineConvo(userId, sessionId as any, '是', undefined, streamMock, true, undefined);

      // 确认词被映射为候选问题后再分类
      expect(intentRouterMock.classifyIntent).toHaveBeenCalledWith('RAG 的重排序怎么做');
      // pending 状态已清除
      expect(redisMock.del).toHaveBeenCalledWith(`chat_clarify:${userId}:${sessionId}`);
    });

    it('hybrid 内部策略：事实确认区流式输出，且与多维评价拼接后一起落库', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({
        intent: 'perspective',
        confidence: 0.9,
        reasoning: 'r',
        hybrid: true,
      });
      intentRouterMock.buildExecutionPlan.mockReturnValue({
        userFacingIntent: 'perspective',
        internalStrategy: 'hybrid',
      });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [{ docId: 'd1', docTitle: 'RAG综述.pdf', docText: 'RAG 结合检索与生成的两阶段范式', score: 0.9 }],
        totalCandidates: 8,
        aboveThreshold: 1,
        lowConfidence: false,
      });
      perspectiveAgentMock.splitDimensions.mockResolvedValue([
        { name: '技术优势', query: 'RAG 的技术优势', weight: 0.8 },
        { name: '局限', query: 'RAG 的局限', weight: 0.6 },
      ]);
      perspectiveAgentMock.retrieveDimension.mockResolvedValue({
        name: '技术优势',
        status: 'completed',
        sources: [{ doc_title: 'RAG综述.pdf', excerpt: '减轻幻觉' }],
        rawText: '减轻幻觉，支持知识更新',
        confidence: 0.85,
        summarized: false,
      });
      mockModelStream([{ choices: [{ delta: { content: '多维评价正文' } }] }]);

      await service.combineConvo(new Types.ObjectId(), 'null', '你怎么看 RAG 的原理', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(writes.some((w: string) => w.includes('📌 事实确认'))).toBe(true);
      expect(writes.some((w: string) => w.includes('多维评价正文'))).toBe(true);
      // 落库内容 = 事实确认区 + 多维评价区（与用户看到的一致）
      const pushCall = chatModelMock.updateOne.mock.calls[0];
      const pushed = pushCall[1].$push.chatList.$each;
      const assistant = pushed.find((m: any) => m.role === 'assistant');
      expect(assistant.content).toContain('📌 事实确认');
      expect(assistant.content).toContain('多维评价正文');
    });

    it('fact 意图检索无命中（非熔断）→ 服务端确定性注入 ⚠️ 前缀', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [],
        totalCandidates: 0,
        aboveThreshold: 0,
        lowConfidence: false,
      });
      mockModelStream([{ choices: [{ delta: { content: '据通用知识，RAG 是...' } }] }]);

      await service.combineConvo(new Types.ObjectId(), 'null', 'RAG 是什么', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      // 确定性 ⚠️ 前缀必须出现在流式答案中，且不依赖模型自觉
      expect(writes.some((w: string) => w.includes('⚠️ 提示：知识库'))).toBe(true);
    });

    it('fail 链路修复：lowConfidence 兜底时 ConfidenceAgent 收到空数组（库外问题正确判 fail）', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'fact', confidence: 0.9, reasoning: 'r' });
      // 模拟库外问题：preciseSearch 兜底返回 Top1 但标记 lowConfidence=true
      fileServiceMock.preciseSearch.mockResolvedValue({
        success: true,
        results: [{ docId: 'd1', docTitle: 'A.pdf', docText: '勉强相关的片段', score: 0.2 }],
        totalCandidates: 5,
        aboveThreshold: 0,
        lowConfidence: true,
      });
      const checkSpy = confidenceAgentMock.check;
      checkSpy.mockReturnValue({
        check_result: 'fail',
        overall_confidence: 0,
        dimension_scores: { source_reliability: 0, content_relevance: 0, citation_completeness: 0, cross_source_consistency: 0 },
        warnings: ['no_results'],
        recommended_action: { action: 'reject_or_fallback', detail: '', auto_executable: true },
      });
      mockModelStream([{ choices: [{ delta: { content: '回答正文' } }] }]);

      await service.combineConvo(new Types.ObjectId(), 'null', '库外问题', undefined, streamMock, true, undefined);

      // 关键断言：check 收到的是空数组（而非兜底 Top1），fail 分支因此可触发
      const checkArgs = checkSpy.mock.calls[0][0];
      expect(Array.isArray(checkArgs)).toBe(true);
      expect(checkArgs).toHaveLength(0);
    });

    it('clarify 意图：LLM 引入实体池外新实体时服务端硬校验重建反问文本', async () => {
      redisMock.get.mockResolvedValue(null);
      intentRouterMock.classifyIntent.mockResolvedValue({ intent: 'clarify', confidence: 0.9, reasoning: 'r' });
      jest.spyOn((service as any).openai.chat.completions, 'create').mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                display_text: '你想了解 CNN 的原理吗？', // CNN 不在实体池，属泄漏
                inferred_intents: [{ text: 'CNN 的原理', confidence: 0.85 }],
                entity_pool: ['Transformer'],
              }),
            },
          },
        ],
      });
      const userId = new Types.ObjectId();
      await service.combineConvo(userId, 'null', '然后呢', undefined, streamMock, true, undefined);

      const writes = streamMock.write.mock.calls.map((c: any[]) => c[0] as string);
      const answerWrite = writes.find((w: string) => w.includes('你想进一步了解关于'));
      expect(answerWrite).toBeDefined();
      expect(answerWrite).not.toContain('CNN'); // 已被重建，杜绝新实体外泄
      expect(answerWrite).toContain('Transformer'); // 复用上下文实体池
    });
  });
});
