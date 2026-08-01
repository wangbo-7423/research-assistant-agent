import { IsNotEmpty, IsString } from "class-validator";

// 删除图片需要传递的参数
export class DeleteImageDto {
    // 图片路径
    @IsString({ message: "imagePath必须是字符串" })
    @IsNotEmpty({ message: "imagePath不能为空" })
    imagePath: string;
}