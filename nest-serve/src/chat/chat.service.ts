import { Controller, Injectable, OnModuleInit } from '@nestjs/common';
import { Model, Types } from "mongoose"
import { uploadFileListType, MessageType } from "./chat"
import { Response } from "express"
import { Fileanagement } from "../fileanagement/fileanagement.schema"
import { InjectModel } from '@nestjs/mongoose';
import { InjectRedis } from "@nestjs-modules/ioredis"
import { Redis } from "ioredis"
import { ChatData } from './chat.schema';
import { OpenAI } from "openai"
import { ConfigService } from '@nestjs/config';
import { buildSystemPrompt } from "./roleDefinition"
import { toolsData } from "./tools"
import { FileanagementService } from "../fileanagement/fileanagement.service"
import { SkillLoader } from "./tools/skill-loader"
import { IntentRouter, IntentRouteResult, createClarifyState, handlePendingConfirmation, isPendingExpired, onFactResult, ClarifyState, FallbackCounter } from "./routers/intent-router"
import { PerspectiveAgent, DimensionResult } from "./agents/sub-agent"
import { ConfidenceAgent, ConfidenceCheckResult } from "./agents/confidence-agent"
import { createRagTrace } from "./rag-tracer"
import { readFileSync } from 'fs';
import { assertImageSignature, resolveStoredImagePath } from '../fileanagement/image-storage';
// 创建请求对话的终止控制器
const controllerMap = new Map<string, AbortController>();

@Injectable()
export class ChatService implements OnModuleInit {
    private openai: OpenAI
    private readonly textModel: string;
    private readonly visionModel: string;
    /** 四工具 RAG 架构总开关：true 时 KB 路径走新意图路由，false 时完全保留旧链路 */
    private readonly ragRefactorEnabled: boolean;
    /** 最近一次 LLM 调用耗时（ms），供 trace 埋点（并发请求各自覆盖，仅作近似记录） */
    private lastLlmLatencyMs?: number;
    constructor(
        @InjectModel(Fileanagement.name)
        private  fileanagementModel: Model<Fileanagement>,

        @InjectRedis()
        private readonly redis: Redis,

        @InjectModel(ChatData.name)
        private chatDataModel: Model<ChatData>,

        private configService: ConfigService,

        private readonly fileanagementService: FileanagementService,

        private readonly skillLoader: SkillLoader,
        private readonly intentRouter: IntentRouter,
        private readonly perspectiveAgent: PerspectiveAgent,
        private readonly confidenceAgent: ConfidenceAgent,
    ) {
        const qwenApiKey = this.configService.get<string>('QWEN_API_KEY');
        if (!qwenApiKey) {
            throw new Error('QWEN_API_KEY 未在环境变量中配置');
        }

        this.openai = new OpenAI({
            apiKey: qwenApiKey,
            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            defaultHeaders: {
                'Content-Type': 'application/json',
            },
            timeout: 60000,
            maxRetries: 2,
        });
        this.textModel = this.configService.get<string>('QWEN_TEXT_MODEL') || 'qwen3.7-plus';
        this.visionModel = this.configService.get<string>('QWEN_VL_MODEL') || 'qwen-vl-plus';
        this.ragRefactorEnabled = this.configService.get<string>('RAG_REFACTOR_ENABLED') === 'true';
    }

