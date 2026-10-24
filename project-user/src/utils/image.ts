/**
 * 剪贴板图片处理：类型/大小校验 → canvas 压缩 → dataURL/base64。
 *
 * 替换原「上传图片到服务端」的链路：图片不再单独上传，而是压缩成 base64
 * 随消息一起提交，由后端落盘并转成多模态消息。
 */

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
export const MAX_IMAGE_COUNT = 4
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024
// 最长边压缩上限：足够模型看清图表细节，又能把单图压到几百 KB
const MAX_IMAGE_EDGE = 1600
const COMPRESS_QUALITY = 0.85

export interface PreparedImage {
  id: string
  fileName: string
  fileSize: number
  mimetype: string
  dataUrl: string
  base64: string
}

export const isSupportedImage = (type: string): boolean =>
  ACCEPTED_IMAGE_TYPES.includes((type || '').toLowerCase())

/** 从粘贴事件里取出图片文件（截图、网页图片、文档里复制的图表都会带 file item）。 */
export const extractClipboardImages = (event: ClipboardEvent): File[] => {
  const items = event.clipboardData?.items
  if (!items) return []
  const files: File[] = []
  Array.from(items as unknown as DataTransferItem[]).forEach((item) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) return
    const file = item.getAsFile()
    if (file) files.push(file)
  })
  return files
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })

const stripDataUrlPrefix = (dataUrl: string): string => dataUrl.slice(dataUrl.indexOf(',') + 1)

/** 按最长边等比缩放后重新编码：优先 WebP，浏览器不支持时退 JPEG。 */
const compressImage = async (file: File): Promise<{ dataUrl: string; mimetype: string }> => {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器不支持图片压缩')
    context.drawImage(bitmap, 0, 0, width, height)

    const webp = canvas.toDataURL('image/webp', COMPRESS_QUALITY)
    const dataUrl = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', COMPRESS_QUALITY)
    return { dataUrl, mimetype: dataUrl.slice(5, dataUrl.indexOf(';')) }
  } finally {
    bitmap.close?.()
  }
}

// 剪贴板里的图片常常只有一串 hash 名（甚至没有扩展名），不能直接展示给用户
const looksLikeClipboardId = (name: string): boolean => {
  const base = name.replace(/\.[a-z0-9]+$/i, '')
  return /^[0-9a-f]{12,}$/i.test(base) || /^[0-9a-f-]{20,}$/i.test(base)
}

/** 校验 + 压缩单张图片，返回可直接预览和提交的数据。压缩失败时回退原图（大小已校验）。 */
export const prepareImage = async (file: File, fallbackName?: string): Promise<PreparedImage> => {
  if (!isSupportedImage(file.type)) {
    throw new Error('仅支持 JPG、JPEG、PNG、WEBP 图片')
  }
  if (file.size <= 0) {
    throw new Error('图片内容为空，请重新选择')
  }
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error('单张图片不能超过 10MB')
  }

  let dataUrl = ''
  let mimetype = file.type
  try {
    const compressed = await compressImage(file)
    dataUrl = compressed.dataUrl
    mimetype = compressed.mimetype
  } catch (error) {
    console.warn('图片压缩失败，使用原图提交', error)
    dataUrl = await readAsDataUrl(file)
  }

  const base64 = stripDataUrlPrefix(dataUrl)
  const extension = mimetype.split('/')[1] || 'png'
  const rawName = (file.name || '').trim()
  const displayName = rawName && !looksLikeClipboardId(rawName)
    ? rawName
    : (fallbackName || `图片.${extension}`)
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: displayName,
    // 展示压缩后的真实体积（按 base64 长度反推）
    fileSize: Math.round((base64.length * 3) / 4),
    mimetype,
    dataUrl,
    base64,
  }
}
