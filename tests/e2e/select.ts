import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/** 下拉浮层的 test id，与 Select 组件的派生规则一致。 */
function menuTestId(testId: string): string {
  return `${testId}-menu`
}

/** 打开下拉并等待浮层可见。 */
export async function openSelect(page: Page, testId: string): Promise<Locator> {
  await page.getByTestId(testId).click()
  const menu = page.getByTestId(menuTestId(testId))
  await expect(menu).toBeVisible()
  return menu
}

/** 在已打开的下拉里按 value 选中一项，并等待浮层收起。 */
export async function chooseOption(page: Page, testId: string, value: string): Promise<void> {
  const menu = page.getByTestId(menuTestId(testId))
  await menu.locator(`[data-value="${value}"]`).click()
  await expect(menu).toHaveCount(0)
}

/** 打开下拉并选中一项。 */
export async function pickOption(page: Page, testId: string, value: string): Promise<void> {
  await openSelect(page, testId)
  await chooseOption(page, testId, value)
}
