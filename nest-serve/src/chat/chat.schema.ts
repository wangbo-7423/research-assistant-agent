import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { UserInfo } from "../userinfo/userinfo.schema";
import dayjs from "dayjs";

@Schema({ _id:false })// 让数组中的每个对象不生成_id字段
class ReadFileData{
    // 知识库问答 or 文档阅读
    @Prop({ type: String, enum:['readDocument', 'queryKB'], required: true })
    type: 'readDocument' | 'queryKB';

    // 进行中 | 完毕
    @Prop({ type: String, enum:['inProgress', 'completed'], required: true })
    statusInfo: 'inProgress' | 'completed';

    // 服务器返回的提示
    @Prop({ type: String, required: true })
    promptInfo: string;

    // 处理的文件列表
    @Prop({
        type:[String],
        required: true
    })
    fileList: string[];
}

// 携带的图片对象字段结构
@Schema({ _id:false })// 让数组中的每个对象不生成_id字段
class ImageListType{
    // 图片路径
    @Prop({ type: String, required: true })
    imagePath: string;

    // 图片类型
    @Prop({ type: String, required: true })
    mimetype: string;

    // 图片地址
    @Prop({ type: String, required: true })
    imageUrl: string;
}
// 对话结构
@Schema({ _id:false })// 让数组中的每个对象不生成_id字段
class ChatMessage {
    //角色
    @Prop({ type: String, enum:['user', 'assistant'], required: true })
    role: 'user' | 'assistant';

    // 用户或模型消息
    @Prop({ type: String, required: true })
    content: string;

    // 原始消息
    @Prop({ type: String })
    displayContent?: string;

    // 携带的文件列表
    @Prop({ 
        type: [
            {
                fileName: { type: String , required: true },
                fileSize: { type: String , required: true },
                fileType: { type: String , required: true },
                docId: { type: String , required: true },
            }
        ],
        default: undefined
    })
    uploadFileList?: {
        fileName: string;
        fileSize: string;
        fileType: string;
        docId: string;
    }[];
    // 阅读的文档或者阅读知识库文件
    @Prop({
        type:ReadFileData, required: false
    })
    readFileData?: ReadFileData;
    // 携带的图片对象
    @Prop({
        type: ImageListType, required: false
    })
    uploadImageList?: ImageListType;
}

const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

// 用户和模型的对话存储结构
@Schema({ versionKey: false })
export class ChatData {
    // 用户id
    @Prop({ type:Types.ObjectId, ref: UserInfo.name, required: true, select: false })
    userId: Types.ObjectId;

    // 对话创建时间
    @Prop({ type: String, default:()=>dayjs().format('YYYY-MM-DD') })
    createDate: string;

    // 创建对话的时间戳
    @Prop({ type: Number, default:()=>dayjs().valueOf() })
    createTime: number;

    // 对话列表
    @Prop({ type: [ChatMessageSchema], default: [] })
    chatList: ChatMessage[];
}

export const ChatSchema = SchemaFactory.createForClass(ChatData);