import { describe, expect, it } from 'vitest';
import {
  checkProposedManager,
  MAX_CHAIN_STEPS,
  walkManagementChain,
  type ChainNode,
  type ChainSnapshot,
} from '../src/engines/employee/management-chain';

const human = 'h1';

function snapshot(nodes: ChainNode[], activeHumanIds: string[] = [human]): ChainSnapshot {
  return {
    employees: new Map(nodes.map((n) => [n.id, n])),
    activeHumanIds: new Set(activeHumanIds),
  };
}

const manager = (id: string, to: ChainNode['manager'], overrides: Partial<ChainNode> = {}) =>
  ({ id, kind: 'manager', status: 'active', manager: to, ...overrides }) satisfies ChainNode;

const toHuman = { kind: 'human', id: human } as const;
const toAi = (id: string) => ({ kind: 'ai', id }) as const;

/** Chuỗi m1 → m2 → … → mN → human. */
function linearChain(length: number): ChainNode[] {
  return Array.from({ length }, (_, i) =>
    manager(`m${i + 1}`, i === length - 1 ? toHuman : toAi(`m${i + 2}`)),
  );
}

describe('walkManagementChain (FR-006)', () => {
  it('manager là người thật đang hoạt động → hợp lệ, 1 bước', () => {
    expect(walkManagementChain(snapshot([]), { id: 'e', manager: toHuman })).toEqual({
      ok: true,
      humanMemberId: human,
      steps: 1,
    });
  });

  it('đi qua AI Manager tới người thật', () => {
    const s = snapshot([manager('m1', toHuman)]);
    expect(walkManagementChain(s, { id: 'e', manager: toAi('m1') })).toEqual({
      ok: true,
      humanMemberId: human,
      steps: 2,
    });
  });

  it('người thật đã vô hiệu hoặc không tồn tại → HUMAN_INACTIVE', () => {
    expect(walkManagementChain(snapshot([], []), { id: 'e', manager: toHuman })).toMatchObject({
      ok: false,
      reason: 'HUMAN_INACTIVE',
    });
  });

  it('manager AI có kind = employee → NOT_A_MANAGER', () => {
    const s = snapshot([manager('w', toHuman, { kind: 'employee' })]);
    expect(walkManagementChain(s, { id: 'e', manager: toAi('w') })).toMatchObject({
      ok: false,
      reason: 'NOT_A_MANAGER',
    });
  });

  it('manager AI đã archived hoặc không tồn tại → MANAGER_MISSING', () => {
    const s = snapshot([manager('m1', toHuman, { status: 'archived' })]);
    expect(walkManagementChain(s, { id: 'e', manager: toAi('m1') })).toMatchObject({
      reason: 'MANAGER_MISSING',
    });
    expect(walkManagementChain(s, { id: 'e', manager: toAi('zz') })).toMatchObject({
      reason: 'MANAGER_MISSING',
    });
  });

  it('chuỗi có vòng (kể cả tự trỏ vào chính mình) → CYCLE', () => {
    const s = snapshot([manager('m1', toAi('m2')), manager('m2', toAi('m1'))]);
    expect(walkManagementChain(s, { id: 'e', manager: toAi('m1') })).toMatchObject({
      reason: 'CYCLE',
    });
    expect(walkManagementChain(s, { id: 'm1', manager: toAi('m1') })).toMatchObject({
      reason: 'CYCLE',
    });
  });

  it(`đúng ${MAX_CHAIN_STEPS} bước thì hợp lệ, ${MAX_CHAIN_STEPS + 1} bước thì TOO_LONG`, () => {
    const ok = snapshot(linearChain(MAX_CHAIN_STEPS - 1));
    expect(walkManagementChain(ok, { id: 'e', manager: toAi('m1') })).toMatchObject({
      ok: true,
      steps: MAX_CHAIN_STEPS,
    });
    const tooLong = snapshot(linearChain(MAX_CHAIN_STEPS));
    expect(walkManagementChain(tooLong, { id: 'e', manager: toAi('m1') })).toMatchObject({
      ok: false,
      reason: 'TOO_LONG',
    });
  });
});

describe('checkProposedManager', () => {
  it('chuyển AI Manager xuống dưới cấp dưới của chính nó → CYCLE', () => {
    const proposed = snapshot([manager('top', toAi('low')), manager('low', toAi('top'))]);
    expect(checkProposedManager(proposed, { id: 'top', manager: toAi('low') })).toMatchObject({
      ok: false,
      reason: 'CYCLE',
    });
  });

  it('đổi manager đẩy cấp dưới của nó vượt giới hạn bước → TOO_LONG', () => {
    // m1..m8 → human; mid có một cấp dưới (sub). Đặt mid dưới m1: steps(mid) = 9, cộng 1 tầng cấp dưới = 10.
    const base = [
      ...linearChain(8),
      { id: 'sub', kind: 'employee', status: 'active', manager: toAi('mid') } satisfies ChainNode,
    ];
    const fits = snapshot([...base, manager('mid', toAi('m1'))]);
    expect(checkProposedManager(fits, { id: 'mid', manager: toAi('m1') })).toMatchObject({
      ok: true,
      steps: 9,
    });

    // Thêm tầng m0 phía trên m1 rồi đặt mid dưới m1 qua m0: steps(mid) = 10 + 1 cấp dưới = 11.
    const tooDeep = snapshot([...base, manager('m0', toAi('m1')), manager('mid', toAi('m0'))]);
    expect(checkProposedManager(tooDeep, { id: 'mid', manager: toAi('m0') })).toMatchObject({
      ok: false,
      reason: 'TOO_LONG',
    });
  });
});
