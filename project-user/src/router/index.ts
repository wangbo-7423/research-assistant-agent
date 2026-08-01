const routes = [
    {
        path: '/',
        name: 'appshell',
        component: () => import("@/components/AppShell.vue"),
    }
]

import { createRouter, createWebHashHistory } from 'vue-router';
const router = createRouter({
    history: createWebHashHistory(),
    routes: routes
})

export default router
