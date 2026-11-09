import type { AcceptanceCriterion } from '@claude-company/contracts';

export type EvidenceView = {
  criterionId: string;
  verdict: 'met' | 'not_met';
  round: number;
  createdAt: Date;
};

export type CompletenessReport = {
  complete: boolean;
  /** Criterion chưa có bằng chứng ở vòng hiện tại. */
  missing: string[];
  /** Criterion có bằng chứng mới nhất là `not_met`. */
  notMet: string[];
  hasArtifact: boolean;
};

/**
 * `in_review → awaiting_human_approval` chỉ khi mọi acceptance criterion có `evidence.verdict = met`
 * ở vòng hiện tại (bằng chứng mới nhất của từng criterion) và có ≥ 1 artifact của vòng đó (FR-020, SC-002).
 */
export function checkEvidence(input: {
  criteria: readonly AcceptanceCriterion[];
  evidence: readonly EvidenceView[];
  round: number;
  artifactsInRound: number;
}): CompletenessReport {
  const latest = new Map<string, EvidenceView>();
  for (const e of input.evidence) {
    if (e.round !== input.round) continue;
    const current = latest.get(e.criterionId);
    if (!current || e.createdAt.getTime() >= current.createdAt.getTime()) latest.set(e.criterionId, e);
  }
  const missing: string[] = [];
  const notMet: string[] = [];
  for (const c of input.criteria) {
    const e = latest.get(c.id);
    if (!e) missing.push(c.id);
    else if (e.verdict !== 'met') notMet.push(c.id);
  }
  const hasArtifact = input.artifactsInRound >= 1;
  return {
    complete: missing.length === 0 && notMet.length === 0 && hasArtifact,
    missing,
    notMet,
    hasArtifact,
  };
}
