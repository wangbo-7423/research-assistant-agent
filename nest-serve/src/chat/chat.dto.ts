import { Type } from "class-transformer";
import { IsString, IsNotEmpty, IsOptional, IsArray, ArrayNotEmpty, ValidateNested, IsBoolean, IsIn } from "class-validator";
import { Types } from "mongoose";

// 上传的文件列表
export class UploadFileDto {
    // 文件名称
    @IsString({message: 'fileName必须是字符串'})
    @IsNotEmpty({message: '文件名称不能为空'})
    fileName: string;

    // 文件名称
    @IsString({message: 'fileSize必须是字符串'})
    @IsNotEmpty({message: '文件大小不能为空'})
    fileSize: string;

    // 文件类型
    @IsString({message: 'fileType必须是字符串'})
    @IsNotEmpty({message: '文件类型不能为空'})
    fileType: string;

    // 文件id
    @IsString({message: 'docId必须是字符串'})
    @IsNotEmpty({message: '文件id不能为空'})
    docId: string;
}

// 上传的图片字段类型
class UploadImageDto {
    // 图片名称
    @IsString({message: 'imagePath必须是字符串'})
    @IsNotEmpty({message: '图片路径不能为空'})
    imagePath: string;

    // 图片 MIME 类型
    @IsString({message: 'mimetype必须是字符串'})
    @IsIn(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'], {message: '仅支持 JPEG、PNG、WEBP 图片'})
    mimetype: string;

    // 图片预览地址
    @IsString({message: 'imageUrl必须是字符串'})
    @IsNotEmpty({message: '图片地址不能为空'})
    imageUrl: string;
}

// 用户发来的消息字段
export class SendMessageQueryDto {
    // 用户发送的纯文本
    @IsString({message: 'content必须是字符串'})
    @IsNotEmpty({message: '请输入问题'})
    content: string;

    // 携带的文件列表
    @IsOptional()
    @IsArray({message: 'uploadFileList必须是数组类型'})
    @ArrayNotEmpty({message: '上传的文件不能为空'})
    @ValidateNested({ each: true })// 验证数组中的每个对象
    @Type(() => UploadFileDto)// 将数组中的每个对象转换为UploadFileDto类型
    uploadFileList?: UploadFileDto[];

    // 对话id
    @IsString({message: 'sessionId必须是字符串'})
    @IsNotEmpty({message: '对话id不能为空'})
    sessionId: Types.ObjectId | 'null'

    // 是否基于知识库回答
    @IsOptional()
    @IsBoolean({message: 'isKnowledgeBased必须是布尔类型'})
    isKnowledgeBased?: boolean

    // 携带的图片对象（当前一次识别一张图片）
    @IsOptional()
    @ValidateNested()
    @Type(() => UploadImageDto)
    uploadImageList?: UploadImageDto;
}

// 查询历史对话的参数
export class GetHistoryQueryDto {
    // 对话id
    @IsString({message: 'sessionId必须是字符串'})
    @IsNotEmpty({message: '对话id不能为空'})
    sessionId: string;
}