    // 启动时预加载 skill 元数据（渐进式披露第一层）
    async onModuleInit() {
        try {
            await this.skillLoader.loadAllMetas();
            console.log('[ChatService] skill 元数据加载完成:', JSON.stringify(this.skillLoader.getHealthReport()));
        } catch (e) {
            console.error('[ChatService] skill 加载失败，新架构将不可用（旧链路不受影响）:', (e as Error).message);
        }
    }
    // 通知流
    notifyStream(stream: Response, streamData: any){
        // 用于将数据分块（chunk）写入到响应体中
        stream.write(JSON.stringify(streamData) + '###ABC###') // 以###ABC###作为分隔符
    }
    // 根据文档id查询文件管理数据库
    async queryFile(userId: string, docId: Types.ObjectId[]){
        const fileData = await this.fileanagementModel.find({
            userId,
            _id: { $in: docId }
        }).select('fileText fileName fileSize fileType')
        return {
            uploadFileList: fileData.map(item => ({
                fileName: item.fileName,
                // fileSize落库单位是字节，这里换算成KB展示
                fileSize: (item.fileSize / 1024).toFixed(1) + 'KB',
                fileType: item.fileType,
                docId: item._id.toString(),
            })),
            documents: fileData.map(item => item.fileText)
        }
    }
    // 发送给模型之前需要整合对话结构
    async combineConvo(
        userId: Types.ObjectId,
        sessionId: Types.ObjectId | 'null',
        content: string,
        uploadFileList: uploadFileListType[] | undefined,
        stream: Response,
        isKnowledgeBased: boolean | undefined,
        uploadImageList: MessageType['uploadImageList'] | undefined,
    ){
        // 组合对话字段：用户发送给模型的对话字段类型
        const messages:MessageType = {
            role: "user",
            content
        }
        // 阅读的文件列表：最后需要交给大模型的回复里
        let readFileList: MessageType['readFileData'] | undefined
        // 判断用户是否携带文档
        if(uploadFileList && uploadFileList.length > 0){
            // 如果用户上传文档，禁用知识库功能
            isKnowledgeBased = false
            // 正在阅读文档
            this.notifyStream(stream, {
                "type": "readDocument",
                "statusInfo": "inProgress",
                "promptInfo": "正在阅读文档",
                "fileList": []
            })
            // 根据文档id查询文档内容
            const docIdArr = uploadFileList.map(item => item.docId)
            const docId = docIdArr.map(id=>new Types.ObjectId(id))
            const res = await this.queryFile(userId.toString(), docId)
            // 拼接文档内容，交给大模型
            const documentContent = res.documents.join('\n\n---\n\n')
            messages.content = `用户上传的文档内容如下:\n${documentContent}\n请基于文档内容回复用户问题:${content}`
            // 取出原始问题
            messages.displayContent = content
            // 取出文件列表数据
            messages.uploadFileList = res.uploadFileList
            // 阅读的文件列表：最后需要交给大模型的回复里
            readFileList = {
                type: "readDocument",
                statusInfo: "completed",
                promptInfo: "已阅读文档",
                fileList: res.uploadFileList.map(item => item.fileName)
            }
        }
        // 如果用户上传图片
        if(uploadImageList && Object.keys(uploadImageList).length > 0){
            // 如果用户上传图片，禁用知识库功能
            isKnowledgeBased = false
            messages.uploadImageList = uploadImageList
        }
        // 请求数据库：获取用户历史对话，组合上下文，让模型有记忆能力
        // 需要发送给大模型的对话列表：历史对话+当前对话
        let historyConvoList: MessageType[] = []
        // 判断是否初次对话
        const isNewSession = sessionId == 'null'
        // 新会话落库后的真实对话id
        let realSessionId: Types.ObjectId | string = sessionId
        if(isNewSession){
            // 新创建对话：先把用户消息写入mongodb，生成会话id
            // （MessageType的role含system仅用于模型调用，落库消息只会是user/assistant，这里收窄类型）
            const createdChat = await this.chatDataModel.create({
                userId,
                chatList: [messages as ChatData['chatList'][number]]
            })
            realSessionId = createdChat._id as Types.ObjectId
            // 把新会话id推给前端，后续对话都携带这个id
            this.notifyStream(stream, {
                type: 'sessionId',
                sessionId: realSessionId.toString()
            })
            historyConvoList.push(messages)
        }else{
            // 查询redis是否有对话记录，有就使用redis，否则使用mongodb
            const redisKey = `chat_history:${userId}:${sessionId}`
            const cachedData = await this.redis.get(redisKey)
            if(cachedData){
                // redis里对话数据，那就直接取出来
                historyConvoList = JSON.parse(cachedData)
            } else{
                // redis没有数据，那就从mongodb里取
                const chatData = await this.chatDataModel.find({
                    userId,
                    _id:sessionId
                })
                historyConvoList = chatData[0]?.chatList || []
                // 存储redis，3个小时过期
                await this.redis.set(redisKey, JSON.stringify(historyConvoList), 'EX', 10800)
            }
            // 把当前用户的问题加入历史对话的最后一项
            historyConvoList.push(messages)
        }
        // 调用模型，等待助手回复完整产出（slice不改动原数组，完整历史留给持久化）
        console.log('对话数据')
        console.log(JSON.stringify(historyConvoList))
        let assistantMessage: MessageType | undefined;
        // 四工具 RAG 架构：KB 开启且总开关打开时走新意图路由；否则保留旧链路
        if (isKnowledgeBased && this.ragRefactorEnabled) {
            assistantMessage = await this.routeAndRespond(
                historyConvoList.slice(-21),
                stream,
                userId.toString(),
                realSessionId,
                uploadFileList,
                uploadImageList,
            );
        } else {
            assistantMessage = await this.modelResult(
                historyConvoList.slice(-21),
                stream,
                isKnowledgeBased,
                userId.toString(),
                realSessionId,
                uploadFileList,
                readFileList,
                uploadImageList,
            );
        }
        // 持久化本轮对话：用户消息+助手回复写入mongodb，并刷新redis缓存
        await this.persistConvo(
            userId,
            realSessionId,
            historyConvoList,
            messages,
            assistantMessage,
            isNewSession,
        )
    }
    // 持久化对话记录：把本轮消息追加到mongodb的chatList，并刷新redis缓存
    async persistConvo(
        userId: Types.ObjectId,
        sessionId: Types.ObjectId | string,
        fullConvoList: MessageType[],
        userMessage: MessageType,
        assistantMessage: MessageType | undefined,
        isNewSession: boolean,
    ){
        try {
            // 新会话创建时已写入用户消息，这里只需要追加助手回复；
            // 老会话需要追加用户消息；模型异常时没有助手回复，也要把用户消息存下来
            const newMessages: MessageType[] = isNewSession ? [] : [userMessage]
            if(assistantMessage && assistantMessage.content){
                newMessages.push(assistantMessage)
                fullConvoList.push(assistantMessage)
            }
            if(newMessages.length > 0){
                await this.chatDataModel.updateOne(
                    { _id: sessionId, userId },
                    { $push: { chatList: { $each: newMessages } } }
                )
            }
            // 刷新redis缓存，3个小时过期
            const redisKey = `chat_history:${userId}:${sessionId}`
            await this.redis.set(redisKey, JSON.stringify(fullConvoList), 'EX', 10800)
        } catch (error) {
            // 持久化失败不影响本次对话响应
            console.log('对话记录持久化失败')
            console.log(error)
        }
    }
    // 将服务端已校验的图片转换为 base64，再交给多模态大模型
    encodeImage(imagePath: string, mimetype: string) {
        const { absolutePath } = resolveStoredImagePath(imagePath);
        assertImageSignature(absolutePath, mimetype);
        const imageFile = readFileSync(absolutePath);
        const base64Image = imageFile.toString('base64');
        return {
            type: 'image_url',
            image_url: {
                url: `data:${mimetype};base64,${base64Image}`,
            },
        }
    }

