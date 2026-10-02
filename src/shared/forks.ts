import { isHiddenSession } from './queue';
import type { MonitorState, Session } from './types';

export interface ForkNode {
  id: string;
  session?: Session;
  parentId: string | null;
  children: string[];
  depth: number;
}
export interface ForkFamily {
  rootId: string;
  nodes: Map<string, ForkNode>;
  /** Invalid source cycles are broken deterministically, never followed forever. */
  hasCycle: boolean;
}

/** Source ancestry crosses all local groups, including Library and Monitor archives. */
export function forkFamily(state: MonitorState, selectedId: string): ForkFamily | null {
  const sessions = Object.values(state.sessions).filter((s) => !isHiddenSession(s));
  if (!sessions.some((s) => s.id === selectedId)) return null;
  const nodes = new Map<string, ForkNode>(
    sessions.map((session) => [
      session.id,
      {
        id: session.id,
        session,
        parentId: null,
        children: [],
        depth: 0,
      },
    ]),
  );
  for (const session of sessions) {
    const parent = session.lineage?.parentId;
    if (!parent || !parent.startsWith(`${session.provider}:`)) continue;
    nodes.get(session.id)!.parentId = parent;
    if (!nodes.has(parent))
      nodes.set(parent, { id: parent, parentId: null, children: [], depth: 0 });
  }
  const visited = new Set<string>(),
    broken = new Set<string>();
  for (const start of nodes.keys()) {
    const path = new Set<string>();
    let current: string | null = start;
    while (current && !visited.has(current)) {
      if (path.has(current)) {
        const cycle = [current];
        for (
          let id = nodes.get(current)!.parentId;
          id && id !== current;
          id = nodes.get(id)!.parentId
        )
          cycle.push(id);
        const cut = cycle.sort()[0];
        nodes.get(cut)!.parentId = null;
        broken.add(cut);
        break;
      }
      path.add(current);
      current = nodes.get(current)!.parentId;
    }
    for (const id of path) visited.add(id);
  }
  for (const node of nodes.values())
    if (node.parentId) nodes.get(node.parentId)!.children.push(node.id);
  for (const node of nodes.values())
    node.children.sort(
      (a, b) =>
        (nodes.get(a)!.session?.createdAt || 0) - (nodes.get(b)!.session?.createdAt || 0) ||
        a.localeCompare(b),
    );
  let rootId = selectedId;
  while (nodes.get(rootId)!.parentId) rootId = nodes.get(rootId)!.parentId!;
  const family = new Map<string, ForkNode>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!,
      node = nodes.get(id)!;
    family.set(id, node);
    for (const child of node.children) nodes.get(child)!.depth = node.depth + 1;
    pending.push(...node.children.toReversed());
  }
  return { rootId, nodes: family, hasCycle: [...broken].some((id) => family.has(id)) };
}

export function forkPath(family: ForkFamily, id: string): Set<string> {
  const path = new Set<string>();
  let current: string | null = id;
  while (current && !path.has(current)) {
    path.add(current);
    current = family.nodes.get(current)?.parentId ?? null;
  }
  return path;
}

export function forkDescendants(family: ForkFamily, id: string): ForkNode[] {
  const result: ForkNode[] = [],
    pending = [...(family.nodes.get(id)?.children || [])];
  while (pending.length) {
    const node = family.nodes.get(pending.pop()!)!;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

export function visibleForks(
  family: ForkFamily,
  selected: string,
  collapsed: Set<string>,
  focus: boolean,
): ForkNode[] {
  const path = forkPath(family, selected);
  const included = focus
    ? new Set([...path, ...forkDescendants(family, selected).map((n) => n.id)])
    : null;
  const result: ForkNode[] = [],
    pending = [family.rootId];
  while (pending.length) {
    const node = family.nodes.get(pending.pop()!)!;
    if (included && !included.has(node.id)) continue;
    result.push(node);
    if (!collapsed.has(node.id)) pending.push(...node.children.toReversed());
  }
  return result;
}
