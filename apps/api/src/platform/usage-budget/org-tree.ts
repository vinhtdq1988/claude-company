import type { OrgChartNode } from '@claude-company/contracts';

/** Tìm đơn vị trong cây sơ đồ tổ chức. */
export function findNode(nodes: readonly OrgChartNode[], id: string): OrgChartNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Id của đơn vị và mọi đơn vị con. */
export function subtreeIds(node: OrgChartNode): string[] {
  return [node.id, ...node.children.flatMap(subtreeIds)];
}

export function chartHasTeam(nodes: readonly OrgChartNode[], teamId: string): boolean {
  return nodes.some(
    (n) => n.teams.some((t) => t.id === teamId) || chartHasTeam(n.children, teamId),
  );
}