    // 调用多模态大模型，理解图片
    async modelVLRes(
        messageList: MessageType[],
        imageUrlObj: any,
        controller?: AbortController,
    ){
        const lastUserMessage = messageList[messageList.length - 1];
        const res = await this.openai.chat.completions.create({
            model: this.visionModel,
            messages: [
                {
                    role: 'system',
                    content: `${buildSystemPrompt()}\n\n图片理解要求：先客观描述图片中的关键信息，再结合用户问题进行分析；涉及图表时提取趋势、对比、异常点和可读出的数据；无法从图片确认的内容要明确说明，不要臆造。`,
                },
                {
                    role: 'user',
                    content: [
                        imageUrlObj,
                        {
                            type:'text',
                            text: lastUserMessage.content
                        }
                    ],
                }
            ],
            stream: true,
            },
            {signal:controller?.signal}
        )
        return res
    }
    // 模型输出结果（返回助手完整回复，用于持久化；失败返回undefined）
    async modelResult(
        messageList: MessageType[],
        stream: Response,
        isKnowledgeBased: boolean | undefined,
        userId: string,
        sessionId: Types.ObjectId | string | 'null' | undefined,
        uploadFileList: uploadFileListType[] | undefined,
        readFileList: MessageType['readFileData'] | undefined,
        uploadFileImage: MessageType['uploadImageList'] | undefined,
    ): Promise<MessageType | undefined>{
        try {
            let res
            const controller = new AbortController()
            if(uploadFileImage && Object.keys(uploadFileImage).length > 0){
                const imageUrlObj = this.encodeImage(uploadFileImage.imagePath, uploadFileImage.mimetype)
                res = await this.modelVLRes(messageList, imageUrlObj, controller)
            } else {
                res = await this.callingModel(messageList, isKnowledgeBased, controller)
            }
            const userSessionId = sessionId === undefined ? 'null' : sessionId.toString()
            controllerMap.set(userSessionId, controller)
            
            // 如果用户携带文档对话，在这里返回前端
            if(uploadFileList && uploadFileList.length > 0){
                this.notifyStream(stream, readFileList)
            }
            // 存放拼接的新问题
            let toolCallArgsStr = ''
            // 标记工具是否开始调用
            let istoolCallStarted = false
            // 累积助手的完整回复，用于持久化
            let answerContent = ''
            // 迭代
            if(!res) return undefined
            for await (const chunk of res){
                const chunObj = chunk.choices?.[0]?.delta
                if(!chunObj) continue
                // 判断用户是否选择知识库来回答
                if(chunObj.tool_calls && chunObj.tool_calls[0].function?.arguments){
                    toolCallArgsStr += chunObj.tool_calls[0].function?.arguments
                    istoolCallStarted = true
                }
                // 判断是否开始调用工具
                if(chunk.choices?.[0]?.finish_reason === 'stop' && istoolCallStarted){
                    // 取出新问题（工具可能返回空参数字符串，解析失败时安全降级）
                    let newQuestion: {clarified_question?: string} | null = null
                    try {
                        newQuestion = toolCallArgsStr.trim() ? JSON.parse(toolCallArgsStr) : null
                    } catch {
                        newQuestion = null
                    }
                    if(newQuestion &&
                        typeof newQuestion === 'object' &&
                        'clarified_question' in newQuestion &&
                        typeof newQuestion.clarified_question === 'string' &&
                        newQuestion.clarified_question.trim() !== ''
                    ){
                        console.log('工具生成了新问题-----'+newQuestion.clarified_question)
                        // 整理新问题，查询知识库（queryKb返回助手回复，用于持久化）
                        return await this.queryKb(stream, newQuestion.clarified_question, messageList, userId, readFileList)
                    } else {
                        console.log('工具没有生成新问题')
                        const lastItem = messageList[messageList.length - 1]
                        return await this.queryKb(stream, lastItem.content, messageList, userId, readFileList)
                    }
                }
                // 普通回复：流式推给前端，同时累积完整内容
                if(chunObj.content){
                    answerContent += chunObj.content
                    this.notifyStream(stream, {
                        type: 'answer',
                        content: chunObj.content,
                    })
                }
            }
            // 模型异常或内容为空时不落库助手消息
            if(!answerContent){
                this.notifyStream(stream, {
                    type: 'error',
                    content: '模型没有返回内容，请稍后重试',
                })
                stream.end()
                return undefined
            }
            stream.end()
            // 组装助手消息：携带文档时把阅读文档信息一并存进对话记录
            const assistantMessage: MessageType = {
                role: 'assistant',
                content: answerContent,
            }
            if(readFileList){
                assistantMessage.readFileData = readFileList
            }
            return assistantMessage
        } catch (error) {
            console.log('调用模型出错')
            console.log(error)
            // 通知前端出错并结束响应流，避免前端 fetch 一直挂起
            try {
                this.notifyStream(stream, {
                    type: 'error',
                    content: '模型服务异常，请稍后重试',
                })
                stream.end()
            } catch { /* 流可能已损坏，忽略 */ }
            return undefined
        }
    }
    // 调用模型
    async callingModel(
        messagesList: MessageType[],
        isKnowledgeBased?: boolean,
        controller?: AbortController,
        withKbRules: boolean = false, // 渐进式披露：仅知识库检索后的第二轮调用注入检索规则
    ){
        const res = await this.openai.chat.completions.create({
            model: this.textModel,
            messages: [
                {role:'system', content: buildSystemPrompt({ withKbRules }) },
                ...messagesList.map(({ role, content }) => ({ role, content })),
            ],
            stream: true,
            tools:toolsData,
            tool_choice:isKnowledgeBased ? {type: 'function', 'function': {'name': '意图识别'}} : 'none',
            },
            {signal:controller?.signal}
        )
        return res
    }
    // 根据用户问题，检索知识库（返回助手完整回复，用于持久化；失败返回undefined）
    async queryKb(
        stream: Response,
        userQuestion: string,
        messageList: MessageType[],
        userId: string,
        readFileList: MessageType['readFileData'] | undefined,
    ): Promise<MessageType | undefined>{
        // 告知前端用户正在检索知识库
        this.notifyStream(stream, {
            type: 'queryKB',
            statusInfo: 'inProgress',
            promptInfo: "正在检索知识库",
            fileList: [],
        })

        // 累积助手的完整回复，用于持久化
        let answerContent = ''
        // 检索完成的状态信息：存进助手消息，前端渲染历史时可以还原
        let kbReadFileData: MessageType['readFileData'] | undefined
        try {
            // 1. 混合检索：对用户问题 embedding + 向量检索 + 关键词检索 + RRF 融合
            const searchRes = await this.fileanagementService.hybridSearch(userQuestion, userId, 5)
            const hits = searchRes.results || []

            // 2. 告知前端检索完成及命中的文件
            const hitFileNames = [...new Set(hits.map(h => h.docTitle).filter(Boolean))]
            kbReadFileData = {
                type: 'queryKB',
                statusInfo: 'completed',
                promptInfo: hits.length > 0 ? "知识库检索完成" : "知识库未检索到相关内容",
                fileList: hitFileNames,
            }
            this.notifyStream(stream, kbReadFileData)

            // 3. 拼接检索结果；无命中时使用约定占位符，交给系统提示词规则处理
            const kbContent = hits.length > 0
                ? hits.map((h, i) => `【片段${i + 1}·${h.docTitle}】\n${h.docText}`).join('\n\n')
                : '&没有检索到相关文档&'

            // 4. 组装带知识库上下文的对话并调用模型（流式）
            const kbMessages: MessageType[] = [
                ...messageList.slice(0, -1),
                {
                    role: 'user',
                    content: `知识库检索结果如下：\n${kbContent}\n\n请基于上述检索结果回答用户问题：${userQuestion}`,
                },
            ]

            const res = await this.callingModel(
                kbMessages,
                false, // 第二轮调用不再触发意图识别工具，避免递归检索
                undefined,
                true, // 渐进式披露：检索完成，注入知识库问答规则层
            )

            // 5. 将模型回复流式推送给前端，同时累积完整内容
            for await (const chunk of res) {
                const delta = chunk.choices?.[0]?.delta
                if (delta?.content) {
                    answerContent += delta.content
                    this.notifyStream(stream, {
                        type: 'answer',
                        content: delta.content,
                    })
                }
            }
            // 模型异常或内容为空时不落库助手消息
            if(!answerContent){
                return undefined
            }
            return {
                role: 'assistant',
                content: answerContent,
                readFileData: kbReadFileData,
            }
        } catch (error) {
            console.log('检索知识库出错')
            console.log(error)
            this.notifyStream(stream, {
                type: 'queryKB',
                statusInfo: 'completed',
                promptInfo: '知识库检索失败，请稍后重试',
                fileList: [],
            })
            return undefined
        } finally {
            stream.end()
        }
    }
    // 查询用户的会话列表：按创建时间倒序，带首条用户消息作为标题预览
    async getSessionList(userId: Types.ObjectId){
        const sessionList = await this.chatDataModel
            .find({ userId })
            .select('createDate createTime chatList')
            .sort({ createTime: -1 })
        return sessionList.map(item => {
            // 取第一条用户消息作为会话标题（优先展示原文），最长30个字符
            const firstUserMessage = item.chatList.find(m => m.role === 'user')
            const rawTitle = firstUserMessage?.displayContent || firstUserMessage?.content || '新对话'
            return {
                sessionId: item._id.toString(),
                createDate: item.createDate,
                createTime: item.createTime,
                title: rawTitle.length > 30 ? rawTitle.slice(0, 30) + '...' : rawTitle,
                messageCount: item.chatList.length,
            }
        })
    }
    // 删除指定会话：同时清理mongodb记录和redis缓存
    async deleteSession(userId: Types.ObjectId, sessionId: string){
        if(!Types.ObjectId.isValid(sessionId)){
            return { deleted: false }
        }
        const result = await this.chatDataModel.deleteOne({ userId, _id: sessionId })
        const redisKey = `chat_history:${userId}:${sessionId}`
        await this.redis.del(redisKey)
        return { deleted: result.deletedCount > 0 }
    }
    // 查询某个会话的完整对话记录：优先redis，未命中回源mongodb并回填缓存
    async getHistory(userId: Types.ObjectId, sessionId: string){
        // 会话id不是合法的ObjectId时直接返回空，避免mongoose抛CastError
        if(!Types.ObjectId.isValid(sessionId)){
            return { sessionId, chatList: [] }
        }
        const redisKey = `chat_history:${userId}:${sessionId}`
        const cachedData = await this.redis.get(redisKey)
        if(cachedData){
            // redis里对话数据，那就直接取出来
            return { sessionId, chatList: JSON.parse(cachedData) }
        }
        // redis没有数据，那就从mongodb里取
        const chatData = await this.chatDataModel.findOne({ userId, _id: sessionId })
        const chatList = chatData?.chatList || []
        // 回填redis，3个小时过期
        await this.redis.set(redisKey, JSON.stringify(chatList), 'EX', 10800)
        return { sessionId, chatList }
    }

