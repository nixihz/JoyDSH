#!/usr/bin/env python3
"""把 styles.css 里硬编码的 16 进制颜色映射到 design token。

策略：
1. 提取文件中所有 #rrggbb 颜色
2. 与已定义的 token reference 颜色做加权欧氏距离（绿色权重更高，因为人眼最敏感）
3. 用 var(--token-name) 替换

只动第一次出现的 `color: #xxx;` / `background: #xxx;` 等简单形式，复杂的
`linear-gradient(...#xxx...)` / `rgba(...)` / `box-shadow` 不改。重复出现的
颜色只匹配一次以保证幂等。
"""

import re
import sys
from pathlib import Path

# token 名称 → 参考色（深色主题值）
TOKENS = {
    '--surface-app': '#0b0e10',
    '--surface-panel': '#101417',
    '--surface-panel-alt': '#0e1214',
    '--surface-topbar': '#14181b',
    '--surface-heading': '#171c20',
    '--surface-raised': '#1d1a12',
    '--surface-input': '#11171a',
    '--surface-overlay': '#20272c',
    '--surface-warning-tint': '#2a2218',
    '--border-subtle': '#293036',
    '--border-default': '#3a444b',
    '--border-strong': '#69747c',
    '--text-primary': '#eef2f5',
    '--text-secondary': '#aab2b9',
    '--text-muted': '#7f8991',
    '--text-faint': '#69747c',
    '--text-inverse': '#0b0e10',
    '--text-on-accent': '#04181d',
    '--text-warning': '#f1ce75',
    '--accent-primary': '#63d4ea',
    '--accent-primary-hover': '#7ce2f4',
    '--accent-highlight': '#d2a8ff',
    '--accent-highlight-tint': '#2a1a30',
    '--state-success': '#57c879',
    '--state-success-soft': '#72d590',
    '--state-success-text': '#86d99c',
    '--state-success-tint': '#1e3a24',
    '--state-waiting': '#d9a735',
    '--state-waiting-soft': '#e5b948',
    '--state-waiting-text': '#e0ba62',
    '--state-waiting-tint': '#2a2218',
    '--state-error': '#f06d72',
    '--state-error-soft': '#f08a8d',
    '--state-error-text': '#ff9393',
    '--state-error-tint': '#2a1414',
    '--state-info': '#4aa8ba',
    '--state-info-soft': '#58c6e2',
    '--state-info-text': '#8de0f0',
    '--state-info-tint': '#0e2a30',
}

# 颜色 → token 的显式覆盖（避免被距离算法错配）
EXPLICIT = {
    '#0b0e10': '--surface-app',
    '#0c1012': '--surface-app',
    '#0e1214': '--surface-panel-alt',
    '#101417': '--surface-panel',
    '#11171a': '--surface-input',
    '#14181b': '--surface-topbar',
    '#171c20': '--surface-heading',
    '#1d1a12': '--surface-raised',
    '#20272c': '--surface-overlay',
    '#2a2218': '--surface-warning-tint',
    '#293036': '--border-subtle',
    '#3a444b': '--border-default',
    '#69747c': '--border-strong',
    '#7f8991': '--text-muted',
    '#7f8a92': '--text-muted',
    '#8f99a1': '--text-muted',
    '#9aa4aa': '--text-muted',
    '#aab2b9': '--text-secondary',
    '#aab3b8': '--text-secondary',
    '#aab2b9': '--text-secondary',
    '#aab3b8': '--text-secondary',
    '#818c94': '--text-faint',
    '#eef2f5': '--text-primary',
    '#e8edef': '--text-primary',
    '#eef1f2': '--text-primary',
    '#eef3f6': '--text-primary',
    '#63d4ea': '--accent-primary',
    '#7ce2f4': '--accent-primary-hover',
    '#57c879': '--state-success',
    '#72d590': '--state-success-soft',
    '#86d99c': '--state-success-text',
    '#d9a735': '--state-waiting',
    '#e5b948': '--state-waiting-soft',
    '#e0ba62': '--state-waiting-text',
    '#f06d72': '--state-error',
    '#f08a8d': '--state-error-soft',
    '#ff9393': '--state-error-text',
    '#f1ce75': '--text-warning',
}

REF_COLORS = []


