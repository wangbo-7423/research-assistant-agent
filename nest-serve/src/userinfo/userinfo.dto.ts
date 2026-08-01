import { IsNotEmpty, IsString, Matches } from "class-validator"

export class LoginUserDto {
    @IsString({message:"phone number must be string"})
    @IsNotEmpty({message:"phone number is required"})
    @Matches(/^1[3-9]\d{9}$/,{message:"phone number must be 10 digits"})
    phoneNumber: string

    @IsString({message:"password must be string"})
    @IsNotEmpty({message:"password is required"})
    @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$/,{message:"密码长度至少8位，且至少包含一个大写字母、一个小写字母和一个数字。"})
    password: string
}

export class RegisterDto extends LoginUserDto {
    //确认密码
    @IsString({message:"password must be string"})
    @IsNotEmpty({message:"确认密码不能为空"})
    confirmPassWord: string
}