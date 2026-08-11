// ============================================================
// RagTrace Mongo 落库通道
//
// 在 ChatModule 启动时（onModuleInit）把 RagTrace model 注册为
// rag-tracer 的 Mongo sink —— createRagTrace().flush() 会异步写入，
// 失败仅 warn 不阻塞。JSONL 通道始终保留为降级。
// ============================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RagTrace } from './rag-trace.schema';
import { registerRagTraceMongoSink } from './rag-tracer';

@Injectable()
export class RagTraceSink implements OnModuleInit {
    constructor(@InjectModel('RagTrace') private readonly ragTraceModel: Model<RagTrace>) {}

    onModuleInit(): void {
        registerRagTraceMongoSink(async (trace) => {
            await this.ragTraceModel.create(trace);
        });
        console.log('[RagTracer] MongoDB 落库通道已注册（rag_traces 集合）');
    }
}
