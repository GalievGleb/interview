import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Run against an already-open Alpha overlay with local debugging enabled.
const browser = await chromium.connectOverCDP(process.env.SKILLCUE_TEST_CDP || 'http://127.0.0.1:51930');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('/overlay'));
assert.ok(page, 'Overlay window must be running');
const trigger = page.getByRole('button', { name: 'Меню', exact: true });
assert.equal(await trigger.count(), 1, 'Overlay must expose its settings menu');
await trigger.click();
const menu = page.getByRole('region', { name: 'Настройки оверлея' });
await menu.waitFor({ state: 'visible', timeout: 5000 });
for (const label of ['Скрытность', 'Работать под панелью', 'Клики сквозь оверлей', 'Живой транскрипт']) {
  assert.equal(await menu.getByRole('switch', { name: label, exact: true }).count(), 1, label);
}
const opacity = menu.getByRole('slider', { name: 'Прозрачность' });
const previous = await opacity.inputValue();
await opacity.focus();
await page.keyboard.press(Number(previous) < 100 ? 'ArrowRight' : 'ArrowLeft');
assert.notEqual(await opacity.inputValue(), previous, 'Opacity must respond to input');
await page.keyboard.press(Number(previous) < 100 ? 'ArrowLeft' : 'ArrowRight');
assert.equal(await opacity.inputValue(), previous, 'Restore previous opacity');
await page.keyboard.press('Escape');
await menu.waitFor({ state: 'hidden', timeout: 5000 });
await trigger.click();
await menu.waitFor({ state: 'visible', timeout: 5000 });
assert.equal(await opacity.inputValue(), previous, 'Settings persist across menu reopen');
await trigger.click();
await menu.waitFor({ state: 'hidden', timeout: 5000 });
console.log('PASS: settings menu opens, exposes controls, applies opacity, closes and reopens');
await browser.close();
