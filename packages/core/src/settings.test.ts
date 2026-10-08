import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_KEYS, crossCheckSettings, isSettingKey, parseSetting, settingSchemas } from './settings.ts';

describe('settings', () => {
  it('has a valid default for every key', () => {
    for (const key of SETTING_KEYS) {
      expect(settingSchemas[key].safeParse(DEFAULT_SETTINGS[key]).success, key).toBe(true);
    }
  });

  it('keeps the approved business defaults', () => {
    expect(DEFAULT_SETTINGS.loyalty_threshold_paise).toBe(200_000); // ₹2,000 of spend earns the Lucky Draw token
    expect(DEFAULT_SETTINGS.lucky_draw_token_limit).toBe(500);
    expect(DEFAULT_SETTINGS.last_order_buffer_min).toBe(15);
    expect(DEFAULT_SETTINGS.gst_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.first_order_offer_requires_otp).toBe(true);
    expect(DEFAULT_SETTINGS.refund_owner_approval_above_paise).toBe(50_000);
  });

  it('recognises keys', () => {
    expect(isSettingKey('loyalty_threshold_paise')).toBe(true);
    expect(isSettingKey('toString')).toBe(false);
    expect(isSettingKey('razorpay_key_secret')).toBe(false); // secrets never live in settings
  });

  it('parses valid values and rejects invalid ones with a message', () => {
    expect(parseSetting('loyalty_threshold_paise', 150_000)).toEqual({ ok: true, value: 150_000 });
    const bad = parseSetting('loyalty_threshold_paise', 19.5);
    expect(bad.ok).toBe(false);
    const gstin = parseSetting('gstin', 'NOT-A-GSTIN');
    expect(gstin).toEqual({ ok: false, message: 'Not a valid GSTIN' });
    expect(parseSetting('gstin', '06ABCDE1234F1Z5').ok).toBe(true);
  });

  it('falls back to a generic message when a schema gives none', () => {
    const noIssues = { safeParse: () => ({ success: false, error: { issues: [] } }) };
    const original = settingSchemas.payment_mode;
    (settingSchemas as Record<string, unknown>).payment_mode = noIssues;
    try {
      expect(parseSetting('payment_mode', 'x')).toEqual({ ok: false, message: 'Invalid value' });
    } finally {
      (settingSchemas as Record<string, unknown>).payment_mode = original;
    }
  });

  describe('crossCheckSettings', () => {
    it('saves the defaults with nothing to fix', () => {
      expect(crossCheckSettings(DEFAULT_SETTINGS)).toEqual({ errors: [], warnings: [] });
    });

    it('blocks GST without GSTIN and legal name', () => {
      expect(crossCheckSettings({ ...DEFAULT_SETTINGS, gst_enabled: true }).errors).toHaveLength(1);
      const ok = crossCheckSettings({
        ...DEFAULT_SETTINGS,
        gst_enabled: true,
        gstin: '06ABCDE1234F1Z5',
        legal_name: 'The Slush Bar',
      });
      expect(ok.errors).toEqual([]);
    });

    it('blocks delivery without a radius', () => {
      expect(crossCheckSettings({ ...DEFAULT_SETTINGS, delivery_enabled: true }).errors).toHaveLength(1);
      expect(
        crossCheckSettings({ ...DEFAULT_SETTINGS, delivery_enabled: true, delivery_radius_m: 5000 }).errors,
      ).toEqual([]);
    });
  });
});
