import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from "../utils/all-exception.filter"
import { TransformInterceptor } from "../utils/transform.interceptor"
import { MyLogger } from "../utils/no-timestamp-logger"
import * as express from 'express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new MyLogger(), cors: true });

  app.use('/open-image', express.static(join(process.cwd(), 'uploads-image')));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  // 注册全局异常过滤器
  app.useGlobalFilters(new HttpExceptionFilter());
  // 注册全局拦截器
  app.useGlobalInterceptors(new TransformInterceptor());
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
}
bootstrap();