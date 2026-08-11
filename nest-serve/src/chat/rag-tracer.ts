// ============================================================
// RAG trace 结构化埋点（设计文档 3.1 落地）
//
// 双通道落库：
//   - JSONL（默认，零依赖）：追加写 logs/rag_traces-YYYYMMDD.jsonl
//   - MongoDB（可选，v2 补充）：通过 registerRagTraceMongoSink 注册
//     Mongoose model 的异步写入，失败只 warn 不抛错，绝不阻塞主流程
//
// 环境变量：
//   RAG_TRACE_ENABLED=false 整体关闭
//   RAG_TRACE_DIR          覆盖 JSONL 目录（默认 <cwd>/logs）
//   RAG_TRACE_MONGO=false  关闭 MongoDB 通道（默认开，若已注册 sink）
// ============================================================

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface TraceBuilder {
    /** 已收集的字段 */
    data: Record<string, unknown>;
    /** 打点：合并键值（同名键后者覆盖） */
    set(fields: Record<string, unknown>): TraceBuilder;
    /** 打点：仅当值为非空时才写入（避免埋点逻辑污染主流程） */
    setIf(fields: Record<string, unknown>): TraceBuilder;
    /** 输出完整 trace（含 trace_id / ts），落盘 */
    flush(): void;
}

/** MongoDB 写入 sink：由宿主（chat.module）注册，返回 Promise，失败被吞 */
export type RagTraceMongoSink = (trace: Record<string, unknown>) => Promise<void>;

let mongoSink: RagTraceMongoSink | null = null;

/** 注册 MongoDB 落库通道（幂等；chat.module 启动时调用一次） */
export function registerRagTraceMongoSink(sink: RagTraceMongoSink): void {
    mongoSink = sink;
}

function resolveTraceDir(): string {
    return process.env.RAG_TRACE_DIR || join(process.cwd(), 'logs');
}

function traceFile(): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return join(resolveTraceDir(), `rag_traces-${date}.jsonl`);
}

function isEnabled(): boolean {
    return (process.env.RAG_TRACE_ENABLED ?? 'true') !== 'false';
}

function mongoEnabled(): boolean {
    return (process.env.RAG_TRACE_MONGO ?? 'true') !== 'false';
}

function appendTrace(trace: Record<string, unknown>): void {
    try {
        const dir = resolveTraceDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(traceFile(), JSON.stringify(trace) + '\n', 'utf-8');
    } catch (e) {
        console.warn('[RagTracer] JSONL 写入失败（不阻塞主流程）:', (e as Error).message);
    }
}

function pushToMongo(trace: Record<string, unknown>): void {
    if (!mongoEnabled() || !mongoSink) return;
    // 异步 fire-and-forget：不 await、不阻塞主流程，失败仅 warn
    mongoSink(trace).catch((e) => {
        console.warn('[RagTracer] MongoDB 写入失败（不阻塞主流程）:', (e as Error)?.message ?? e);
    });
}

/** 创建一条新 trace（幂等：同一请求重复调用返回同一 builder） */
export function createRagTrace(init?: Record<string, unknown>): TraceBuilder {
    const trace: Record<string, unknown> = {
        trace_id: randomUUID(),
        ts: Date.now(),
        ...(init ?? {}),
    };
    const builder: TraceBuilder = {
        data: trace,
        set(fields) {
            Object.assign(trace, fields);
            return this;
        },
        setIf(fields) {
            for (const [k, v] of Object.entries(fields)) {
                if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
                    trace[k] = v;
                }
            }
            return this;
        },
        flush() {
            if (!isEnabled()) return;
            appendTrace(trace);
            pushToMongo(trace);
        },
    };
    return builder;
}

/** 供测试 / 运维：当前 trace 文件路径 */
export function getRagTraceFilePath(): string {
    return traceFile();
}