    // ============================================================
    // 四工具 RAG 架构 · 新流程（feature flag 守护，旧链路不受影响）
    // ============================================================

    /** 入口：意图路由 → 分发到四工具处理器 */
    private async routeAndRespond(
        messageList: MessageType[],
        stream: Response,
        userId: string,
        realSessionId: Types.ObjectId | string,
        _uploadFileList: uploadFileListType[] | undefined,
        _uploadImageList: MessageType['uploadImageList'] | undefined,
    ): Promise<MessageType | undefined> {
        const lastUser = messageList[messageList.length - 1];
        const userInput = lastUser?.content || '';

        // trace 埋点（3.1）：JSONL 落盘，失败不阻塞主流程
        const trace = createRagTrace({ user_id: userId, session_id: String(realSessionId), user_input: userInput.slice(0, 200) });

        // 1. pendingConfirmation 前置检查（防 Clarify 死循环）
        const pending = await this.getClarifyState(userId, realSessionId);
        if (pending && pending.mode === 'pending_confirmation') {
            if (isPendingExpired(pending)) {
                await this.clearClarifyState(userId, realSessionId);
            } else {
                pending.currentTurn += 1;
                const resolved = handlePendingConfirmation(userInput, pending);
                if (resolved.exitPending) {
                    await this.clearClarifyState(userId, realSessionId);
                } else {
                    await this.saveClarifyState(userId, realSessionId, pending);
                }
                const effectiveInput = resolved.resolvedQuery ?? userInput;
                const effectiveList: MessageType[] = [...messageList.slice(0, -1), { role: 'user', content: effectiveInput }];
                const route = await this.intentRouter.classifyIntent(effectiveInput);
                trace.set({ pending_resolved: true, effective_input: effectiveInput.slice(0, 200) });
                const result = await this.dispatch(route, effectiveInput, effectiveList, userId, realSessionId, stream, trace);
                trace.setIf({ llm_latency_ms: this.lastLlmLatencyMs });
                trace.flush();
                return result;
            }
        }

        // 2. 正常分类
        const route = await this.intentRouter.classifyIntent(userInput);
        const result = await this.dispatch(route, userInput, messageList, userId, realSessionId, stream, trace);
        trace.setIf({ llm_latency_ms: this.lastLlmLatencyMs });
        trace.flush();
        return result;
    }

    private async dispatch(
        route: IntentRouteResult,
        userInput: string,
        messageList: MessageType[],
        userId: string,
        realSessionId: Types.ObjectId | string,
        stream: Response,
        trace?: ReturnType<typeof createRagTrace>,
    ): Promise<MessageType | undefined> {
        const plan = this.intentRouter.buildExecutionPlan(route, userInput);
        trace?.set({
            intent: route.intent,
            route_confidence: route.confidence,
            internal_strategy: plan.internalStrategy,
            hybrid: route.hybrid ?? false,
        });
        switch (route.intent) {
            case 'clarify':
                return this.handleClarify(userInput, messageList, userId, realSessionId, stream, trace);
            case 'fact':
                return this.handleFact(userInput, messageList, userId, stream, trace);
            case 'perspective':
                if (plan.internalStrategy === 'hybrid') {
                    return this.executeWithHybridStrategy(userInput, messageList, userId, stream, trace);
                }
                return this.handlePerspective(userInput, messageList, userId, stream, undefined, trace);
            default:
                return this.handleFact(userInput, messageList, userId, stream, trace);
        }
    }

