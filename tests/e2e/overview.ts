import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * 把界面带回总览。
 *
 * 重载渲染层（win.reload）会恢复刷新前的视图，因此「重载后从列表起步」的用例必须先回总览；
 * 已经是总览时是空操作。调用前应已确认外壳可见（app-shell）。
 */
export async function backToOverview(win: Page): Promise<void> {
  const back = win.getByTestId('detail-overview-btn')
  // 等启动收敛到「总览」或「恢复出来的详情页」：启动中途两者都不在，直接判定会误判成无需返回。
  await expect(back.or(win.getByTestId('view-home'))).toBeVisible({ timeout: 15_000 })
  if (await back.isVisible().catch(() => false)) await back.click()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
}
