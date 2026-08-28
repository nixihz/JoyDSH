import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MarkdownContent } from './MarkdownContent.tsx'

describe('MarkdownContent', () => {
  it('正确渲染标题、粗体、行内代码与列表', () => {
    const md = `
## 问题 1 (Section A — Issue tracker)

**这个仓库的 issue 记录在哪里？**

探索发现你的远端是自建 SSH git 服务器 (\`git.xiezhi.xin:2222\`)，选项：

- **A. Local markdown（推荐）** — issue 作为 markdown 文件存在仓库 \`.scratch/<feature>/\` 下
- **B. GitHub** — 用 \`gh\` CLI 操作 GitHub Issues
`
    const html = renderToString(<MarkdownContent content={md} />)

    expect(html).toContain('<h2')
    expect(html).toContain('问题 1 (Section A — Issue tracker)')
    expect(html).toContain('<strong>这个仓库的 issue 记录在哪里？</strong>')
    expect(html).toContain('markdown-inline-code')
    expect(html).toContain('git.xiezhi.xin:2222')
    expect(html).toContain('<ul')
    expect(html).toContain('<li')
    expect(html).toContain('<strong>A. Local markdown（推荐）</strong>')
  })

  it('正确渲染带语言的代码块', () => {
    const md = '```ts\nconst x: number = 42\n```'
    const html = renderToString(<MarkdownContent content={md} />)

    expect(html).toContain('markdown-code-block')
    expect(html).toContain('ts')
    expect(html).toContain('const x: number = 42')
  })

  it('正确渲染无语言标记的代码块', () => {
    const md = '```\necho "hello world"\n```'
    const html = renderToString(<MarkdownContent content={md} />)

    expect(html).toContain('markdown-code-block')
    expect(html).toContain('echo &quot;hello world&quot;')
  })

  it('正确渲染引用与超链接', () => {
    const md = `
> 注意：这是一个提示信息

参考文档：[JoyDSH 官网](https://joydsh.org)
`
    const html = renderToString(<MarkdownContent content={md} />)

    expect(html).toContain('<blockquote')
    expect(html).toContain('注意：这是一个提示信息')
    expect(html).toContain('markdown-link')
    expect(html).toContain('href="https://joydsh.org"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('正确渲染 GFM 表格和删除线', () => {
    const md = `
| 选项 | 说明 |
| --- | --- |
| A | 本地 |
| B | 远端 |

~已废弃~
`
    const html = renderToString(<MarkdownContent content={md} />)

    expect(html).toContain('markdown-table-wrapper')
    expect(html).toContain('<table')
    expect(html).toContain('<th>选项</th>')
    expect(html).toContain('<td>本地</td>')
    expect(html).toContain('<del>已废弃</del>')
  })

  it('正确渲染 Markdown 图片标签', () => {
    const md = '![架构图](https://example.com/arch.png)'
    const html = renderToString(<MarkdownContent content={md} />)

    expect(html).toContain('markdown-image-wrapper')
    expect(html).toContain('markdown-image')
    expect(html).toContain('src="https://example.com/arch.png"')
    expect(html).toContain('alt="架构图"')
  })
})
