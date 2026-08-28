import { describe, expect, it } from 'vitest'
import { moveFocus, restoreFocus, type FocusGraph } from './index.ts'

describe('受控焦点图', () => {
  it('只按稳定 ID 的显式关系移动焦点', () => {
    const graph: FocusGraph = {
      entryId: 'workspace-path',
      nodes: [
        { id: 'workspace-path', group: 'main', order: 0, neighbors: { right: 'start' } },
        { id: 'start', group: 'main', order: 1, neighbors: { left: 'workspace-path', up: 'missing' } },
      ],
    }

    expect(moveFocus(graph, 'workspace-path', 'right')).toBe('start')
    expect(moveFocus(graph, 'start', 'left')).toBe('workspace-path')
    expect(moveFocus(graph, 'start', 'up')).toBe('start')
    expect(moveFocus(graph, 'unknown', 'right')).toBe('workspace-path')
  })

  it('焦点目标消失时按同组下一项、上一项和页面入口恢复', () => {
    const previous: FocusGraph = {
      entryId: 'settings',
      nodes: [
        { id: 'settings', group: 'header', order: 0 },
        { id: 'api-key', group: 'form', order: 0 },
        { id: 'base-url', group: 'form', order: 1 },
        { id: 'model', group: 'form', order: 2 },
      ],
    }
    const withNext: FocusGraph = {
      entryId: 'settings',
      nodes: [
        { id: 'settings', group: 'header', order: 0 },
        { id: 'api-key', group: 'form', order: 0 },
        { id: 'model', group: 'form', order: 2 },
      ],
    }
    const withPrevious: FocusGraph = {
      entryId: 'settings',
      nodes: [
        { id: 'settings', group: 'header', order: 0 },
        { id: 'api-key', group: 'form', order: 0 },
      ],
    }

    expect(restoreFocus(previous, previous, 'base-url')).toBe('base-url')
    expect(restoreFocus(previous, withNext, 'base-url')).toBe('model')
    expect(restoreFocus(previous, withPrevious, 'base-url')).toBe('api-key')
    expect(restoreFocus(previous, { entryId: 'settings', nodes: withNext.nodes.slice(0, 1) }, 'base-url')).toBe('settings')
  })
})
