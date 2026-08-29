import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activateFocusedElement,
  adjustSelectValue,
  deleteBackwardFromTextEntry,
  mapVoiceInputTrigger,
  scrollVisibleRegion,
} from './semantic-navigation.ts'

interface MockElement {
  dataset: Record<string, string>
  scrollTop: number
  scrollLeft: number
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
    scrollLeft: 0,
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

interface MockTextEntry {
  value: string
  selectionStart: number
  selectionEnd: number
  disabled: boolean
  readOnly: boolean
  setRangeText(replacement: string, start: number, end: number): void
  dispatchEvent(event: Event): boolean
}

function createMockTextEntry(value: string): {
  entry: HTMLInputElement
  events: string[]
} {
  const events: string[] = []
  const mockEntry: MockTextEntry = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    disabled: false,
    readOnly: false,
    setRangeText(replacement: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + replacement + this.value.slice(end)
      this.selectionStart = start + replacement.length
      this.selectionEnd = this.selectionStart
    },
    dispatchEvent(event: Event) {
      events.push(event.type)
      return true
    },
  }
  return { entry: mockEntry as unknown as HTMLInputElement, events }
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

  it('指针位于中间任务会话时，右摇杆滚动中间动态记录', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const taskPanel = createMockElement({ className: 'task-panel', parentElement: root })
    const outputSurface = createMockElement({ dataset: { scrollRegion: 'task-output' }, parentElement: taskPanel })
    const taskInput = createMockElement({ dataset: { focusId: 'task-input' }, parentElement: taskPanel })
    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const activityList = createMockElement({ dataset: { scrollRegion: 'inspector-activity' }, parentElement: inspector })

    elements = [outputSurface, activityList]

    const target = scrollVisibleRegion(taskInput as unknown as Element, 240, outputSurface as unknown as Element)
    expect(target).toBe(outputSurface)
    expect(outputSurface.scrollTop).toBe(240)
    expect(activityList.scrollTop).toBe(0)
  })

  it('指针位于左侧会话列表时，右摇杆滚动左侧列表', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const sessionList = createMockElement({ dataset: { scrollRegion: 'sessions-sidebar' }, parentElement: root })
    const sessionCard = createMockElement({ dataset: { focusId: 'session-card-0' }, parentElement: sessionList })
    const taskPanel = createMockElement({ className: 'task-panel', parentElement: root })
    const taskInput = createMockElement({ dataset: { focusId: 'task-input' }, parentElement: taskPanel })
    const outputSurface = createMockElement({ dataset: { scrollRegion: 'task-output' }, parentElement: taskPanel })

    elements = [sessionList, outputSurface]

    const target = scrollVisibleRegion(taskInput as unknown as Element, 240, sessionCard as unknown as Element)
    expect(target).toBe(sessionList)
    expect(sessionList.scrollTop).toBe(240)
    expect(outputSurface.scrollTop).toBe(0)
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

  it('右摇杆横轴滚动当前语义内容区域', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const diffContent = createMockElement({ dataset: { scrollRegion: 'inspector-diff' }, parentElement: inspector })
    elements = [diffContent]

    const target = scrollVisibleRegion(diffContent as unknown as Element, 0, null, 240)
    expect(target).toBe(diffContent)
    expect(diffContent.scrollLeft).toBe(240)
    expect(diffContent.scrollTop).toBe(0)
  })
})

describe('手柄下拉选项调整', () => {
  it('X 在下拉框上应打开选项层，不提交所在表单', () => {
    const originalHTMLElement = globalThis.HTMLElement
    const originalHTMLSelectElement = globalThis.HTMLSelectElement
    const originalHTMLInputElement = globalThis.HTMLInputElement
    const originalHTMLTextAreaElement = globalThis.HTMLTextAreaElement
    let submitted = 0
    let opened = 0

    class MockHTMLElement {}
    class MockInputElement extends MockHTMLElement {}
    class MockTextAreaElement extends MockHTMLElement {}
    class MockSelectElement extends MockHTMLElement {
      form = {
        querySelector: () => ({
          hasAttribute: () => false,
          click: () => { submitted += 1 },
        }),
      }
    }

    Object.assign(globalThis, {
      HTMLElement: MockHTMLElement,
      HTMLSelectElement: MockSelectElement,
      HTMLInputElement: MockInputElement,
      HTMLTextAreaElement: MockTextAreaElement,
    })

    try {
      const select = new MockSelectElement() as unknown as HTMLSelectElement
      activateFocusedElement(select, 'gamepad', () => { opened += 1 })
      expect(opened).toBe(1)
      expect(submitted).toBe(0)
    } finally {
      Object.assign(globalThis, {
        HTMLElement: originalHTMLElement,
        HTMLSelectElement: originalHTMLSelectElement,
        HTMLInputElement: originalHTMLInputElement,
        HTMLTextAreaElement: originalHTMLTextAreaElement,
      })
    }
  })

  it('按方向跳过禁用项并派发原生 input/change 事件', () => {
    const dispatched: string[] = []
    const select = {
      options: [{ disabled: false }, { disabled: true }, { disabled: false }],
      selectedIndex: 0,
      dispatchEvent: (event: Event) => {
        dispatched.push(event.type)
        return true
      },
    } as unknown as HTMLSelectElement

    expect(adjustSelectValue(select, 1)).toBe(true)
    expect(select.selectedIndex).toBe(2)
    expect(dispatched).toEqual(['input', 'change'])
    expect(adjustSelectValue(select, 1)).toBe(false)
  })
})

