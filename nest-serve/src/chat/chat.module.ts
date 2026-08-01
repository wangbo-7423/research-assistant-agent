import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller'
import { ChatService } from './chat.service';
import { FileanagementModule } from "../fileanagement/fileanagement.module"
import { MongooseModule } from '@nestjs/mongoose';
import { ChatData, ChatSchema } from './chat.schema';
import { SkillLoader } from './tools/skill-loader';
import { IntentRouter } from './routers/intent-router';
import { PerspectiveAgent } from './agents/sub-agent';
import { ConfidenceAgent } from './agents/confidence-agent';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ChatData.name, schema: ChatSchema }]),
    FileanagementModule
  ],
  controllers: [ChatController],
  providers: [ChatService, SkillLoader, IntentRouter, PerspectiveAgent, ConfidenceAgent],
})
export class ChatModule {}
