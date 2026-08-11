import { createRagTrace, getRagTraceFilePath, registerRagTraceMongoSink } from './rag-tracer';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('rag-tracer · 结构化埋点', () => {
  let tmpDir: string;
  const savedDir = process.env.RAG_TRACE_DIR;
  const savedEnabled = process.env.RAG_TRACE_ENABLED;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-trace-test-'));
    process.env.RAG_TRACE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.RAG_TRACE_DIR;
    else process.env.RAG_TRACE_DIR = savedDir;
    if (savedEnabled === undefined) delete process.env.RAG_TRACE_ENABLED;
    else process.env.RAG_TRACE_ENABLED = savedEnabled;
  });

  it('set / setIf 合并字段，flush 落盘一行 JSON', () => {
    const t = createRagTrace({ user_id: 'u1' });
    t.set({ intent: 'fact' });
    t.setIf({ route_confidence: 0.86, empty_arr: [] as string[], undefined_field: undefined });
    t.flush();
    const file = getRagTraceFilePath();
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.user_id).toBe('u1');
    expect(parsed.intent).toBe('fact');
    expect(parsed.route_confidence).toBe(0.86);
    expect(parsed.trace_id).toBeDefined();
    expect(parsed.ts).toBeDefined();
    // setIf 跳过空数组与 undefined
    expect(parsed.empty_arr).toBeUndefined();
    expect(parsed.undefined_field).toBeUndefined();
  });

  it('同一 builder 多次 flush 只追加，不覆盖 trace_id', () => {
    const t = createRagTrace({ a: 1 });
    const id1 = t.data.trace_id;
    t.set({ b: 2 });
    t.flush();
    t.set({ c: 3 });
    t.flush();
    const lines = readFileSync(getRagTraceFilePath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.trace_id).toBe(id1);
    expect(first.trace_id).toBe(second.trace_id);
    expect(second.c).toBe(3);
  });

  it('RAG_TRACE_ENABLED=false 时不落盘', () => {
    process.env.RAG_TRACE_ENABLED = 'false';
    const t = createRagTrace({ a: 1 });
    t.flush();
    expect(existsSync(getRagTraceFilePath())).toBe(false);
  });

  it('注册 Mongo sink 后 flush 异步写入（fire-and-forget）', async () => {
    const sink = jest.fn().mockResolvedValue(undefined);
    registerRagTraceMongoSink(sink);
    const t = createRagTrace({ intent: 'fact' });
    t.set({ retrieval: { candidates: 3 } });
    t.flush();
    // sink 是异步 fire-and-forget，等待微任务排空
    await new Promise((r) => setTimeout(r, 10));
    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0][0];
    expect(payload.trace_id).toBeDefined();
    expect(payload.intent).toBe('fact');
    expect(payload.retrieval.candidates).toBe(3);
  });

  it('Mongo sink 失败仅 warn，不影响 JSONL 落盘', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const sink = jest.fn().mockRejectedValue(new Error('Mongo down'));
    registerRagTraceMongoSink(sink);
    const t = createRagTrace({ intent: 'fact' });
    t.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(warnSpy).toHaveBeenCalled(); // 失败被吞，只 warn
    expect(existsSync(getRagTraceFilePath())).toBe(true); // JSONL 不受影响
    warnSpy.mockRestore();
  });

  it('RAG_TRACE_MONGO=false 时不走 Mongo sink，JSONL 仍写', async () => {
    process.env.RAG_TRACE_MONGO = 'false';
    const sink = jest.fn().mockResolvedValue(undefined);
    registerRagTraceMongoSink(sink);
    const t = createRagTrace({ intent: 'fact' });
    t.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(sink).not.toHaveBeenCalled();
    expect(existsSync(getRagTraceFilePath())).toBe(true);
    delete process.env.RAG_TRACE_MONGO;
  });
});
