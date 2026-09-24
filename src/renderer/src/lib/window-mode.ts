/**
 * 本渲染进程承载的窗口种类。`?window=about` 是「关于」独立叠加窗口:
 * 与宿主窗口完全重合的透明子窗口,直接浮在工作区之上,不参与宿主的页面路由。
 */
export const isAboutWindow = new URLSearchParams(window.location.search).get('window') === 'about'
