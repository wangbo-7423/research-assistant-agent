import { BadRequestException } from '@nestjs/common';
import { mkdirSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';

export const IMAGE_UPLOAD_DIR = 'uploads-image';
export const IMAGE_PUBLIC_ROUTE = '/open-image';

export const ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
] as const;

const IMAGE_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

// multer 默认按 latin1 解码文件名，中文名需要先还原原始字节再按 UTF-8 解码
export function fixUtf8Filename(filename: string): string {
    try {
        const utf8Name = Buffer.from(filename, 'latin1').toString('utf8');
        return utf8Name.includes('\ufffd') ? filename : utf8Name;
    } catch {
        return filename;
    }
}

export function ensureImageUploadDir(): string {
    const absoluteDir = path.resolve(process.cwd(), IMAGE_UPLOAD_DIR);
    mkdirSync(absoluteDir, { recursive: true });
    return absoluteDir;
}

export function createStoredImageFilename(fieldname: string, mimetype: string): string {
    const extension = IMAGE_EXTENSIONS[mimetype];
    if (!extension) {
        throw new BadRequestException(`不支持的图片类型: ${mimetype}`);
    }
    const safeFieldname = fieldname.replace(/[^a-zA-Z0-9_-]/g, '') || 'image';
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    return `${safeFieldname}-${uniqueSuffix}${extension}`;
}

// 只允许访问 uploads-image 目录的直接子文件，阻止 ../ 或绝对路径造成的任意文件读写
export function resolveStoredImagePath(imagePath: string): {
    absolutePath: string;
    relativePath: string;
    filename: string;
} {
    if (!imagePath || typeof imagePath !== 'string') {
        throw new BadRequestException('图片路径不能为空');
    }
    const normalizedInput = imagePath.trim().replace(/\\/g, '/');
    if (!normalizedInput || normalizedInput.includes('\0')) {
        throw new BadRequestException('图片路径不合法');
    }

    const uploadRoot = path.resolve(process.cwd(), IMAGE_UPLOAD_DIR);
    const absolutePath = path.resolve(process.cwd(), normalizedInput);
    if (path.dirname(absolutePath) !== uploadRoot) {
        throw new BadRequestException('图片路径必须位于图片上传目录内');
    }

    const filename = path.basename(absolutePath);
    return {
        absolutePath,
        relativePath: `${IMAGE_UPLOAD_DIR}/${filename}`,
        filename,
    };
}

// 校验文件魔数，避免仅修改 Content-Type 后上传伪图片
export function assertImageSignature(absolutePath: string, mimetype: string): void {
    const header = readFileSync(absolutePath).subarray(0, 12);
    const isJpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng =
        header.length >= 8 &&
        header[0] === 0x89 &&
        header[1] === 0x50 &&
        header[2] === 0x4e &&
        header[3] === 0x47 &&
        header[4] === 0x0d &&
        header[5] === 0x0a &&
        header[6] === 0x1a &&
        header[7] === 0x0a;
    const isWebp =
        header.length >= 12 &&
        header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WEBP';

    const valid =
        ((mimetype === 'image/jpeg' || mimetype === 'image/jpg') && isJpeg) ||
        (mimetype === 'image/png' && isPng) ||
        (mimetype === 'image/webp' && isWebp);

    if (!valid) {
        throw new BadRequestException('文件内容与声明的图片类型不一致');
    }
}

export function validateUploadedImage(file: Express.Multer.File): void {
    try {
        if (!file?.path || file.size <= 0) {
            throw new BadRequestException('图片内容不能为空');
        }
        if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype as (typeof ALLOWED_IMAGE_TYPES)[number])) {
            throw new BadRequestException(`不支持的图片类型: ${file.mimetype}`);
        }
        assertImageSignature(file.path, file.mimetype);
    } catch (error) {
        if (file?.path) {
            removeStoredImageSilently(file.path);
        }
        throw error;
    }
}

export function removeStoredImageSilently(imagePath: string): void {
    try {
        unlinkSync(imagePath);
    } catch {
        // 文件不存在或已删除时忽略
    }
}
