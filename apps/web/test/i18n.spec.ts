import { describe, expect, it } from 'vitest';
import { BUSINESS_ERROR_CODES, PLATFORM_ERROR_CODES } from '@claude-company/contracts';
import { ApiError } from '../src/lib/api';
import { describeError, errorMessages, errorText, t } from '../src/i18n';

describe('i18n tiếng Việt', () => {
  it('có thông điệp không rỗng cho mọi mã lỗi nghiệp vụ và nền tảng', () => {
    for (const code of [...BUSINESS_ERROR_CODES, ...PLATFORM_ERROR_CODES]) {
      expect(errorMessages[code], code).toBeTruthy();
    }
  });

  it('thuật ngữ sản phẩm giữ nguyên tiếng Anh', () => {
    expect(t('nav.office')).toBe('Virtual Office');
    expect(t('nav.tasks')).toBe('Task Center');
    expect(t('nav.dashboard')).toBe('Company Dashboard');
    expect(t('nav.employees')).toBe('AI Employee');
  });

  it('describeError dịch ApiError và che lỗi lạ bằng thông điệp chung', () => {
    expect(describeError(new ApiError(409, 'EMAIL_TAKEN', 'x'))).toBe(errorMessages.EMAIL_TAKEN);
    expect(describeError(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(errorText('NETWORK_ERROR'));
    expect(describeError(new Error('chi tiết nội bộ'))).toBe(errorMessages.INTERNAL);
  });
});
