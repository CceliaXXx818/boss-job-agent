import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOSS_CONSENT_MARKER, BossDisabledError, BossPlatformAdapter, checkConsentFile } from './adapter';

describe('platform-boss：默认禁运与授权（P3 / Q12）', () => {
  it('未授权默认态：任何方法抛 BossDisabledError（零网络）', async () => {
    const a = new BossPlatformAdapter({ enabled: false });
    expect(a.isEnabled).toBe(false);
    await expect(a.checkLogin()).rejects.toThrow(BossDisabledError);
    await expect(a.searchJobs({ city: '深圳', keywords: ['AI'] })).rejects.toThrow(BossDisabledError);
    await expect(a.sendGreeting('X', '您好')).rejects.toThrow(BossDisabledError);
    await expect(a.sendResume('c1', { mode: 'online' })).rejects.toThrow(BossDisabledError);
    await expect(a.sendTextReply('c1', 'hi')).rejects.toThrow(BossDisabledError);
  });

  it('consent 文件匹配标记 → enabled 且可校验方法所需页面角色', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boss-consent-'));
    const file = join(dir, 'consent.txt');
    writeFileSync(file, `# 用户授权记录\n${BOSS_CONSENT_MARKER}\n2026-09-04\n`);
    expect(checkConsentFile(file)).toBe(true);
    const a = new BossPlatformAdapter({ enabled: true, consentFile: file });
    expect(a.isEnabled).toBe(true);
    expect(a.requireRolesFor('sendGreeting')).toContain('greet_button');
    expect(a.requireRolesFor('checkLogin')).toContain('login_state');
  });

  it('consent 文件缺失/不匹配 → 即使 enabled 也拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boss-consent2-'));
    const file = join(dir, 'consent.txt');
    writeFileSync(file, 'some other text\n');
    expect(checkConsentFile(file)).toBe(false);
    const a = new BossPlatformAdapter({ enabled: true, consentFile: file });
    expect(a.isEnabled).toBe(false);
    expect(() => a.requireRolesFor('checkLogin')).toThrow(BossDisabledError);
  });
});
