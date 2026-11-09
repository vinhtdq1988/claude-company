import { describe, expect, it } from 'vitest';
import {
  topologicalOrder,
  validateDependencyIndexes,
} from '../../src/engines/task/dependency-graph';

describe('dependency-graph', () => {
  it('sắp xếp topological theo phụ thuộc', () => {
    const result = topologicalOrder([[], [0], [0, 1]]);
    expect(result).toEqual({ ok: true, order: [0, 1, 2] });
  });

  it('không có phụ thuộc: giữ thứ tự ban đầu', () => {
    expect(topologicalOrder([[], [], []])).toEqual({ ok: true, order: [0, 1, 2] });
  });

  it('phát hiện vòng và trả các chỉ số kẹt', () => {
    const result = topologicalOrder([[1], [2], [0], []]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cycle).toEqual([0, 1, 2]);
  });

  it('phụ thuộc trùng lặp không làm sai indegree', () => {
    expect(topologicalOrder([[], [0, 0]])).toEqual({ ok: true, order: [0, 1] });
  });

  it('chỉ số ngoài phạm vi hoặc tự tham chiếu bị từ chối', () => {
    expect(validateDependencyIndexes([[], [5]])).toBe('OUT_OF_RANGE');
    expect(validateDependencyIndexes([[-1]])).toBe('OUT_OF_RANGE');
    expect(validateDependencyIndexes([[0]])).toBe('SELF_REFERENCE');
    expect(validateDependencyIndexes([[], [0]])).toBeNull();
  });
});
