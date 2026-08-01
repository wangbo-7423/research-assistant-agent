import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { TransformInterceptor } from '../utils/transform.interceptor';
import { HttpExceptionFilter } from '../utils/all-exception.filter';

// 端到端测试：依赖本机真实的 MongoDB / Redis（Milvus 仅构造客户端，不发请求）
// 覆盖：注册 -> 重复注册 -> 登录 -> 鉴权 -> 会话列表 -> 历史记录 -> 文件接口鉴权
describe('App (e2e)', () => {
  let app: INestApplication<App>;
  // 每次运行生成随机手机号，避免与库中已有账号冲突
  const phoneNumber = '139' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const password = 'Test1234';
  let token = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // 与 main.ts 保持一致的全局管道 / 过滤器 / 拦截器
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  describe('用户注册 /userinfo/registeruser', () => {
    it('新手机号注册成功，返回 token', async () => {
      // 全局 TransformInterceptor 会把状态码统一改写为 200
      const res = await request(app.getHttpServer())
        .post('/userinfo/registeruser')
        .send({ phoneNumber, password, confirmPassWord: password })
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(res.body.message).toBe('SUCCESS');
      expect(res.body.data.token).toBeTruthy();
      expect(res.body.data.phonenumber).toBe(phoneNumber);
      token = res.body.data.token;
    });

    it('同一手机号重复注册，提示账号已存在', async () => {
      const res = await request(app.getHttpServer())
        .post('/userinfo/registeruser')
        .send({ phoneNumber, password, confirmPassWord: password });

      expect([200, 422]).toContain(res.status);
      expect(res.body.message).toBe('该账号已存在');
    });

    it('两次密码不一致返回 400', async () => {
      await request(app.getHttpServer())
        .post('/userinfo/registeruser')
        .send({ phoneNumber: '13800000000', password, confirmPassWord: 'Xxxx9999' })
        .expect(400);
    });

    it('弱密码被 DTO 校验拦截返回 400', async () => {
      await request(app.getHttpServer())
        .post('/userinfo/registeruser')
        .send({ phoneNumber: '13800000001', password: 'weak', confirmPassWord: 'weak' })
        .expect(400);
    });
  });

  describe('用户登录 /userinfo/loginuser', () => {
    it('密码错误时提示账号或密码错误', async () => {
      const res = await request(app.getHttpServer())
        .post('/userinfo/loginuser')
        .send({ phoneNumber, password: 'Wrong1234' });

      expect(res.body.message).toBe('账号或密码错误');
    });

    it('正确账号密码登录成功，返回 token', async () => {
      const res = await request(app.getHttpServer())
        .post('/userinfo/loginuser')
        .send({ phoneNumber, password })
        .expect(200);

      expect(res.body.data.token).toBeTruthy();
      token = res.body.data.token;
    });
  });

  describe('鉴权守卫', () => {
    it('未携带 token 访问会话列表返回 401', async () => {
      await request(app.getHttpServer())
        .get('/chat/sessionlist')
        .expect(401);
    });

    it('伪造 token 访问会话列表返回 401', async () => {
      await request(app.getHttpServer())
        .get('/chat/sessionlist')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('未携带 token 上传文件返回 401', async () => {
      await request(app.getHttpServer())
        .post('/fileanagement/knowledge')
        .expect(401);
    });
  });

  describe('会话与历史（真实 MongoDB + Redis）', () => {
    it('新用户会话列表为空数组', async () => {
      const res = await request(app.getHttpServer())
        .get('/chat/sessionlist')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });

    it('非法 sessionId 查询历史返回空对话而不是 500', async () => {
      const res = await request(app.getHttpServer())
        .get('/chat/history')
        .query({ sessionId: 'not-an-object-id' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data).toEqual({ sessionId: 'not-an-object-id', chatList: [] });
    });

    it('缺少 sessionId 参数被 DTO 校验拦截', async () => {
      await request(app.getHttpServer())
        .get('/chat/history')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('知识库文件列表接口可用且为空', async () => {
      const res = await request(app.getHttpServer())
        .get('/fileanagement/kbfilelist')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data.result).toEqual([]);
    });

    it('删除不存在的文件返回错误提示而不是崩溃', async () => {
      const res = await request(app.getHttpServer())
        .delete('/fileanagement/knowledge/000000000000000000000000')
        .set('Authorization', `Bearer ${token}`);

      expect([400, 404]).toContain(res.status);
    });
  });
});
