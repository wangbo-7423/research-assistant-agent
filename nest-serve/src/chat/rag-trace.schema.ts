// ============================================================
// rag_traces 集合 schema（设计文档 3.1 · MongoDB 落库通道）
//
// 宽松结构（strict: false）：trace 是动态 JSON（intent 不同字段不同），
// 只对需要查询/聚合的字段建索引，其余字段原样存储。
// ============================================================

import { Schema, Types } from 'mongoose';

export const RagTraceSchema = new Schema(
    {
        trace_id: { type: String, required: true, unique: true, index: true },
        ts: { type: Number, required: true, index: true },
        user_id: { type: String, index: true },
        session_id: { type: String, index: true },
        intent: { type: String, index: true },
        // 其余动态字段（retrieval / confidence_check / dimensions / ...）由 strict:false 原样存储
    },
    {
        strict: false,
        collection: 'rag_traces',
        versionKey: false,
    },
);

export interface RagTrace extends Types.Subdocument {
    trace_id: string;
    ts: number;
    user_id?: string;
    session_id?: string;
    intent?: string;
    [key: string]: unknown;
}

export const RAG_TRACE_MODEL = 'RagTrace';
