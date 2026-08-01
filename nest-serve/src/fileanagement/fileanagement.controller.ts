// fileanagement.controller.ts
import {
    Controller,
    Post,
    UseGuards,
    Req,
    Body,
    UploadedFile,
    UploadedFiles,
    BadRequestException,
    UseInterceptors,
    Get,
    Delete,
    Param,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { FileanagementService } from './fileanagement.service';
import { diskStorage, memoryStorage } from 'multer';
import { ConfigService } from '@nestjs/config';
import { DeleteImageDto } from "./fileanagement.dto"
import { Request } from 'express';
import {
    ALLOWED_IMAGE_TYPES,
    IMAGE_PUBLIC_ROUTE,
    createStoredImageFilename,
    ensureImageUploadDir,
    fixUtf8Filename,
    validateUploadedImage,
} from './image-storage';

const ALLOWED_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const uploadFileImage = FileInterceptor('file', {
    storage: diskStorage({
        destination: (req, file, cb) => cb(null, ensureImageUploadDir()),
        filename: (req, file, cb) => {
            file.originalname = fixUtf8Filename(file.originalname);
            cb(null, createStoredImageFilename(file.fieldname, file.mimetype));
        },
    }),
    fileFilter: (req, file, callback) => {
        if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as (typeof ALLOWED_IMAGE_TYPES)[number])) {
            return callback(
                new BadRequestException(
                    `不支持的文件类型: ${file.mimetype}。仅支持 JPEG、PNG、WEBP 图片`,
                ),
                false,
            );
        }
        callback(null, true);
    },
    limits: {
        fileSize: 1024 * 1024 * 10, // 10MB
    },
})


@Controller('fileanagement')
export class FileanagementController {
    constructor(
        private readonly fileanagementService: FileanagementService,
        private configService: ConfigService,
    ) {}

    // 知识库上传：解析 + 切片 + 向量化入 Milvus
    @Post('knowledge')
    @UseGuards(AuthGuard)
    @UseInterceptors(
        FilesInterceptor('file', 3, {
            storage: memoryStorage(),
            fileFilter: (req, file, callback) => {
                // 修复 UTF-8 文件名：multer 默认按 latin1 解码 raw bytes，
                // 导致中文文件名出现乱码（如"AIæ\x83\x85à\x86µ.docx"）。
                // 将 latin1 解码的字符串还原为原始字节，再按 UTF-8 正确解码。
                try {
                    const rawBytes = Buffer.from(file.originalname, 'latin1');
                    const utf8Name = rawBytes.toString('utf8');
                    // 仅当转换后不含替换字符时才采用（避免已经正确的文件名被二次破坏）
                    if (!utf8Name.includes('\ufffd')) {
                        file.originalname = utf8Name;
                    }
                } catch (e) {
                    console.warn('文件名编码转换失败:', e);
                }

                if (!ALLOWED_TYPES.includes(file.mimetype)) {
                    return callback(
                        new BadRequestException(
                            `不支持的文件类型: ${file.mimetype}。仅支持 PDF 和 DOCX 文件`,
                        ),
                        false,
                    );
                }
                callback(null, true);
            },
            limits: {
                fileSize: 1024 * 1024 * 5, // 5MB
            },
        }),
    )
    async uploadKnowledge(
        @UploadedFiles() files: Express.Multer.File[],
        @Req() req: any,
    ) {
        if (!files || files.length === 0) {
            throw new BadRequestException('请至少上传一个文件');
        }

        console.log('知识库上传的文件名:', files.map((f) => f.originalname));

        return this.fileanagementService.handleUpload(files, req.user, { uploadType: 'UD' });
    }

