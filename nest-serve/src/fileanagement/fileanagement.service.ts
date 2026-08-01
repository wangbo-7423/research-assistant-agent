// fileanagement.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Fileanagement } from './fileanagement.schema';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path, { join } from 'path';
import { randomBytes } from 'crypto';
import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node";
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as fs from 'fs';
import { resolveStoredImagePath } from './image-storage';

@Injectable()
export class FileanagementService {
    private milvusClient: MilvusClient;
    private openai: OpenAI;
    private embeddingModel: string;
    // 通义千问 text-embedding-v3 仅支持 [64, 128, 256, 512, 768, 1024]，默认 1024
    // 注意：此值必须与 Milvus 集合中 docVector 字段的 dim 保持一致
    private readonly embeddingDimension: number;
    private readonly BATCH_SIZE = 10; // 通义千问 API 限制每批最多 10 个

    constructor(
        @InjectModel(Fileanagement.name)
        private readonly fileanagementModel: Model<Fileanagement>,
        private configService: ConfigService
    ) {
        // 初始化 Milvus 客户端
        this.milvusClient = new MilvusClient({
            address: this.configService.get<string>('MILVUS_ADDRESS') || 'localhost:19530',
        });

        // 初始化 OpenAI 客户端（实际调用通义千问）
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

        this.embeddingModel = this.configService.get<string>('QWEN_EMBEDDING_MODEL') || 'text-embedding-v3';
        this.embeddingDimension = Number(this.configService.get<string>('QWEN_EMBEDDING_DIMENSIONS')) || 1024;

        // 初始化 DeepSeek 客户端：用于从用户问题中提取检索关键词（LLM 理解语义优于规则滑窗）
        const deepseekApiKey = this.configService.get<string>('DEEPSEEK_API_KEY');
        if (deepseekApiKey) {
            this.deepseek = new OpenAI({
                apiKey: deepseekApiKey,
                baseURL: this.configService.get<string>('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1',
                timeout: 30000,
                maxRetries: 1,
            });
        }
        this.deepseekModel = this.configService.get<string>('DEEPSEEK_MODEL') || 'deepseek-chat';
    }

    private deepseek: OpenAI | null = null;
    private deepseekModel: string;

    // 生成单个文本的向量（用于查询）
    private async embedQuery(text: string): Promise<number[]> {
        try {
            const response = await this.openai.embeddings.create({
                model: this.embeddingModel,
                input: text,
                encoding_format: 'float',
                dimensions: this.embeddingDimension,
            });

            if (!response.data || response.data.length === 0) {
                throw new Error('OpenAI API 返回数据为空');
            }

            return response.data[0].embedding;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`生成查询向量失败: ${error.message}`);
            }
            throw new Error('生成查询向量失败: 未知错误');
        }
    }

    // 批量生成多个文本的向量（分批处理，每批最多 10 个）
    private async embedDocuments(texts: string[]): Promise<number[][]> {
        if (!texts || texts.length === 0) {
            return [];
        }

        try {
            const allVectors: number[][] = [];

            // 分批处理
            for (let i = 0; i < texts.length; i += this.BATCH_SIZE) {
                const batch = texts.slice(i, i + this.BATCH_SIZE);

                console.log(`处理批次 ${Math.floor(i / this.BATCH_SIZE) + 1}/${Math.ceil(texts.length / this.BATCH_SIZE)}, 数量: ${batch.length}`);

                const response = await this.openai.embeddings.create({
                    model: this.embeddingModel,
                    input: batch,
                    encoding_format: 'float',
                    dimensions: this.embeddingDimension,
                });

                if (!response.data || response.data.length === 0) {
                    throw new Error(`批次 ${Math.floor(i / this.BATCH_SIZE) + 1} API 返回数据为空`);
                }

                // 按索引排序，确保顺序正确
                const sortedData = response.data.sort((a, b) => a.index - b.index);
                const batchVectors = sortedData.map(item => item.embedding);

                // 阿里 API 可能跳过空文本导致返回数量不足，降级为逐条生成补齐
                if (batchVectors.length !== batch.length) {
                    console.warn(`批次 ${Math.floor(i / this.BATCH_SIZE) + 1} 返回数量不符: 期望 ${batch.length}, 实际 ${batchVectors.length}，降级为逐条生成`);
                    batchVectors.length = 0;
                    for (const text of batch) {
                        const single = await this.openai.embeddings.create({
                            model: this.embeddingModel,
                            // 空文本用占位符替代，避免 API 拒绝
                            input: text.trim() ? text : ' ',
                            encoding_format: 'float',
                            dimensions: this.embeddingDimension,
                        });
                        if (!single.data || single.data.length === 0) {
                            throw new Error('逐条生成向量时 API 返回数据为空');
                        }
                        batchVectors.push(single.data[0].embedding);
                    }
                }

                allVectors.push(...batchVectors);
            }

            // 最终校验：向量总数必须与文本总数一致
            if (allVectors.length !== texts.length) {
                throw new Error(`向量数量(${allVectors.length})与文本数量(${texts.length})不一致`);
            }

            return allVectors;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`生成文档向量失败: ${error.message}`);
            }
            throw new Error('生成文档向量失败: 未知错误');
        }
    }

    // 主上传方法
    async handleUpload(files: Express.Multer.File[], user: any, body: any) {
        const uploadType: 'UD' | 'UB' = body.uploadType || 'UD';
        const userId = user.id || user.userId || user.token;

        // 并行处理所有文件
        const results = await Promise.all(
            files.map(file => this.processFile(file, userId, uploadType))
        );

        return {
            success: true,
            message: `成功上传 ${files.length} 个文件`,
            files: results.map(r => ({
                id: r.id,
                fileName: r.fileName,
                fileSize: r.fileSize,
                fileType: r.fileType
            }))
        };
    }

    // 处理单个文件：解析 -> 存储 -> 向量化（仅知识库）
    private async processFile(
        file: Express.Multer.File,
        userId: string,
        uploadType: 'UD' | 'UB',
    ) {
        const fileType = file.mimetype === 'application/pdf' ? 'pdf' : 'docx';

        // 1. 解析文件内容
        const { mergeTexts, splitDocuments } = await this.readFile(
            file.buffer,
            fileType,
            uploadType
        );

        // 2. 保存文件到 MongoDB（只存文本，不存原始 Buffer）
        const doc = await this.fileanagementModel.create({
            userId,
            fileName: file.originalname,
            filePath: '',
            fileType,
            fileSize: file.size,
            fileText: mergeTexts,
            uploadType,
        });

        // 3. 知识库上传时生成向量并存储到 Milvus
        if (uploadType === 'UD' && splitDocuments.length > 0) {
            await this.vectorStorage(
                doc._id.toString(),
                file.originalname,
                splitDocuments,
                userId
            );
        }

        return {
            id: doc._id,
            fileName: file.originalname,
            fileSize: file.size,
            fileType,
        };
    }

    // 读取并解析文件
    async readFile(fileData: Buffer, fileType: string, uploadType: 'UD' | 'UB') {
        const tmpName = `marvis-parse-${randomBytes(8).toString('hex')}.${fileType}`;
        const tmpPath = join(tmpdir(), tmpName);
        writeFileSync(tmpPath, fileData);

        try {
            const loader = fileType === 'pdf' ? new PDFLoader(tmpPath) : new DocxLoader(tmpPath);
            const docx = await loader.load();

            let mergedText = '';
            for (let i = 0; i < docx.length; i++) {
                mergedText += docx[i].pageContent + '\n';
            }

            let splitDocuments: Document<Record<string, any>>[] = [];
            if (uploadType === 'UD') {
                const textSplitter = new RecursiveCharacterTextSplitter({
                    chunkSize: 800,
                    chunkOverlap: 100,
                });
                const fullDoc = new Document({
                    pageContent: mergedText,
                    metadata: {
                        source: 'uploaded_file',
                        fileType: fileType,
                    }
                });
                splitDocuments = await textSplitter.splitDocuments([fullDoc]);
            }

            return {
                mergeTexts: mergedText,
                splitDocuments,
            };
        } finally {
            try { unlinkSync(tmpPath); } catch (error) { /* 忽略 */ }
        }
    }

    // 创建 Milvus 集合
    async createCollection(collectionName: string) {
        const fields = [
            {
                name: 'id',
                data_type: DataType.Int64,
                is_primary_key: true,
                auto_id: false, // 部分 SDK 版本对 auto_id 主键兼容性差，改为手动生成
                description: "主键id字段"
            },
            {
                name: 'docId',
                data_type: DataType.VarChar,
                description: "文档id字段",
                max_length: 100
            },
            {
                name: 'docTitle',
                data_type: DataType.VarChar,
                description: "文档标题",
                max_length: 500
            },
            {
                name: 'docText',
                data_type: DataType.VarChar,
                description: "文档切块的片段",
                max_length: 9000
            },
            {
                name: 'docVector',
                data_type: DataType.FloatVector,
                description: "文档内容的向量",
                dim: this.embeddingDimension
            }
        ];

        await this.milvusClient.createCollection({
            collection_name: collectionName,
            fields: fields,
        });

        await this.milvusClient.createIndex({
            collection_name: collectionName,
            field_name: 'docVector',
            index_type: "IVF_FLAT",
            metric_type: "COSINE",
            params: { nlist: 128 }
        });

        await this.milvusClient.loadCollection({
            collection_name: collectionName,
        });

        return { success: true };
    }

    // 向量存储
    async vectorStorage(
        docId: string,
        docTitle: string,
        splitDocuments: Document<Record<string, any>>[],
        userId: string
    ) {
        try {
            const collectionName = `_${userId}`;

            const hasCollection = await this.milvusClient.hasCollection({
                collection_name: collectionName,
            });

            if (!hasCollection.value) {
                await this.createCollection(collectionName);
            } else {
                // 检查旧集合结构是否与当前代码兼容（auto_id 主键 / 向量维度不符），不兼容则重建
                const desc = await this.milvusClient.describeCollection({
                    collection_name: collectionName,
                });
                const fields = (desc as any)?.schema?.fields || [];
                const idField = fields.find((f: any) => f.name === 'id');
                const vectorField = fields.find((f: any) => f.name === 'docVector');
                // describeCollection 的 dim 可能在 type_params 里
                const dimParam = vectorField?.type_params?.find((p: any) => p.key === 'dim');
                const currentDim = Number(vectorField?.dim ?? dimParam?.value);

                const needAutoIdMigration = idField?.auto_id === true || idField?.autoID === true;
                const needDimMigration = Number.isFinite(currentDim) && currentDim !== this.embeddingDimension;

                if (needAutoIdMigration || needDimMigration) {
                    console.warn(
                        `集合 ${collectionName} 结构不兼容，删除重建` +
                        (needAutoIdMigration ? '（旧 auto_id 主键）' : '') +
                        (needDimMigration ? `（维度 ${currentDim} → ${this.embeddingDimension}）` : '')
                    );
                    await this.milvusClient.dropCollection({ collection_name: collectionName });
                    await this.createCollection(collectionName);
                }
            }

            const texts = splitDocuments.map(doc =>
                doc.pageContent && doc.pageContent.trim() ? doc.pageContent : ' '
            );

            // 生成向量（内部已实现分批处理）
            const vectors = await this.embedDocuments(texts);

            const insertData = splitDocuments.map((doc, index) => ({
                // 手动生成 Int64 主键：毫秒时间戳 * 100000 + 序号 + 随机数，避免冲突
                id: Date.now() * 100000 + index * 1000 + Math.floor(Math.random() * 1000),
                docId: docId,
                docTitle: docTitle,
                docText: doc.pageContent,
                docVector: vectors[index],
            }));

            const insertResult = await this.milvusClient.insert({
                collection_name: collectionName,
                data: insertData,
            });

            // 检查 insert 返回状态，Milvus SDK 不会对插入错误抛异常
            const errorCode = (insertResult as any)?.status?.error_code;
            if (errorCode && errorCode !== 'Success') {
                const reason = (insertResult as any)?.status?.reason || '未知原因';
                throw new Error(`Milvus 插入失败: [${errorCode}] ${reason}`);
            }

            await this.milvusClient.flush({
                collection_names: [collectionName],
            });

            return {
                success: true,
                insertedCount: (insertResult as any).insert_cnt || 0,
                collectionName: collectionName,
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            console.error('向量存储失败:', errorMessage);
            throw new BadRequestException(`向量存储失败: ${errorMessage}`);
        }
    }

    // 向量搜索
    async vectorSearch(
        query: string,
        userId: string,
        limit: number = 10
    ) {
        try {
            const collectionName = `_${userId}`;

            const hasCollection = await this.milvusClient.hasCollection({
                collection_name: collectionName,
            });

            if (!hasCollection.value) {
                throw new BadRequestException('用户向量集合不存在');
            }

            const queryVector = await this.embedQuery(query);

            const searchResult = await this.milvusClient.search({
                collection_name: collectionName,
                data: [queryVector],
                anns_field: 'docVector',
                param: {
                    metric_type: 'COSINE',
                    params: { nprobe: 10 },
                },
                limit: limit,
                output_fields: ['docId', 'docTitle', 'docText'],
            });

            return {
                success: true,
                results: searchResult.results,
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            throw new BadRequestException(`向量搜索失败: ${errorMessage}`);
        }
    }

    // 关键词检索：对用户问题提取关键词，在 Milvus 标量字段 docText 上做 LIKE 匹配
    async keywordSearch(
        query: string,
        userId: string,
        limit: number = 10
    ) {
        const collectionName = `_${userId}`;

        const hasCollection = await this.milvusClient.hasCollection({
            collection_name: collectionName,
        });
        if (!hasCollection.value) {
            return { success: true, results: [] };
        }

        // 提取关键词：优先 DeepSeek LLM 语义提取，失败降级为规则提取
        const keywords = await this.extractKeywords(query);
        if (keywords.length === 0) {
            return { success: true, results: [] };
        }

        // 用 OR 拼接 LIKE 条件（Milvus VarChar 支持 like '%xxx%'）
        const escaped = keywords.map(k => k.replace(/"/g, ''));
        const filter = escaped.map(k => `docText like "%${k}%"`).join(' or ');

        const queryResult = await this.milvusClient.query({
            collection_name: collectionName,
            filter,
            limit,
            output_fields: ['docId', 'docTitle', 'docText'],
        });

        return {
            success: true,
            results: (queryResult.data || []).map((item: any, rank: number) => ({
                id: item.id,
                docId: item.docId,
                docTitle: item.docTitle,
                docText: item.docText,
                score: 1 / (rank + 1), // 关键词检索无相似度分数，用名次构造递减分数
            })),
        };
    }

    // 从用户问题中提取关键词：优先调用 DeepSeek LLM 做语义提取（学术同义词/术语归一），
    // LLM 不可用或失败时降级为本地规则提取，保证检索链路不中断
    private async extractKeywords(query: string): Promise<string[]> {
        if (this.deepseek) {
            try {
                const keywords = await this.extractKeywordsByLLM(query);
                if (keywords.length > 0) {
                    return keywords;
                }
            } catch (error) {
                console.warn('DeepSeek 关键词提取失败，降级为规则提取:', (error as Error)?.message);
            }
        }
        return this.extractKeywordsByRule(query);
    }

    // LLM 提取关键词：让 DeepSeek 输出最适合知识库 LIKE 匹配的科研领域关键词
    private async extractKeywordsByLLM(query: string): Promise<string[]> {
        const response = await this.deepseek!.chat.completions.create({
            model: this.deepseekModel,
            messages: [
                {
                    role: 'system',
                    content:
                        '你是科研资料知识库检索的关键词提取器。从用户问题中提取 3~8 个最适合用于在论文、报告等科研文档中做关键词匹配的词或短语。' +
                        '要求：1. 保留方法名、模型名、数据集名、指标名、概念术语等学术实体；2. 口语表达归一为规范学术术语（如"rag检索"→"检索增强生成"）；' +
                        '3. 去除疑问词、语气词和停用词；4. 只输出 JSON 数组字符串，如 ["Transformer","自注意力机制"]，不要输出任何其他内容。',
                },
                { role: 'user', content: query },
            ],
            temperature: 0,
            max_tokens: 200,
            response_format: { type: 'json_object' },
        });

        const raw = response.choices?.[0]?.message?.content?.trim() || '';
        // 兼容模型返回 {"keywords": [...]} 或直接 [...] 两种形式
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // 从返回文本中截取第一个 JSON 数组
            const match = raw.match(/\[[\s\S]*\]/);
            if (!match) return [];
            parsed = JSON.parse(match[0]);
        }
        const list = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as any)?.keywords)
                ? (parsed as any).keywords
                : [];

        return list
            .filter((k: unknown): k is string => typeof k === 'string' && (k as string).trim().length >= 2)
            .map((k: string) => k.trim())
            .slice(0, 8);
    }

    // 规则提取（降级方案）：中英文混合，去停用词，中文 2~4 字滑窗
    private extractKeywordsByRule(query: string): string[] {
        const stopWords = new Set([
            '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
            '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
            '什么', '怎么', '哪些', '如何', '吗', '呢', '吧', '啊', '请问', '一下', '可以',
            'the', 'a', 'an', 'is', 'are', 'of', 'to', 'and', 'or', 'what', 'how', 'which',
        ]);

        // 英文/数字按词切，中文按 2~4 字滑窗
        const candidates: string[] = [];
        const enWords = query.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
        candidates.push(...enWords);

        const zhText = query.replace(/[a-z0-9\s\p{P}]/giu, '');
        for (const size of [4, 3, 2]) {
            for (let i = 0; i + size <= zhText.length; i++) {
                candidates.push(zhText.slice(i, i + size));
            }
        }

        const seen = new Set<string>();
        return candidates
            .filter(k => k.trim() && !stopWords.has(k))
            .filter(k => {
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            })
            .slice(0, 20); // 最多 20 个关键词，避免 filter 过长
    }

    // 混合检索：向量检索 + 关键词检索，用倒数排名融合（RRF）合并结果
    async hybridSearch(
        query: string,
        userId: string,
        limit: number = 5,
        options?: { vectorWeight?: number; keywordWeight?: number; rrfK?: number }
    ) {
        const collectionName = `_${userId}`;
        const hasCollection = await this.milvusClient.hasCollection({
            collection_name: collectionName,
        });
        if (!hasCollection.value) {
            // 集合不存在不代表出错：用户还没有上传知识库文件
            return { success: true, results: [], fromVector: 0, fromKeyword: 0 };
        }

        const candidateLimit = Math.max(limit * 2, 10);
        const rrfK = options?.rrfK ?? 60; // RRF 平滑常数
        const vectorWeight = options?.vectorWeight ?? 0.7; // 语义为主
        const keywordWeight = options?.keywordWeight ?? 0.3; // 关键词为辅

        // 两路检索并行，关键词检索失败不阻断主流程（降级为纯向量检索）
        const [vectorRes, keywordRes] = await Promise.all([
            this.vectorSearch(query, userId, candidateLimit),
            this.keywordSearch(query, userId, candidateLimit).catch(err => {
                console.warn('关键词检索失败，降级为纯向量检索:', err?.message);
                return { success: true, results: [] as any[] };
            }),
        ]);

        // 归一化为统一结构
        const normalize = (item: any) => ({
            docId: item.docId ?? item?.entity?.docId,
            docTitle: item.docTitle ?? item?.entity?.docTitle,
            docText: item.docText ?? item?.entity?.docText,
            score: typeof item.score === 'number' ? item.score : 0,
        });

        // RRF 融合：score = Σ weight / (k + rank)
        const fused = new Map<string, { docId: string; docTitle: string; docText: string; rrfScore: number; hitVector: boolean; hitKeyword: boolean }>();

        (vectorRes.results || []).forEach((raw: any, rank: number) => {
            const item = normalize(raw);
            if (!item.docText) return;
            const key = `${item.docId}::${item.docText.slice(0, 50)}`;
            const entry = fused.get(key) || { ...item, rrfScore: 0, hitVector: false, hitKeyword: false };
            entry.rrfScore += vectorWeight / (rrfK + rank + 1);
            entry.hitVector = true;
            fused.set(key, entry);
        });

        (keywordRes.results || []).forEach((raw: any, rank: number) => {
            const item = normalize(raw);
            if (!item.docText) return;
            const key = `${item.docId}::${item.docText.slice(0, 50)}`;
            const entry = fused.get(key) || { ...item, rrfScore: 0, hitVector: false, hitKeyword: false };
            entry.rrfScore += keywordWeight / (rrfK + rank + 1);
            entry.hitKeyword = true;
            fused.set(key, entry);
        });

        const results = [...fused.values()]
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, limit);

        return {
            success: true,
            results,
            fromVector: (vectorRes.results || []).length,
            fromKeyword: (keywordRes.results || []).length,
        };
    }

    // 高精度单路检索（Fact-Retriever 专用）：在混合检索候选集上做阈值过滤 + TopK 截断
    // 注：当前后端用 RRF 融合分近似 rerank 分数；后续接入独立 Rerank 模型时，
    //     将候选集交给 Cross-Encoder 打分并替换下面的 score 计算即可（接口保持不变）。
    async preciseSearch(
        query: string,
        userId: string,
        options?: { topK?: number; rerankThreshold?: number; requireSource?: boolean },
    ): Promise<{
        success: boolean;
        results: Array<{ docId: string; docTitle: string; docText: string; score: number }>;
        totalCandidates: number;
        aboveThreshold: number;
        lowConfidence: boolean; // 过滤后不足 1 条，已兜底取 Top1
    }> {
        const topK = options?.topK ?? 3;
        const rerankThreshold = options?.rerankThreshold ?? 0.75;
        const requireSource = options?.requireSource ?? true;

        // 1. 取更宽的候选集做阈值过滤
        const candidateLimit = Math.max(topK * 4, 12);
        const fused = await this.hybridSearch(query, userId, candidateLimit);
        const candidates = (fused.results || []).filter((r) => r.docText && (!requireSource || r.docTitle));

        if (candidates.length === 0) {
            return { success: true, results: [], totalCandidates: 0, aboveThreshold: 0, lowConfidence: false };
        }

        // 2. 优先用 DashScope Rerank 真实打分（Task #8）；失败/未配置时降级回 RRF 融合分归一化近似
        const reranked = await this.rerank(
            query,
            candidates.map((c) => c.docText),
            candidates.length,
        );
        let scored: Array<{ docId: string; docTitle: string; docText: string; score: number }>;
        if (reranked && reranked.length) {
            scored = reranked
                .map((r) => {
                    const c = candidates[r.index];
                    if (!c) return null;
                    return { docId: c.docId, docTitle: c.docTitle, docText: c.docText, score: r.score };
                })
                .filter((x): x is { docId: string; docTitle: string; docText: string; score: number } => x !== null);
        } else {
            // 降级：RRF 融合分归一化到 [0,1] 作为 rerank 近似分
            const maxScore = Math.max(...candidates.map((c) => (c as any).rrfScore ?? 0), 1e-9);
            scored = candidates.map((c) => ({
                docId: c.docId,
                docTitle: c.docTitle,
                docText: c.docText,
                score: Math.min(1, ((c as any).rrfScore ?? 0) / maxScore),
            }));
        }

        // 3. 阈值过滤
        let passed = scored.filter((s) => s.score >= rerankThreshold);

        // 4. 兜底：过滤后不足 1 条 → 取 Top1 并标记低置信度
        let lowConfidence = false;
        if (passed.length < 1) {
            passed = [scored[0]];
            lowConfidence = true;
        }

        return {
            success: true,
            results: passed.slice(0, topK),
            totalCandidates: candidates.length,
            aboveThreshold: scored.filter((s) => s.score >= rerankThreshold).length,
            lowConfidence,
        };
    }

    /**
     * Task #8: DashScope 真实精排（Rerank）。
     * 默认模型 qwen3-rerank（gte-rerank 已于 2026-05-30 停用，官方建议迁移到 qwen3-rerank），
     * 通过 OpenAI 兼容端点 /reranks 调用。模型名与端点均可经环境变量覆盖：
     *   DASHSCOPE_RERANK_MODEL（默认 qwen3-rerank）、
     *   DASHSCOPE_RERANK_ENDPOINT（默认 https://dashscope.aliyuncs.com/compatible-api/v1/reranks）。
     * 任何失败（无 key / 网络异常 / 非 200 / 解析失败）均返回 null，
     * 由 preciseSearch 自动降级回 RRF 融合分近似，保证检索链路不中断。
     */
    async rerank(
        query: string,
        docs: string[],
        topN?: number,
    ): Promise<Array<{ index: number; score: number }> | null> {
        const apiKey = this.configService.get<string>('QWEN_API_KEY');
        if (!apiKey || docs.length === 0) return null;
        const model = this.configService.get<string>('DASHSCOPE_RERANK_MODEL') || 'qwen3-rerank';
        const endpoint =
            this.configService.get<string>('DASHSCOPE_RERANK_ENDPOINT') ||
            'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, query, documents: docs, top_n: topN ?? docs.length }),
                signal: AbortSignal.timeout(8000),
            });
            if (!resp.ok) {
                console.warn('[Rerank] 端点返回非 200，降级回 RRF:', resp.status);
                return null;
            }
            const json = (await resp.json()) as any;
            // 兼容两种响应结构：qwen3-rerank 的 data[] 与旧 gte-rerank-v2 的 output.results[]
            const data = Array.isArray(json?.data)
                ? json.data
                : Array.isArray(json?.output?.results)
                  ? json.output.results
                  : null;
            if (!data) return null;
            const out = data
                .map((d: any) => {
                    const index = typeof d.index === 'number' ? d.index : d?.document?.index ?? d?.idx;
                    const score = typeof d.relevance_score === 'number' ? d.relevance_score : undefined;
                    return { index, score };
                })
                .filter((d: any) => typeof d.index === 'number' && typeof d.score === 'number');
            return out.length ? out : null;
        } catch (e) {
            console.warn('[Rerank] 调用失败，降级回 RRF:', (e as Error)?.message);
            return null;
        }
    }

    // 获取文件内容（从 MongoDB）
    async getFileContent(fileId: string) {
        const file = await this.fileanagementModel.findById(fileId);
        if (!file) {
            throw new BadRequestException('文件不存在');
        }
        return {
            id: file._id,
            fileName: file.fileName,
            fileText: file.fileText,
            fileType: file.fileType,
            fileSize: file.fileSize,
            uploadType: file.uploadType,
        };
    }

    // 删除文件（知识库文件同时删除 Milvus 向量，对话框文件仅删 MongoDB）
    async deleteFile(fileId: string, userId: string, expectedType?: 'UD' | 'UB') {
        // 1. 先查询文件，校验归属和类型，防止越权删除他人文件
        const file = await this.fileanagementModel.findById(fileId);
        if (!file) {
            throw new BadRequestException('文件不存在或已被删除');
        }
        if (file.userId !== userId) {
            throw new BadRequestException('无权删除该文件');
        }
        if (expectedType && file.uploadType !== expectedType) {
            throw new BadRequestException('文件类型与删除接口不匹配');
        }

        // 2. 知识库文件先删 Milvus 向量，成功后再删 MongoDB，避免向量残留
        if (file.uploadType === 'UD') {
            try {
                const collectionName = `_${userId}`;
                const hasCollection = await this.milvusClient.hasCollection({
                    collection_name: collectionName,
                });
                if (hasCollection.value) {
                    await this.milvusClient.delete({
                        collection_name: collectionName,
                        filter: `docId == "${fileId}"`,
                    });
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : '未知错误';
                console.error('删除向量失败:', errorMessage);
                throw new BadRequestException(`删除向量失败: ${errorMessage}，请重试`);
            }
        }

        // 3. 删除 MongoDB 记录
        await this.fileanagementModel.findByIdAndDelete(fileId);

        return { success: true, message: '文件已删除' };
    }

    // 保存文件
    async saveFiles(
        files: Express.Multer.File[],
        userId: string,
        uploadType: 'UD' | 'UB',
    ) {
        const docs = files.map(f => ({
            userId,
            fileName: f.originalname,
            filePath: '',
            fileType: f.mimetype,
            fileSize: f.size,
            fileText: '',
            uploadType,
        }));
        return this.fileanagementModel.insertMany(docs);
    }

    // 获取知识库文件列表
    async getKbFileList(userId: string) {
        return this.fileanagementModel.aggregate([
            { $match: { userId, uploadType: 'UD' } },
            {
                $project: {
                    id: '$_id',
                    fileName: 1,
                    fileSize: 1,
                    fileType: 1,
                    _id: 0,
                },
            },
        ]);
    }

    // 上传单个文件
    async uploadFile(
        file: Express.Multer.File,
        userId: string,
        fileText: string,
        uploadType: 'UD' | 'UB',
    ) {
        const fileType = file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
        const docId = await this.fileanagementModel.create({
            userId,
            fileName: file.originalname,
            filePath: '',
            fileType,
            fileSize: file.size,
            fileText,
            uploadType,
        })
        return docId._id;
    }
    deleteImage(imagePath:string){
        try{
            // 删除前限制在 uploads-image 目录内，避免客户端传入任意服务器路径
            const { absolutePath } = resolveStoredImagePath(imagePath);
            fs.unlinkSync(absolutePath);
            return { message: '图片删除成功', data: { success: true } };
        }catch (error) {
            if (error instanceof BadRequestException) {
                throw error;
            }
            return { message: '图片删除失败', data: { success: false } };
        }
    }
}
