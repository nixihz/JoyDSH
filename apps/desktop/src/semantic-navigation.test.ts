import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scrollVisibleRegion } from './semantic-navigation.ts'

interface MockElement {
  dataset: Record<string, string>
  scrollTop: number
  hidden: boolean
  attributes: Record<string, string>
  parentElement: MockElement | null
  className: string
  children: MockElement[]
  closest(selector: string): MockElement | null
  contains(element: MockElement): boolean
  getAttribute(name: string): string | null
}

function createMockElement(options: {
  dataset?: Record<string, string>
  className?: string
  parentElement?: MockElement | null
  attributes?: Record<string, string>
} = {}): MockElement {
  const el: MockElement = {
    dataset: options.dataset ?? {},
    scrollTop: 0,
    hidden: false,
    attributes: options.attributes ?? {},
    parentElement: options.parentElement ?? null,
    className: options.className ?? '',
    children: [],
    closest(selector: string) {
      const parts = selector.split(',').map(s => s.trim())
      for (let curr: MockElement | null = el; curr !== null; curr = curr.parentElement) {
        for (const part of parts) {
          if (part.startsWith('.') && curr.className.split(' ').includes(part.slice(1))) return curr
          if (part.startsWith('[data-scroll-region="') && part.endsWith('"]')) {
            const expected = part.slice('[data-scroll-region="'.length, -2)
            if (curr.dataset.scrollRegion === expected) return curr
          }
          if (part === '[data-scroll-region]' && curr.dataset.scrollRegion !== undefined) return curr
        }
      }
      return null
    },
    contains(child: MockElement) {
      for (let curr: MockElement | null = child; curr !== null; curr = curr.parentElement) {
        if (curr === el) return true
      }
      return false
    },
    getAttribute(name: string) {
      return el.attributes[name] ?? null
    },
  }
  if (el.parentElement) {
    el.parentElement.children.push(el)
  }
  return el
}

describe('右摇杆与语义区域滚动 (scrollVisibleRegion)', () => {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window

  let elements: MockElement[] = []
  let querySelectorMap: Record<string, MockElement | null> = {}

  beforeEach(() => {
    elements = []
    querySelectorMap = {}
    // Mock document and window for scrollVisibleRegion
    globalThis.document = {
      querySelectorAll: ((selector: string) => {
        if (selector === '[data-scroll-region]') {
          return elements.filter(e => e.dataset.scrollRegion !== undefined)
        }
        return []
      }) as unknown as Document['querySelectorAll'],
      querySelector: ((selector: string) => {
        return querySelectorMap[selector] ?? null
      }) as unknown as Document['querySelector'],
    } as unknown as Document

    globalThis.window = {
      getComputedStyle: (() => ({
        display: 'block',
        visibility: 'visible',
      })) as unknown as typeof window.getComputedStyle,
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    globalThis.document = originalDocument
    globalThis.window = originalWindow
  })

  it('焦点在输入框时，右摇杆上下翻页优先滚动可见的动态记录列表', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const taskPanel = createMockElement({ className: 'task-panel', parentElement: root })
    const outputSurface = createMockElement({ dataset: { scrollRegion: 'task-output' }, parentElement: taskPanel })
    const taskInput = createMockElement({ dataset: { focusId: 'task-input' }, parentElement: taskPanel })

    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const activityList = createMockElement({ dataset: { scrollRegion: 'inspector-activity' }, parentElement: inspector })

    elements = [outputSurface, activityList]

    const target = scrollVisibleRegion(taskInput as unknown as Element, 240)
    expect(target).toBe(activityList)
    expect(activityList.scrollTop).toBe(240)
  })

  it('在变更页中，右摇杆默认优先滚动代码差异对比区域', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const taskInput = createMockElement({ dataset: { focusId: 'task-input' }, parentElement: root })
    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const fileList = createMockElement({ dataset: { scrollRegion: 'inspector-files' }, parentElement: inspector })
    const diffContent = createMockElement({ dataset: { scrollRegion: 'inspector-diff' }, parentElement: inspector })

    elements = [fileList, diffContent]

    const target = scrollVisibleRegion(taskInput as unknown as Element, 240)
    expect(target).toBe(diffContent)
    expect(diffContent.scrollTop).toBe(240)
  })

  it('在成果汇总页中，右摇杆优先滚动成果文件列表', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const taskInput = createMockElement({ dataset: { focusId: 'task-input' }, parentElement: root })
    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const artifactList = createMockElement({ dataset: { scrollRegion: 'inspector-artifacts' }, parentElement: inspector })

    elements = [artifactList]

    const target = scrollVisibleRegion(taskInput as unknown as Element, 240)
    expect(target).toBe(artifactList)
    expect(artifactList.scrollTop).toBe(240)
  })

  it('当焦点明确在变更文件列表项中时，右摇杆滚动文件列表容器', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const fileList = createMockElement({ dataset: { scrollRegion: 'inspector-files' }, parentElement: inspector })
    const fileButton = createMockElement({ dataset: { focusId: 'inspector-file-1' }, parentElement: fileList })
    const diffContent = createMockElement({ dataset: { scrollRegion: 'inspector-diff' }, parentElement: inspector })

    elements = [fileList, diffContent]

    const target = scrollVisibleRegion(fileButton as unknown as Element, 240)
    expect(target).toBe(fileList)
    expect(fileList.scrollTop).toBe(240)
  })

  it('当弹窗/蒙层打开时，右摇杆优先滚动弹窗内的内容', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const activityList = createMockElement({ dataset: { scrollRegion: 'inspector-activity' }, parentElement: root })

    const overlay = createMockElement({ className: 'command-overlay' })
    const commandList = createMockElement({ dataset: { scrollRegion: 'command-center' }, parentElement: overlay })
    const commandButton = createMockElement({ dataset: { focusId: 'command-1' }, parentElement: commandList })

    elements = [activityList, commandList]
    querySelectorMap['.command-overlay, .settings-overlay, .project-overlay, [role="dialog"]'] = overlay

    const target = scrollVisibleRegion(commandButton as unknown as Element, 240)
    expect(target).toBe(commandList)
    expect(commandList.scrollTop).toBe(240)
  })
})
