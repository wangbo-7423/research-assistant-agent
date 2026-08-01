/// <reference types="vite/client" />

declare module '*.vue'{
    import { DefinedComponent } from 'vue';
    const component: DefinedComponent<{}, {}, any>;
    export default component;
}

// 前端自定义环境变量类型声明（VITE_ 前缀的变量才会被 Vite 暴露到 import.meta.env）
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}