    // --------- Tool 1: Clarify（无 RAG） ---------
    private async handleClarify(
        userInput: string,
        messageList: MessageType[],
        userId: string,
        sessionId: Types.ObjectId | string,
        stream: Response,
        trace?: ReturnType<typeof createRagTrace>,
    ): Promise<MessageType | undefined> {
        const context = this.buildContextString(messageList);
        const clarification = await this.generateClarification(userInput, context);
        trace?.set({ clarify_generated: true, clarification_text: clarification.display_text.slice(0, 200) });
        // 设置 pendingConfirmation 状态（防死循环）
        const state = createClarifyState(sessionId.toString(), clarification.inferred_intents);
        await this.saveClarifyState(userId, sessionId, state);

        this.notifyStream(stream, { type: 'answer', content: clarification.display_text });
        stream.end();
        return { role: 'assistant', content: clarification.display_text };
    }

    private async generateClarification(
        userInput: string,
        context: string,
    ): Promise<{ display_text: string; inferred_intents: Array<{ text: string; confidence: number }>; entity_pool: string[] }> {
        const skillPrompt = await this.skillLoader.loadFullPrompt('clarify');
        try {
            const res = await this.openai.chat.completions.create({
                model: this.textModel,
                messages: [
                    {
                        role: 'system',
                        content:
                            `${skillPrompt}\n\n请基于以下对话上下文生成自然语言反问。硬性约束：候选项实体必须来自上下文实体池，不得引入新实体。` +
                            `以 JSON 输出：{"display_text":"...","inferred_intents":[{"text":"...","confidence":0.8}],"entity_pool":["..."]}`,
                    },
                    { role: 'user', content: `上下文：\n${context}\n\n用户输入：${userInput}` },
                ],
                temperature: 0.4,
                max_tokens: 600,
                response_format: { type: 'json_object' },
            });
            const raw = res.choices?.[0]?.message?.content?.trim() || '';
            const parsed = JSON.parse(raw);
            const display_text =
                typeof parsed.display_text === 'string'
                    ? parsed.display_text
                    : '你可以告诉我你想了解的具体问题吗？';
            const inferred_intents = Array.isArray(parsed.inferred_intents)
                ? parsed.inferred_intents
                      .filter((x: any) => x && typeof x.text === 'string')
                      .map((x: any) => ({ text: x.text, confidence: typeof x.confidence === 'number' ? x.confidence : 0.7 }))
                : [];
            const entity_pool = Array.isArray(parsed.entity_pool) ? parsed.entity_pool.filter((x: any) => typeof x === 'string') : [];
            // Task #5: 服务端实体封闭性硬校验——display_text 不得引入实体池之外的实体（如凭空冒出 CNN/LSTM）。
            // 命中泄漏时用实体池直接重建反问文本，彻底杜绝新实体外泄。
            const enforced = this.enforceEntityClosure(display_text, entity_pool);
            if (!enforced.ok) {
                console.warn('[Clarify] 检测到实体池外泄漏，已用实体池重建反问文本');
            }
            return { display_text: enforced.safeText, inferred_intents, entity_pool };
        } catch (e) {
            console.warn('[Clarify] 生成失败，返回通用反问:', (e as Error).message);
            const fallback = '你好！你可以告诉我你想了解什么研究方向吗？比如检索某篇论文、解读一个文档、或者询问某个学术概念？';
            return { display_text: fallback, inferred_intents: [], entity_pool: [] };
        }
    }

