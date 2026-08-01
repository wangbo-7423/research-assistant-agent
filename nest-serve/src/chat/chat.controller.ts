import { Body, Controller, Delete, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { GetHistoryQueryDto, SendMessageQueryDto } from './chat.dto';
import { ChatService } from './chat.service'
import { SkillLoader } from './tools/skill-loader';
import { Types } from 'mongoose';
import express from "express"

@Controller('chat')
export class ChatController {
    constructor(
        private readonly chatService: ChatService,
        private readonly skillLoader: SkillLoader,
    ) {}
    // 用户发送消息
    @Post('sendmessage')
    @UseGuards(AuthGuard)
    async sendMessage(
        @Req() req: {user: { token: string }},
        @Body() body: SendMessageQueryDto,
        @Res() stream: express.Response
    ) {
        const {content, uploadFileList, sessionId, isKnowledgeBased, uploadImageList} = body;
        const userId = new Types.ObjectId(req.user.token);
        await this.chatService.combineConvo(
            userId,
            sessionId,
            content,
            uploadFileList,
            stream,
            isKnowledgeBased,
            uploadImageList
        );
    }
    // 查询用户的会话列表
    @Get('sessionlist')
    @UseGuards(AuthGuard)
    async sessionList(
        @Req() req: {user: { token: string }},
    ) {
        const userId = new Types.ObjectId(req.user.token);
        return await this.chatService.getSessionList(userId);
    }
    // 查询某个会话的完整对话记录
    @Get('history')
    @UseGuards(AuthGuard)
    async history(
        @Req() req: {user: { token: string }},
        @Query() query: GetHistoryQueryDto,
    ) {
        const userId = new Types.ObjectId(req.user.token);
        return await this.chatService.getHistory(userId, query.sessionId);
    }
    // 删除指定会话（同时清理mongodb与redis缓存）
    @Delete('deletesession')
    @UseGuards(AuthGuard)
    async deleteSession(
        @Req() req: {user: { token: string }},
        @Query() query: GetHistoryQueryDto,
    ) {
        const userId = new Types.ObjectId(req.user.token);
        return await this.chatService.deleteSession(userId, query.sessionId);
    }
    // skills 加载健康检查（运维/监控用）：总数、正常、降级明细
    @Get('skills/health')
    @UseGuards(AuthGuard)
    skillsHealth() {
        return this.skillLoader.getHealthReport();
    }
}
