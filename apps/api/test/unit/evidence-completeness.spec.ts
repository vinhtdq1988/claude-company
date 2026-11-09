import { describe, expect, it } from 'vitest';
import { checkEvidence } from '../../src/engines/task/evidence-completeness';

const criteria = [
  { id: 'c1', text: 'Có báo cáo' },
  { id: 'c2', text: 'Có số liệu' },
];
const t = (s: number) => new Date(2026, 10, 9, 10, 0, s);

describe('checkEvidence', () => {
  it('đủ bằng chứng met cho mọi criterion và có artifact → hoàn tất', () => {
    const r = checkEvidence({
      criteria,
      evidence: [
        { criterionId: 'c1', verdict: 'met', round: 0, createdAt: t(1) },
        { criterionId: 'c2', verdict: 'met', round: 0, createdAt: t(2) },
      ],
      round: 0,
      artifactsInRound: 1,
    });
    expect(r).toEqual({ complete: true, missing: [], notMet: [], hasArtifact: true });
  });

  it('thiếu bằng chứng cho một criterion', () => {
    const r = checkEvidence({
      criteria,
      evidence: [{ criterionId: 'c1', verdict: 'met', round: 0, createdAt: t(1) }],
      round: 0,
      artifactsInRound: 1,
    });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['c2']);
  });

  it('không có artifact của vòng hiện tại → chưa đủ', () => {
    const r = checkEvidence({
      criteria: [criteria[0]!],
      evidence: [{ criterionId: 'c1', verdict: 'met', round: 0, createdAt: t(1) }],
      round: 0,
      artifactsInRound: 0,
    });
    expect(r.complete).toBe(false);
    expect(r.hasArtifact).toBe(false);
  });

  it('bằng chứng của vòng cũ không tính cho vòng rework mới', () => {
    const r = checkEvidence({
      criteria: [criteria[0]!],
      evidence: [{ criterionId: 'c1', verdict: 'met', round: 0, createdAt: t(1) }],
      round: 1,
      artifactsInRound: 1,
    });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['c1']);
  });

  it('lấy bằng chứng mới nhất của mỗi criterion', () => {
    const r = checkEvidence({
      criteria: [criteria[0]!],
      evidence: [
        { criterionId: 'c1', verdict: 'met', round: 0, createdAt: t(1) },
        { criterionId: 'c1', verdict: 'not_met', round: 0, createdAt: t(5) },
      ],
      round: 0,
      artifactsInRound: 1,
    });
    expect(r.complete).toBe(false);
    expect(r.notMet).toEqual(['c1']);
  });
});
