import { DomainError, type HumanMember } from '@claude-company/contracts';

/**
 * Người duyệt: người giao task nếu còn hoạt động, ngược lại CEO đầu tiên còn hoạt động (FR-026: người duyệt bị
 * vô hiệu thì yêu cầu chuyển cho CEO). Thuần để unit test được.
 */
export function pickApprover(
  candidate: string | null | undefined,
  members: readonly Pick<HumanMember, 'id' | 'role' | 'disabledAt'>[],
): string {
  const active = members.filter((m) => m.disabledAt === null);
  if (candidate && active.some((m) => m.id === candidate)) return candidate;
  const ceo = active.find((m) => m.role === 'ceo');
  if (!ceo)
    throw new DomainError('INTERNAL', 'Công ty không có CEO đang hoạt động để duyệt yêu cầu');
  return ceo.id;
}