    // --------- Tool 2: Fact-Retriever（强绑定 RAG） ---------
    private async handleFact(
        userQuestion: string,
        messageList: MessageType[],
        userId: string,
        stream: Response,
        trace?: ReturnType<typeof createRagTrace>,
    ): Promise<MessageType | undefined> {
        this.notifyStream(stream, { type: 'queryKB', statusInfo: 'inProgress', promptInfo: '正在检索知识库', fileList: [] });
        let answerContent = '';
        let kbReadFileData: MessageType['readFileData'] | undefined;
        try {
            const { hits, hasFactualBasis, kbContent, stats } = await this.retrieveFact(userQuestion, userId);
            trace?.setIf({
                retrieval: {
                    candidates: stats.totalCandidates,
                    above_threshold: stats.aboveThreshold,
                    low_confidence: stats.lowConfidence,
                    top_scores: stats.topScores,
                },
                has_factual_basis: hasFactualBasis,
            });
            const hitFileNames = [...new Set(hits.map((h) => h.docTitle).filter(Boolean))] as string[];
            kbReadFileData = {
                type: 'queryKB',
                statusInfo: 'completed',
                promptInfo: hits.length > 0 ? '知识库检索完成' : '知识库未检索到相关内容',
                fileList: hitFileNames,
            };
            this.notifyStream(stream, kbReadFileData);

            // 连续 fallback 熔断（P4）
            const fbAction = await this.applyFactFallbackBreaker(userId, hasFactualBasis);
            trace?.set({ breaker_action: fbAction, fallback_triggered: fbAction === 'reject' });

            let content = kbContent;
            if (!hasFactualBasis) {
                if (fbAction === 'reject') {
                    const msg = this.getFallbackRejectionMessage();
                    this.notifyStream(stream, { type: 'answer', content: msg });
                    stream.end();
                    return { role: 'assistant', content: msg, readFileData: kbReadFileData };
                }
                content = '&没有检索到相关文档&';
            }

            // Confidence-Checker 中间件（后处理）
            // fail 链路修复（发现 3）：preciseSearch 在 lowConfidence 时兜底取 Top1，
            // 若把兜底结果传给 check()，fail 分支（空数组）永不触发，库外问题永远判 warn。
            // 因此 hasFactualBasis=false（无命中或低置信兜底）时显式传空数组 → 正确落到 fail/reject。
            const confInput = hasFactualBasis ? hits : [];
            const conf = this.confidenceAgent.check(confInput, userQuestion);
            trace?.set({
                confidence_check: {
                    check_result: conf.check_result,
                    overall_confidence: conf.overall_confidence,
                    dimension_scores: conf.dimension_scores,
                    warnings: conf.warnings,
                    action: conf.recommended_action.action,
                },
                confidence_config_hash: this.confidenceAgent.configHash,
            });

            // Task #7: Fact 检索无命中（且未被熔断拒绝）时，服务端确定性注入 ⚠️ 前缀，
            // 明确告知回答未基于知识库，避免依赖模型自觉遵守占位符规则。
            if (!hasFactualBasis && fbAction !== 'reject') {
                const noKbPrefix =
                    '⚠️ 提示：知识库中未检索到与问题相关的资料，以下回答基于模型通用知识生成，仅供参考，请以权威来源核实。\n\n';
                this.notifyStream(stream, { type: 'answer', content: noKbPrefix });
                answerContent += noKbPrefix;
            }

            const kbMessages: MessageType[] = [
                ...messageList.slice(0, -1),
                { role: 'user', content: `知识库检索结果如下：\n${content}\n\n请基于上述检索结果回答用户问题：${userQuestion}` },
            ];
            const res = await this.callingModel(kbMessages, false, undefined, true);
            for await (const chunk of res) {
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) {
                    answerContent += delta.content;
                    this.notifyStream(stream, { type: 'answer', content: delta.content });
                }
            }
            if (!answerContent) {
                stream.end();
                return undefined;
            }
            // Confidence-Checker 判定结果落地：warn / fail 都必须在回答末尾追加标注
            const confTail = this.confidenceTail(conf);
            if (confTail) {
                answerContent += confTail;
                this.notifyStream(stream, { type: 'answer', content: confTail });
            }
            stream.end();
            return { role: 'assistant', content: answerContent, readFileData: kbReadFileData };
        } catch (error) {
            console.log('Fact-Retriever 出错', error);
            this.notifyStream(stream, { type: 'queryKB', statusInfo: 'completed', promptInfo: '知识库检索失败，请稍后重试', fileList: [] });
            stream.end();
            return undefined;
        }
    }

    /** 复用 preciseSearch 执行事实检索并返回统一结构；检索参数以 fact_retriever skill 的 retrieval_config 为准 */
    private async retrieveFact(
        userQuestion: string,
        userId: string,
    ): Promise<{
        hits: Array<{ docId: string; docTitle: string; docText: string; score: number }>;
        hasFactualBasis: boolean;
        kbContent: string;
        /** 检索统计（供 trace 埋点） */
        stats: { totalCandidates: number; aboveThreshold: number; lowConfidence: boolean; topScores: number[] };
    }> {
        const cfg = this.skillLoader.getRawConfig<{
            top_k?: number;
            rerank_threshold?: number;
            require_source?: boolean;
        }>('fact_retriever', 'retrieval_config') ?? {};
        const searchRes = await this.fileanagementService.preciseSearch(userQuestion, userId, {
            topK: cfg.top_k ?? 3,
            rerankThreshold: cfg.rerank_threshold ?? 0.75,
            requireSource: cfg.require_source ?? true,
        });
        const hits = searchRes.results || [];
        const hasFactualBasis = hits.length > 0 && !searchRes.lowConfidence;
        const kbContent = hasFactualBasis ? hits.map((h, i) => `【片段${i + 1}·${h.docTitle}】\n${h.docText}`).join('\n\n') : '';
        return {
            hits,
            hasFactualBasis,
            kbContent,
            stats: {
                totalCandidates: searchRes.totalCandidates,
                aboveThreshold: searchRes.aboveThreshold,
                lowConfidence: searchRes.lowConfidence,
                topScores: hits.map((h) => Math.round(h.score * 100) / 100),
            },
        };
    }

    // --------- Tool 3: Perspective-Analyzer（松耦合 RAG） ---------
    private async handlePerspective(
        userQuestion: string,
        messageList: MessageType[],
        userId: string,
        stream: Response,
        factContext?: string,
        trace?: ReturnType<typeof createRagTrace>,
    ): Promise<MessageType | undefined> {
        this.notifyStream(stream, { type: 'queryKB', statusInfo: 'inProgress', promptInfo: '正在多维检索知识库', fileList: [] });
        let answerContent = '';
        let kbReadFileData: MessageType['readFileData'] | undefined;
        try {
            const dims = await this.perspectiveAgent.splitDimensions(factContext ? `${userQuestion}\n已知事实：${factContext}` : userQuestion);
            // 收敛式并发：每个维度独立包裹 catch，任何一维异常/超时都不会拖垮整条 perspective 链路
            const results = await Promise.all(
                dims.map((d) =>
                    this.perspectiveAgent.retrieveDimension(d, userId, factContext).catch((err) => {
                        console.warn('[Perspective] 维度收敛兜底，已跳过:', d.name, (err as Error)?.message);
                        return {
                            name: d.name,
                            status: 'error' as const,
                            sources: [],
                            rawText: '',
                            confidence: 0,
                            summarized: false,
                            note: '该维度检索出错，已跳过',
                        } as DimensionResult;
                    }),
                ),
            );
            trace?.setIf({
                dimensions: results.map((r) => ({
                    name: r.name,
                    status: r.status,
                    sources: r.sources.length,
                    summarized: r.summarized,
                    confidence: Math.round(r.confidence * 100) / 100,
                })),
            });
            const hitFileNames = [...new Set(results.flatMap((r) => r.sources.map((s) => s.doc_title)))] as string[];

            // 流式聚合（streaming_aggregation）：按维度到达顺序（Promise.all 保序）逐个生成分析并流式输出（先到先输出）。
            // 每个维度独立一次模型调用：先完成的维度先把分析推给前端，后续维度可见前面已生成的摘要作为上下文。
            // 文件列表受前端单槽位约束，仅在最后统一发送一次（见下方 notifyStream）。
            const priorSummaries: string[] = [];
            const allSources: Array<{ docTitle?: string; docText?: string }> = [];
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                allSources.push(...r.sources.map((s) => ({ docTitle: s.doc_title, docText: s.excerpt })));
                const isLast = i === results.length - 1;
                const dimPrompt = this.buildDimensionPrompt(r, priorSummaries.join('\n\n'), factContext, userQuestion, isLast);
                const kbMessages: MessageType[] = [...messageList.slice(0, -1), { role: 'user', content: dimPrompt }];
                const res = await this.callingModel(kbMessages, false, undefined, true);
                let dimText = '';
                for await (const chunk of res) {
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) {
                        dimText += delta.content;
                        this.notifyStream(stream, { type: 'answer', content: delta.content });
                    }
                }
                priorSummaries.push(`## ${r.name}\n${dimText}`);
                answerContent += dimText;
            }

            // 文件列表仅最后发送一次（前端 readFileData 单槽位，多次发送会互相覆盖）
            kbReadFileData = {
                type: 'queryKB',
                statusInfo: 'completed',
                promptInfo: results.some((r) => r.status === 'completed') ? '知识库检索完成' : '知识库未检索到相关内容',
                fileList: hitFileNames,
            };
            this.notifyStream(stream, kbReadFileData);

            if (!answerContent) {
                stream.end();
                return undefined;
            }
            // Confidence-Checker 判定结果落地：warn / fail 都必须在回答末尾追加标注（按 recommended_action 差异化）
            const conf = this.confidenceAgent.check(allSources, userQuestion);
            trace?.set({
                confidence_check: {
                    check_result: conf.check_result,
                    overall_confidence: conf.overall_confidence,
                    dimension_scores: conf.dimension_scores,
                    warnings: conf.warnings,
                    action: conf.recommended_action.action,
                },
                confidence_config_hash: this.confidenceAgent.configHash,
            });
            const confTail = this.confidenceTail(conf);
            if (confTail) {
                answerContent += confTail;
                this.notifyStream(stream, { type: 'answer', content: confTail });
            }
            stream.end();
            return { role: 'assistant', content: answerContent, readFileData: kbReadFileData };
        } catch (error) {
            console.log('Perspective-Analyzer 出错', error);
            this.notifyStream(stream, { type: 'queryKB', statusInfo: 'completed', promptInfo: '知识库检索失败，请稍后重试', fileList: [] });
            stream.end();
            return undefined;
        }
    }

    // --------- hybrid 内部组合：Fact 先行注入 Perspective（用户不可见） ---------
    private async executeWithHybridStrategy(
        userQuestion: string,
        messageList: MessageType[],
        userId: string,
        stream: Response,
        trace?: ReturnType<typeof createRagTrace>,
    ): Promise<MessageType | undefined> {
        const { hits, hasFactualBasis, stats } = await this.retrieveFact(userQuestion, userId);
        trace?.setIf({
            retrieval: {
                candidates: stats.totalCandidates,
                above_threshold: stats.aboveThreshold,
                low_confidence: stats.lowConfidence,
                top_scores: stats.topScores,
            },
            has_factual_basis: hasFactualBasis,
        });

        // 与 Fact 路径共用同一套连续 fallback 熔断（hybrid 不再绕过计数器）
        const fbAction = await this.applyFactFallbackBreaker(userId, hasFactualBasis);
        trace?.set({ breaker_action: fbAction, fallback_triggered: fbAction === 'reject' });
        if (!hasFactualBasis && fbAction === 'reject') {
            const msg = this.getFallbackRejectionMessage();
            this.notifyStream(stream, { type: 'answer', content: msg });
            stream.end();
            return { role: 'assistant', content: msg };
        }

        let factContext = '';
        let factIntro = '';
        if (hasFactualBasis) {
            factContext = hits.map((h, i) => `【事实${i + 1}·${h.docTitle}】${h.docText}`).join('\n');
            factIntro = `📌 事实确认（来自知识库）：\n${hits.map((h) => `- ${h.docTitle}：${h.docText.slice(0, 120)}...`).join('\n')}\n\n`;
            this.notifyStream(stream, { type: 'answer', content: factIntro });
        }
        const result = await this.handlePerspective(userQuestion, messageList, userId, stream, factContext || undefined, trace);
        // 落库内容与用户实际看到的一致：事实确认区 + 多维评价区
        if (result && factIntro) {
            result.content = factIntro + result.content;
        }
        return result;
    }

    // --------- 工具方法 ---------
    private buildContextString(messageList: MessageType[]): string {
        return messageList
            .slice(-6, -1)
            .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
            .join('\n');
    }

    /** 中文二元组（bigram），用于实体/短语间的子串重叠判断 */
    private bigrams(s: string): Set<string> {
        const clean = s.replace(/[\s，。？！、；;：""''（）()\[\]【】\n]/g, '');
        const set = new Set<string>();
        if (clean.length <= 1) {
            if (clean) set.add(clean);
            return set;
        }
        for (let i = 0; i + 2 <= clean.length; i++) set.add(clean.slice(i, i + 2));
        return set;
    }

    private tokenOverlap(a: string, b: string): boolean {
        const ba = this.bigrams(a);
        const bb = this.bigrams(b);
        for (const g of ba) if (bb.has(g)) return true;
        return false;
    }

    /** 抽取 display_text 中「类术语」片段：连续英文/数字词 + 中英文引号/书名号包裹的短语 */
    private extractTermLike(text: string): string[] {
        const terms: string[] = [];
        const en = text.match(/[A-Za-z0-9]{2,}/g);
        if (en) terms.push(...en);
        const quoted = text.match(/[「『""''【】《》]([^「『""''【】《》]{1,30})[」』""''】》]/g);
        if (quoted) terms.push(...quoted.map((q) => q.slice(1, -1)));
        return [...new Set(terms)].filter((t) => t.trim().length > 0);
    }

    /**
     * 实体封闭性硬校验（服务端兜底，不依赖模型自觉）：
     * 1) display_text 必须至少包含实体池中的一个实体，否则视为脱离上下文；
     * 2) 显式术语（英文术语 / 引号短语）不得出现在实体池之外（防凭空引入 CNN/LSTM 等新实体）。
     * 任一违例即判定泄漏，返回 ok:false 并给出由实体池重建的安全文本。
     */
    private enforceEntityClosure(
        displayText: string,
        entityPool: string[],
    ): { ok: boolean; safeText: string } {
        if (!displayText || entityPool.length === 0) return { ok: true, safeText: displayText };
        if (!entityPool.some((e) => displayText.includes(e))) {
            return this.rebuildFromPool(entityPool);
        }
        const terms = this.extractTermLike(displayText);
        const leak = terms.some((t) => {
            const lower = t.toLowerCase();
            return !entityPool.some(
                (e) => e.toLowerCase().includes(lower) || lower.includes(e.toLowerCase()) || this.tokenOverlap(t, e),
            );
        });
        return leak ? this.rebuildFromPool(entityPool) : { ok: true, safeText: displayText };
    }

    private rebuildFromPool(entityPool: string[]): { ok: boolean; safeText: string } {
        const entities = entityPool.slice(0, 3).join('、');
        return {
            ok: false,
            safeText: `你想进一步了解关于【${entities}】的哪方面呢？比如它的实现细节、不同观点，还是和其他概念的对比？`,
        };
    }

    /**
     * 构建单个维度的生成提示（流式聚合用）。
     * 注入：已知事实基线、前面已完成维度的摘要（渐进式上下文）、当前维度的检索材料/状态、整体结论指令（最后一维）。
     */
    private buildDimensionPrompt(
        r: DimensionResult,
        priorSummaries: string,
        factContext: string | undefined,
        userQuestion: string,
        isLast: boolean,
    ): string {
        const factNote = factContext ? `已知事实基线（请在此基础上展开，不要重复陈述已知事实）：\n${factContext}\n\n` : '';
        const priorNote = priorSummaries ? `前面维度已完成的简要分析：\n${priorSummaries}\n\n` : '';
        const statusNote =
            r.status === 'completed'
                ? `本维度检索材料：\n${r.rawText}`
                : r.status === 'timeout'
                  ? '（该维度检索超时，请基于你的通用知识补充，并明确说明这属于模型知识而非知识库内容）'
                  : r.status === 'error'
                    ? '（该维度检索出错，请基于你的通用知识补充）'
                    : '（该维度在知识库中未检索到相关内容，请基于你的通用知识补充）';
        const lastNote = isLast ? '\n\n最后，请基于以上各维度给出一句整体结论。' : '';
        return (
            `${factNote}${priorNote}` +
            `用户评价类问题：${userQuestion}\n\n` +
            `请针对「${r.name}」维度展开分析，引用来源标题、分点陈述、保持客观。\n${statusNote}${lastNote}`
        );
    }

    /** Fact 连续 fallback 熔断：更新计数器并返回本轮动作（Fact 与 hybrid 路径共用） */
    private async applyFactFallbackBreaker(userId: string, hasFactualBasis: boolean): Promise<'allow' | 'reject'> {
        const counter = await this.getFallbackCounter(userId);
        const fb = onFactResult(hasFactualBasis, counter);
        await this.setFallbackCounter(userId, fb.counter);
        return fb.action;
    }

    /** 熔断拒绝文案：以 fact_retriever skill 的 fallback_config 为准，代码内为兜底默认值 */
    private getFallbackRejectionMessage(): string {
        const cfg = this.skillLoader.getRawConfig<{ rejection_message?: string }>('fact_retriever', 'fallback_config');
        return (
            cfg?.rejection_message ??
            '我在你的知识库中没有找到与这个问题相关的资料。如果你手头有相关文档，可以上传到知识库后再问我，这样我能给你更准确的回答。'
        );
    }

    /**
     * Confidence-Checker 判定结果 → 追加在回答末尾的标注。
     * warn：标准不确定性标注；fail：使用推荐的 user_message 做强提示（回答已流式产出，无法撤回，故以标注降级代替拒绝）。
     */
    /**
     * Confidence-Checker 判定结果 → 追加在回答末尾的标注。
     * 按 recommended_action 类型差异化输出（R3 四类可执行动作 + fail 拒绝文案）。
     * warn/fail 都必须在回答末尾追加标注；pass 不追加。
     */
    private confidenceTail(conf: ConfidenceCheckResult): string {
        const act = conf.recommended_action;
        switch (act.action) {
            case 'proceed':
                return '';
            case 'annotate_with_uncertainty':
                return '\n\n**依据强度提示**：本回答的部分论点缺乏直接的文献支撑，建议以原始文献为准。';
            case 'narrow_claim_scope':
                return (
                    '\n\n**依据强度提示**：' +
                    (act.user_message ?? '部分引用信息不完整，相关论断已尽量收窄表述范围，请以原始文献为准。')
                );
            case 'suggest_more_sources':
                return (
                    '\n\n**依据强度提示**：' +
                    (act.user_message ?? '目前支撑该结论的来源较为单一，建议上传更多相关文档以获得更全面的分析。')
                );
            case 'highlight_conflict':
                return (
                    '\n\n**依据强度提示**：' +
                    (act.user_message ?? '不同来源在相关论点上存在分歧，请交叉核对原始文献后再下结论。')
                );
            case 'reject_or_fallback':
                console.warn('[ConfidenceChecker] fail:', JSON.stringify(conf.dimension_scores), conf.warnings.join(','));
                return '\n\n**依据强度提示**：' + (act.user_message ?? '现有资料不足以支撑对该问题的可靠分析，建议以原始文献为准或补充更多文档。');
            default:
                return '';
        }
    }

    // --------- Redis 状态存储 ---------
    private clarifyKey(userId: string, sessionId: Types.ObjectId | string): string {
        return `chat_clarify:${userId}:${sessionId}`;
    }
    private fallbackKey(userId: string): string {
        return `chat_fallback:${userId}`;
    }
    private async getClarifyState(userId: string, sessionId: Types.ObjectId | string): Promise<ClarifyState | null> {
        const raw = await this.redis.get(this.clarifyKey(userId, sessionId));
        return raw ? (JSON.parse(raw) as ClarifyState) : null;
    }
    private async saveClarifyState(userId: string, sessionId: Types.ObjectId | string, state: ClarifyState): Promise<void> {
        await this.redis.set(this.clarifyKey(userId, sessionId), JSON.stringify(state), 'EX', 180);
    }
    private async clearClarifyState(userId: string, sessionId: Types.ObjectId | string): Promise<void> {
        await this.redis.del(this.clarifyKey(userId, sessionId));
    }
    private async getFallbackCounter(userId: string): Promise<FallbackCounter> {
        const raw = await this.redis.get(this.fallbackKey(userId));
        return raw ? (JSON.parse(raw) as FallbackCounter) : { count: 0, lastResetAt: Date.now() };
    }
    private async setFallbackCounter(userId: string, counter: FallbackCounter): Promise<void> {
        await this.redis.set(this.fallbackKey(userId), JSON.stringify(counter), 'EX', 1800);
    }
}
