/**
 * Kiểm tra đồ thị phụ thuộc của kế hoạch phân rã (Kahn). `dependsOn[i]` là chỉ số các task con mà task con `i` phụ thuộc.
 * Trả thứ tự topological hoặc `{ cycle }` chứa các chỉ số còn kẹt trong vòng.
 */
export type TopoResult = { ok: true; order: number[] } | { ok: false; cycle: number[] };

export type DependencyIssue = 'OUT_OF_RANGE' | 'SELF_REFERENCE';

export function validateDependencyIndexes(dependsOn: readonly (readonly number[])[]): DependencyIssue | null {
  for (const [i, deps] of dependsOn.entries()) {
    for (const d of deps) {
      if (!Number.isInteger(d) || d < 0 || d >= dependsOn.length) return 'OUT_OF_RANGE';
      if (d === i) return 'SELF_REFERENCE';
    }
  }
  return null;
}

export function topologicalOrder(dependsOn: readonly (readonly number[])[]): TopoResult {
  const n = dependsOn.length;
  const indegree = dependsOn.map((deps) => new Set(deps).size);
  const dependents: number[][] = Array.from({ length: n }, () => []);
  for (const [i, deps] of dependsOn.entries()) {
    for (const d of new Set(deps)) dependents[d]?.push(i);
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) if (indegree[i] === 0) queue.push(i);
  const order: number[] = [];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    order.push(next);
    for (const dep of dependents[next] ?? []) {
      indegree[dep] = (indegree[dep] ?? 0) - 1;
      if (indegree[dep] === 0) queue.push(dep);
    }
  }
  if (order.length === n) return { ok: true, order };
  const placed = new Set(order);
  return { ok: false, cycle: Array.from({ length: n }, (_, i) => i).filter((i) => !placed.has(i)) };
}
