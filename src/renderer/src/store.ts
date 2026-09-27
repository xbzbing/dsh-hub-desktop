/**
 * 渲染层 Zustand 状态：由分片组合而成。
 *
 * 各分片（settings/toast/vault/instance/workspace）共享同一 set/get，切面之间可互相调用
 * （如 workspace 动作里 get().toast(...)）。分片定义见 ./store/*-slice.ts，形状见 ./store/types.ts。
 */
import { create } from 'zustand'
import { isAboutWindow } from './lib/window-mode'
import type { AppState } from './store/types'
import { createSettingsSlice } from './store/settings-slice'
import { createToastSlice } from './store/toast-slice'
import { createVaultSlice } from './store/vault-slice'
import { createInstanceSlice } from './store/instance-slice'
import { createWorkspaceSlice } from './store/workspace-slice'

export type { AppState, ToastItem, ToastKind, ActivityLine } from './store/types'

/**
 * 渲染层出生或热重置时默认没有工作区：主进程的清零钩子只覆盖主框架导航（Cmd+R），
 * HMR 重执行本模块不产生导航 —— 这里无条件撤销一次，避免原生视图以旧几何悬浮。
 * 主进程没有活动工作区时该调用是幂等 no-op。
 * 「关于」叠加窗口不参与工作区管理：不执行该撤销，否则会隐藏宿主窗口的视图。
 */
if (!isAboutWindow) window.dshHub?.runtime?.hideView?.()

export const useAppStore = create<AppState>()((set, get) => ({
  ...createSettingsSlice(set, get),
  ...createToastSlice(set, get),
  ...createVaultSlice(set, get),
  ...createInstanceSlice(set, get),
  ...createWorkspaceSlice(set, get)
}))
