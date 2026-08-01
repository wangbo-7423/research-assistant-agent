import { BadRequestException } from '@nestjs/common';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import {
    IMAGE_UPLOAD_DIR,
    assertImageSignature,
    createStoredImageFilename,
    ensureImageUploadDir,
    resolveStoredImagePath,
    validateUploadedImage,
} from './image-storage';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('image-storage 图片传输安全', () => {
    const testFiles: string[] = [];

    const createTestFile = (name: string, content: Buffer = PNG_HEADER): string => {
        const filePath = path.join(ensureImageUploadDir(), name);
        writeFileSync(filePath, content);
        testFiles.push(filePath);
        return filePath;
    };

    afterEach(() => {
        for (const filePath of testFiles.splice(0)) {
            if (existsSync(filePath)) {
                unlinkSync(filePath);
            }
        }
    });

    it('按 MIME 类型生成带扩展名的安全文件名', () => {
        expect(createStoredImageFilename('file', 'image/png')).toMatch(/^file-\d+-\d+\.png$/);
        expect(createStoredImageFilename('file', 'image/jpeg')).toMatch(/\.jpg$/);
        expect(() => createStoredImageFilename('file', 'text/plain')).toThrow(BadRequestException);
    });

    it('只允许解析图片上传目录的直接子文件，拒绝路径穿越', () => {
        const filename = 'unit-test-image.png';
        createTestFile(filename);

        expect(resolveStoredImagePath(`${IMAGE_UPLOAD_DIR}/${filename}`).filename).toBe(filename);
        expect(resolveStoredImagePath(`${IMAGE_UPLOAD_DIR}\\${filename}`).filename).toBe(filename);
        expect(() => resolveStoredImagePath('../package.json')).toThrow(BadRequestException);
        expect(() => resolveStoredImagePath(`${IMAGE_UPLOAD_DIR}/nested/${filename}`)).toThrow(BadRequestException);
    });

    it('校验图片魔数，拒绝伪装的图片内容', () => {
        const pngPath = createTestFile('valid-signature.png');
        const fakePath = createTestFile('fake-signature.png', Buffer.from('not-an-image'));

        expect(() => assertImageSignature(pngPath, 'image/png')).not.toThrow();
        expect(() => assertImageSignature(fakePath, 'image/png')).toThrow(BadRequestException);
    });

    it('上传校验失败时自动清理已落盘文件', () => {
        const fakePath = createTestFile('invalid-upload.png', Buffer.from('plain text'));
        const file = {
            path: fakePath,
            size: 10,
            mimetype: 'image/png',
        } as Express.Multer.File;

        expect(() => validateUploadedImage(file)).toThrow(BadRequestException);
        expect(existsSync(fakePath)).toBe(false);
        testFiles.pop(); // 文件已被 validateUploadedImage 清理，避免 afterEach 重复处理
    });
});
