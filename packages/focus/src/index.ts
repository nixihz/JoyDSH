export type FocusMove = 'up' | 'down' | 'left' | 'right' | 'previous-region' | 'next-region'

export interface FocusNode {
  id: string
  group: string
  order: number
  neighbors?: Partial<Record<FocusMove, string>>
}

export interface FocusGraph {
  entryId: string
  nodes: readonly FocusNode[]
}

export function moveFocus(graph: FocusGraph, currentId: string | undefined, move: FocusMove): string {
  const current = graph.nodes.find(node => node.id === currentId)
  if (current === undefined) return graph.entryId
  const targetId = current.neighbors?.[move]
  if (targetId === undefined || !graph.nodes.some(node => node.id === targetId)) return current.id
  return targetId
}

export function restoreFocus(previousGraph: FocusGraph, nextGraph: FocusGraph, previousId: string | undefined): string {
  if (nextGraph.nodes.some(node => node.id === previousId)) return previousId ?? nextGraph.entryId
  const previous = previousGraph.nodes.find(node => node.id === previousId)
  if (previous === undefined) return nextGraph.entryId
  const sameGroup = nextGraph.nodes.filter(node => node.group === previous.group)
  const next = sameGroup
    .filter(node => node.order > previous.order)
    .sort((left, right) => left.order - right.order)[0]
  if (next !== undefined) return next.id
  const prior = sameGroup
    .filter(node => node.order < previous.order)
    .sort((left, right) => right.order - left.order)[0]
  return prior?.id ?? nextGraph.entryId
}