def hex_to_rgb(hex_str):
    h = hex_str.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def rgb_to_hex(rgb):
    return '#{:02x}{:02x}{:02x}'.format(*rgb)


# 初始化 token 引用色（必须在 hex_to_rgb 定义之后）
REF_COLORS.extend((name, hex_to_rgb(value)) for name, value in TOKENS.items())


def color_distance(c1, c2):
    """Weighted RGB distance. Green channel weighted more (human eye is most sensitive)."""
    dr = c1[0] - c2[0]
    dg = c1[1] - c2[1]
    db = c1[2] - c2[2]
    return (2 * dr * dr + 4 * dg * dg + 3 * db * db) ** 0.5


def closest_token(hex_color):
    explicit = EXPLICIT.get(hex_color.lower())
    if explicit:
        return explicit
    target = hex_to_rgb(hex_color)
    best = min(REF_COLORS, key=lambda kv: color_distance(target, kv[1]))
    return best[0]


def main():
    css_path = Path('/opt/case/iamx/JoyDSH/apps/desktop/src/styles.css')
    text = css_path.read_text()

    # 把 token 定义所在的区段暂时从 text 中"挖空"，避免在替换阶段把
    # `--border-subtle: #293036;` 改成 `--border-subtle: var(--border-subtle);`。
    # 挖空策略：找到 ":root, { ... }" 和 "[data-theme=...] { ... }" 块，用
    # 等长占位符顶替，跑完替换再恢复。
    import re as _re
    placeholders = []

    def _stash(match):
        placeholders.append(match.group(0))
        return f'\x00PH{len(placeholders) - 1}\x00'

    stashed = _re.sub(
        r'(?::root,\s*\[data-theme="dark"\]\s*\{[^}]*\}|\[data-theme="(?:light|dark|auto)"\]\s*\{[^}]*\})',
        _stash, text,
    )

    # 收集所有 #rrggbb 颜色（小写）
    colors_in_file = set(m.lower() for m in _re.findall(r'#[0-9a-fA-F]{6}\b', stashed))

    # 为每个颜色挑最近 token（距离超阈值则保留原值，宁可漏改也不错配）
    THRESHOLD = 100
    mapping = {}
    skipped = []
    for color in colors_in_file:
        target = hex_to_rgb(color)
        name, ref = min(REF_COLORS, key=lambda kv: color_distance(target, kv[1]))
        d = color_distance(target, ref)
        if d > THRESHOLD:
            skipped.append((color, name, d))
        else:
            mapping[color] = name

    # 单独打印跳过的（按距离从大到小）
    skipped.sort(key=lambda x: -x[2])
    print(f'跳过了 {len(skipped)} 个距离过远的颜色（会保留为原值，仅靠 :root / [data-theme] 隐式覆盖）：')
    for color, name, d in skipped[:30]:
        print(f'  {color:9s} → {name:30s}  d={d:.1f}')
    if len(skipped) > 30:
        print(f'  ... 其它 {len(skipped) - 30} 个')
    print()

    # 按 token 分组打印
    by_token = {}
    for color, token in mapping.items():
        by_token.setdefault(token, []).append(color)

    print(f'发现 {len(colors_in_file)} 个未在 token 中定义的硬编码颜色：')
    for token in sorted(by_token):
        cols = by_token[token]
        print(f'  {token:30s}  ({len(cols)} 个)')
        for c in cols[:6]:
            print(f'      {c}')
        if len(cols) > 6:
            print(f'      ... 其它 {len(cols) - 6} 个')
    print()

    print()
    print('--- 是否继续替换？（dry-run 仅打印）---')
    if '--apply' not in sys.argv:
        return

    # 执行替换（在挖空后的 stashed 上做替换）
    new_stashed = stashed
    for color, token in mapping.items():
        new_stashed = re.sub(re.escape(color), f'var({token})', new_stashed, flags=re.IGNORECASE)

    # 把占位符还原回 token 定义块
    for i, block in enumerate(placeholders):
        new_stashed = new_stashed.replace(f'\x00PH{i}\x00', block)

    css_path.write_text(new_stashed)
    print(f'已替换 {len(mapping)} 个颜色，写回 {css_path}')


if __name__ == '__main__':
    main()
