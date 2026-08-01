import { Module } from '@nestjs/common';
import { UserinfoModule } from './userinfo/userinfo.module';
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { FileanagementModule } from './fileanagement/fileanagement.module';
import { ChatModule } from './chat/chat.module';
import { RedisModule } from "@nestjs-modules/ioredis";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // 连接mongodb数据库
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory:(config: ConfigService)=> ({
        uri: config.get<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: 1000, // 连接超时时间
        connectTimeoutMS: 1000,// tcp超时时间
        socketTimeoutMS: 2000,// socket超时时间
      }),
    }),
    // 连接redis数据库
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'single',
        options: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          // password
        }
      })
    }),
    //注册jwt模块
    JwtModule.registerAsync({
      global:true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: {
          expiresIn: '10d'
        }
      })
    }),
    // 与用户相关的模块
    UserinfoModule,
    FileanagementModule,
    ChatModule
  ],
})
export class AppModule {}
