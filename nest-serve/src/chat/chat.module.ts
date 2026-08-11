import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller'
import { ChatService } from './chat.service';
import { FileanagementModule } from "../fileanagement/fileanagement.module"
import { MongooseModule } from '@nestjs/mongoose';
import { ChatData, ChatSchema } from './chat.schema';
import { RagTraceSchema, RAG_TRACE_MODEL } from './rag-trace.schema';
import { RagTraceSink } from './rag-trace-sink';
import { SkillLoader } from './tools/skill-loader';
import { IntentRouter } from './routers/intent-router';
import { PerspectiveAgent } from './agents/sub-agent';
import { ConfidenceAgent, ConfidenceConfig } from './agents/confidence-agent';

/**
 * 置信度评分配置（2026-08-11 实测校准，见 RAG_EVALUATION_DESIGN.md 二·五 发现 2）：
 * - 默认 pass 0.8 在 qwen3-rerank 真实分数（0.3~0.6）下 pass 误杀率 100%（21/21 全 warn）
 * - 校准结论：passThreshold 0.65 + 单源系数 0.75 → pass 误杀率 0%（21/21 pass）
 * - configHash: 98e6d9558768
 * - 环境变量 RAG_CONFIDENCE_CALIBRATED=false 可回退到旧默认行为（pass 0.8）
 */
function buildConfidenceConfig(): ConfidenceConfig {
    if ((process.env.RAG_CONFIDENCE_CALIBRATED ?? 'true') === 'false') {
        return {}; // 旧默认（pass 0.8 / warn 0.5 / 单源 0.6）
    }
    return {
        passThreshold: 0.65,
        singleSourceReliability: 0.75,
        singleSourceConsistency: 0.75,
    };
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatData.name, schema: ChatSchema },
      { name: RAG_TRACE_MODEL, schema: RagTraceSchema },
    ]),
    FileanagementModule
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    SkillLoader,
    IntentRouter,
    PerspectiveAgent,
    RagTraceSink,
    { provide: ConfidenceAgent, useValue: new ConfidenceAgent(buildConfidenceConfig()) },
  ],
})
export class ChatModule {}