    // 对话框上传：仅解析 + 存 MongoDB，不切片、不向量化
    @Post('dialog')
    @UseGuards(AuthGuard)
    @UseInterceptors(
        FilesInterceptor('file', 3, {
            storage: memoryStorage(),
            fileFilter: (req, file, callback) => {
                // 修复 UTF-8 文件名：multer 默认按 latin1 解码 raw bytes，
                // 导致中文文件名出现乱码（如"AIæ\x83\x85à\x86µ.docx"）。
                // 将 latin1 解码的字符串还原为原始字节，再按 UTF-8 正确解码。
                try {
                    const rawBytes = Buffer.from(file.originalname, 'latin1');
                    const utf8Name = rawBytes.toString('utf8');
                    // 仅当转换后不含替换字符时才采用（避免已经正确的文件名被二次破坏）
                    if (!utf8Name.includes('\ufffd')) {
                        file.originalname = utf8Name;
                    }
                } catch (e) {
                    console.warn('文件名编码转换失败:', e);
                }

                if (!ALLOWED_TYPES.includes(file.mimetype)) {
                    return callback(
                        new BadRequestException(
                            `不支持的文件类型: ${file.mimetype}。仅支持 PDF 和 DOCX 文件`,
                        ),
                        false,
                    );
                }
                callback(null, true);
            },
            limits: {
                fileSize: 1024 * 1024 * 5, // 5MB
            },
        }),
    )
    async uploadDialog(
        @UploadedFiles() files: Express.Multer.File[],
        @Req() req: any,
    ) {
        if (!files || files.length === 0) {
            throw new BadRequestException('请至少上传一个文件');
        }

        console.log('对话框上传的文件名:', files.map((f) => f.originalname));

        return this.fileanagementService.handleUpload(files, req.user, { uploadType: 'UB' });
    }

    // 搜索接口
    @Post('search')
    @UseGuards(AuthGuard)
    async search(@Body() body: { query: string; limit?: number }, @Req() req: any) {
        const userId = req.user.id || req.user.userId || req.user.token;
        return this.fileanagementService.vectorSearch(body.query, userId, body.limit || 10);
    }

    // 获取知识库文件列表
    @Get('kbfilelist')
    @UseGuards(AuthGuard)
    async kbfileList(@Req() req: any) {
        const userId = req.user.id || req.user.userId || req.user.token;
        const res = await this.fileanagementService.getKbFileList(userId);
        return { result: res, message: 'success' };
    }

    // 获取文件内容
    @Get(':id')
    @UseGuards(AuthGuard)
    async getFile(@Param('id') id: string) {
        return this.fileanagementService.getFileContent(id);
    }

    // 删除知识库文件（MongoDB + Milvus 向量）
    @Delete('knowledge/:id')
    @UseGuards(AuthGuard)
    async deleteKnowledgeFile(@Param('id') id: string, @Req() req: any) {
        const userId = req.user.id || req.user.userId || req.user.token;
        return this.fileanagementService.deleteFile(id, userId, 'UD');
    }

    // 删除对话框文件（仅 MongoDB）
    @Delete('dialog/:id')
    @UseGuards(AuthGuard)
    async deleteDialogFile(@Param('id') id: string, @Req() req: any) {
        const userId = req.user.id || req.user.userId || req.user.token;
        return this.fileanagementService.deleteFile(id, userId, 'UB');
    }

    // 上传图片：先落盘并校验真实图片内容，再返回预览地址和识别所需的安全相对路径
    @Post('uploadimage')
    @UseGuards(AuthGuard)
    @UseInterceptors(uploadFileImage)
    uploadImage(
        @UploadedFile() file: Express.Multer.File,
        @Req() req: Request,
    ) {
        if (!file) {
            throw new BadRequestException('请选择要上传的图片');
        }
        validateUploadedImage(file);

        const configuredBaseUrl = (
            this.configService.get<string>('IMAGE_BASE_URL') ||
            this.configService.get<string>('IMAGE_BASE_URL_local') ||
            `${req.protocol}://${req.get('host')}`
        ).replace(/\/+$/, '');
        const publicBaseUrl = configuredBaseUrl.endsWith(IMAGE_PUBLIC_ROUTE)
            ? configuredBaseUrl
            : `${configuredBaseUrl}${IMAGE_PUBLIC_ROUTE}`;

        return {
            message: '图片上传成功',
            data: {
                success: true,
                image: {
                    imagePath: `uploads-image/${file.filename}`,
                    mimetype: file.mimetype,
                    imageUrl: `${publicBaseUrl}/${file.filename}`,
                },
            },
        };
    }

    // 删除图片（仅允许删除图片上传目录内的文件）
    @Post('deleteimage')
    @UseGuards(AuthGuard)
    deleteImage(
        @Body() body: DeleteImageDto
    ){
        return this.fileanagementService.deleteImage(body.imagePath)
    }

}