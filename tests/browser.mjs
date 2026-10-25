import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(process.env.PIN_PLAYWRIGHT_PACKAGE || '/tmp/paseo-pin-browser/package.json');
const { chromium } = require('playwright');

export async function verifySettings({ url, password, serverId, legacy = false }) {
  const browser = await chromium.launch({ executablePath: process.env.PIN_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const directory = '/tmp/paseo-pin-ui'; await mkdir(directory, { recursive: true });
  const automaticResult = legacy ? '凭据不存在、为空、不可读或格式无效。' : `自动连接成功 · ${serverId}`;
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(url);
    await page.getByText('直接连接', { exact: true }).waitFor({ timeout: 20000 });
    await page.getByText('直接连接', { exact: true }).click();
    await page.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('端口', { exact: true }).fill(new URL(url).port);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByText('连接', { exact: true }).click();
    await page.waitForTimeout(1200);
    const settingsUrl = `${url}/settings/hosts/${serverId}/plugins/paseo-pin/connection`;
    await page.goto(settingsUrl);
    await page.getByText('paseo-pin · 0.1.0', { exact: true }).waitFor({ timeout: 20000 });
    await page.getByText('测试自动', { exact: true }).click();
    await page.getByText(automaticResult, { exact: true }).waitFor();
    await page.getByText('本机文件', { exact: true }).click();
    await page.getByText('直接输入密码', { exact: true }).last().click();
    await page.getByText('保存设置', { exact: true }).click();
    await page.getByText('连接设置已保存。', { exact: true }).waitFor();
    await page.getByLabel('新密码', { exact: true }).fill(password);
    await page.getByText('保存密码', { exact: true }).click();
    await page.getByText('密码已保存。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), '');
    await page.getByText('测试兜底', { exact: true }).click();
    await page.getByText(`兜底连接成功 · ${serverId}`, { exact: true }).waitFor();
    for (const source of ['环境变量', '本机文件']) {
      await page.getByLabel('新密码', { exact: true }).fill('unsaved-regression-password');
      await page.getByText('直接输入密码', { exact: true }).click();
      await page.getByText(source, { exact: true }).last().click();
      if (source === '环境变量') await page.getByLabel('环境变量名', { exact: true }).fill('PIN_TEST_PASSWORD');
      await page.getByText('保存设置', { exact: true }).click();
      await page.getByText('连接设置已保存。', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('新密码', { exact: true }).count(), 0);
      await page.getByText('测试兜底', { exact: true }).click({ timeout: 3000 });
      await page.getByText(`兜底连接成功 · ${serverId}`, { exact: true }).waitFor();
      await page.getByText(source, { exact: true }).click();
      await page.getByText('直接输入密码', { exact: true }).last().click();
      // Retaining the literal draft is fine, but it must only gate literal authentication.
      assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), 'unsaved-regression-password');
      await page.getByLabel('新密码', { exact: true }).fill('');
      await page.getByText('保存设置', { exact: true }).click();
      await page.getByText('连接设置已保存。', { exact: true }).waitFor();
    }
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(settingsUrl);
      await page.getByText('paseo-pin · 0.1.0', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), '');
      await page.screenshot({ path: `${directory}/settings-${width}.png`, fullPage: true });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'horizontal overflow');
    }
    await page.getByText('测试自动', { exact: true }).click();
    await page.getByText(automaticResult, { exact: true }).waitFor();
    await page.screenshot({ path: `${directory}/settings-375-actions.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(settingsUrl);
    await page.getByText('paseo-pin · 0.1.0', { exact: true }).waitFor();
    await page.screenshot({ path: `${directory}/settings-375-dark.png`, fullPage: true });
    assert(!await page.locator('body').innerText().then(text => text.includes(password)));
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  } finally { await browser.close(); }
}