describe('手柄文字删除', () => {
  it('删除光标前的一个字符并派发 input 事件', () => {
    const { entry, events } = createMockTextEntry('hello')

    expect(deleteBackwardFromTextEntry(entry)).toBe(true)
    expect(entry.value).toBe('hell')
    expect(entry.selectionStart).toBe(4)
    expect(entry.selectionEnd).toBe(4)
    expect(events).toEqual(['input'])
  })

  it('删除选区并正确处理代理对字符', () => {
    const { entry } = createMockTextEntry('A\u{1F600}BC')
    entry.selectionStart = 3
    entry.selectionEnd = 4

    expect(deleteBackwardFromTextEntry(entry)).toBe(true)
    expect(entry.value).toBe('A\u{1F600}C')

    entry.selectionStart = 3
    entry.selectionEnd = 3
    expect(deleteBackwardFromTextEntry(entry)).toBe(true)
    expect(entry.value).toBe('AC')
    expect(entry.selectionStart).toBe(1)
  })

  it('光标已在开头或输入框只读时不修改内容', () => {
    const { entry } = createMockTextEntry('hello')
    entry.selectionStart = 0
    entry.selectionEnd = 0
    expect(deleteBackwardFromTextEntry(entry)).toBe(false)
    expect(entry.value).toBe('hello')

    entry.readOnly = true
    entry.selectionStart = 5
    entry.selectionEnd = 5
    expect(deleteBackwardFromTextEntry(entry)).toBe(false)
    expect(entry.value).toBe('hello')
  })
})

describe('外部听写桥触发语义', () => {
  it('键盘产生一次短按，手柄保留按下与松开', () => {
    expect(mapVoiceInputTrigger('voice-input', 'keyboard')).toBe('tap')
    expect(mapVoiceInputTrigger('voice-input', 'gamepad')).toBe('press')
    expect(mapVoiceInputTrigger('voice-input-release', 'gamepad')).toBe('release')
    expect(mapVoiceInputTrigger('voice-input-release', 'keyboard')).toBeUndefined()
    expect(mapVoiceInputTrigger('confirm', 'gamepad')).toBeUndefined()
  })
})

describe('焦点管理辅助函数 (focusManagedElement)', () => {
  const originalDocument = globalThis.document
  let domElements: { dataset: Record<string, string>; hasAttribute(name: string): boolean; focus: () => void }[] = []
  let focusedIndex = -1

  beforeEach(() => {
    domElements = []
    focusedIndex = -1
    globalThis.document = {
      querySelectorAll: ((selector: string) => {
        if (selector === '[data-focus-id]') {
          return domElements
        }
        return []
      }) as unknown as Document['querySelectorAll'],
    } as unknown as Document
  })

  afterEach(() => {
    globalThis.document = originalDocument
  })

  it('成功聚焦未禁用的目标元素', async () => {
    const { focusManagedElement } = await import('./semantic-navigation.ts')
    domElements = [
      {
        dataset: { focusId: 'project-tab-0' },
        hasAttribute: () => false,
        focus: () => { focusedIndex = 0 },
      },
      {
        dataset: { focusId: 'project-tab-1' },
        hasAttribute: () => false,
        focus: () => { focusedIndex = 1 },
      },
    ]

    const result = focusManagedElement('project-tab-1')
    expect(result).toBe(true)
    expect(focusedIndex).toBe(1)
  })

  it('跳过被禁用的元素或不存在的元素', async () => {
    const { focusManagedElement } = await import('./semantic-navigation.ts')
    domElements = [
      {
        dataset: { focusId: 'disabled-button' },
        hasAttribute: (attr: string) => attr === 'disabled',
        focus: () => { focusedIndex = 0 },
      },
    ]

    expect(focusManagedElement('disabled-button')).toBe(false)
    expect(focusManagedElement('non-existent')).toBe(false)
    expect(focusedIndex).toBe(-1)
  })
})

describe('手柄模式与鼠标模式分离与指针隔离', () => {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window

  beforeEach(() => {
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

  it('在无 pointerTarget 时，手柄滚动优先按当前焦点或主工作区路由，不受鼠标残留影响', () => {
    const root = createMockElement({ className: 'workspace-grid' })
    const taskPanel = createMockElement({ className: 'task-panel', parentElement: root })
    const outputSurface = createMockElement({ dataset: { scrollRegion: 'task-output' }, parentElement: taskPanel })
    const taskInput = createMockElement({ dataset: { focusId: 'task-input' }, parentElement: taskPanel })

    const inspector = createMockElement({ className: 'task-inspector', parentElement: root })
    const activityList = createMockElement({ dataset: { scrollRegion: 'inspector-activity' }, parentElement: inspector })

    const elements = [outputSurface, activityList]
    globalThis.document = {
      querySelectorAll: ((selector: string) => {
        if (selector === '[data-scroll-region]') return elements
        return []
      }) as unknown as Document['querySelectorAll'],
      querySelector: (() => null) as unknown as Document['querySelector'],
    } as unknown as Document

    const target = scrollVisibleRegion(taskInput as unknown as Element, 240, null)
    expect(target).toBe(activityList)
    expect(activityList.scrollTop).toBe(240)
  })
})
