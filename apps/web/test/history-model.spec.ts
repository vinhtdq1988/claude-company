import { describe, expect, it } from 'vitest';
import { RUN_STATUSES } from '@claude-company/contracts';
import {
  INVOCATION_STATUS_LABEL_KEYS,
  PURPOSE_LABEL_KEYS,
  RUN_STATUS_LABEL_KEYS,
  STEP_KIND_LABEL_KEYS,
  failureOf,
  formatCost,
  formatDuration,
  sortRuns,
} from '../src/features/history/history-model';
import { messages } from '../src/i18n/vi';

describe('history-model', () => {
  it('mọi trạng thái, mục đích, loại bước và trạng thái tool đều có nhãn tiếng Việt', () => {
    const keys = [
      ...Object.values(RUN_STATUS_LABEL_KEYS),
      ...Object.values(PURPOSE_LABEL_KEYS),
      ...Object.values(STEP_KIND_LABEL_KEYS),
      ...Object.values(INVOCATION_STATUS_LABEL_KEYS),
    ];
    for (const key of keys) expect(messages[key], key).toBeTruthy();
    expect(Object.keys(RUN_STATUS_LABEL_KEYS).sort()).toEqual([...RUN_STATUSES].sort());
  });

  describe('failureOf (SC-011: nguyên nhân thất bại phải nổi bật)', () => {
    it('run thành công, đang chạy hoặc chờ duyệt không có lỗi', () => {
      for (const status of ['queued', 'running', 'waiting_approval', 'succeeded'] as const) {
        expect(failureOf({ status, errorCode: null, errorMessage: null })).toBeNull();
      }
    });

    it('run bị người dùng hủy (không có mã lỗi) không bị coi là lỗi, nhưng hệ thống hủy kèm mã thì có', () => {
      expect(failureOf({ status: 'cancelled', errorCode: null, errorMessage: null })).toBeNull();
      expect(
        failureOf({ status: 'cancelled', errorCode: 'TASK_STATE_CHANGED', errorMessage: 'x' }),
      ).toMatchObject({
        code: 'TASK_STATE_CHANGED',
        messageKey: 'history.error.TASK_STATE_CHANGED',
      });
    });

    it('mã lỗi riêng của run dùng khóa giải thích; mã của API dùng thông điệp ErrorCode; mã lạ giữ nguyên mã', () => {
      expect(
        failureOf({ status: 'timed_out', errorCode: 'TIMEOUT', errorMessage: 'quá giờ' }),
      ).toEqual({
        code: 'TIMEOUT',
        messageKey: 'history.error.TIMEOUT',
        fallback: 'TIMEOUT',
        detail: 'quá giờ',
      });
      const interrupted = failureOf({
        status: 'failed',
        errorCode: 'RUN_INTERRUPTED',
        errorMessage: null,
      });
      expect(interrupted?.messageKey).toBeNull();
      expect(interrupted?.fallback).toBe('Lần chạy bị gián đoạn.');
      expect(
        failureOf({ status: 'failed', errorCode: 'MYSTERY', errorMessage: null })?.fallback,
      ).toBe('MYSTERY');
    });

    it('run lỗi không ghi mã vẫn được báo là lỗi', () => {
      expect(failureOf({ status: 'failed', errorCode: null, errorMessage: null })?.code).toBe(
        'UNKNOWN',
      );
    });
  });

  it('formatDuration: giây, phút, run đang chạy tính đến now, mốc sai trả null', () => {
    expect(formatDuration(null, null)).toBeNull();
    expect(formatDuration('2026-11-10T10:00:00Z', '2026-11-10T10:00:42Z')).toBe('42 giây');
    expect(formatDuration('2026-11-10T10:00:00Z', '2026-11-10T10:01:05Z')).toBe('1 phút 05 giây');
    expect(formatDuration('2026-11-10T10:00:00Z', null, Date.parse('2026-11-10T10:02:00Z'))).toBe(
      '2 phút 00 giây',
    );
    expect(formatDuration('2026-11-10T10:00:10Z', '2026-11-10T10:00:00Z')).toBeNull();
    expect(formatDuration('không phải ngày', null)).toBeNull();
  });

  it('sortRuns: mới nhất lên trước, cùng thời điểm thì lần thử sau lên trước, không sửa mảng gốc', () => {
    const runs = [
      { id: 'a', createdAt: '2026-11-10T10:00:00Z', attempt: 1 },
      { id: 'b', createdAt: '2026-11-10T11:00:00Z', attempt: 1 },
      { id: 'c', createdAt: '2026-11-10T10:00:00Z', attempt: 2 },
    ];
    expect(sortRuns(runs).map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(runs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('formatCost hiển thị 4 chữ số thập phân', () => {
    expect(formatCost(0.0123456)).toBe('$0.0123');
    expect(formatCost(0)).toBe('$0.0000');
  });
});
