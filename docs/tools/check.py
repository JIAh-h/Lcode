"""Lcode 文档集校验：相对链接 + 原型自检（结构/色值/术语/JS 引用）。

用法：python docs/tools/check.py        （在 D:/li/Lcode 下执行）
"""
import re, io, os, glob, collections

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOCS = os.path.join(ROOT, 'docs')
PROTO = os.path.join(ROOT, 'prototype')
UI_COPY = os.path.join(ROOT, 'apps', 'desktop', 'renderer', 'i18n', 'en-US.ts')

# 规格内色值（来自 docs/10 §6.1）
SPEC_HEX = set('''#FFFFFF #F7F7F8 #F1F1F3 #E7E7EA #D9D9DE #1B1B1F #5A5A62 #9A9AA2 #2563EB #EEF4FE
#16A34A #DC2626 #D97706 #8B8B93 #E7F6EC #15803D #FDECEC #B91C1C
#101012 #161618 #1C1C1F #131315 #26262B #37373E #F2F2F4 #A6A6AE #6E6E76 #60A5FA #16233B
#4ADE80 #F87171 #FBBF24 #10291A #6EE7A0 #2B1416 #FCA5A5 #1D4ED8 #C2410C
#26215C #CECBF6 #3A3580 #fff #FF5F57 #FEBC2E #28C840 #8A8A92 #4A4A52'''.split())

BANNED_TERMS = ['presentationMeta', 'surfaceOp', 'fail-closed', '不变量', 'ABORTED', 'tool/result',
                'turn/end', 'step/end', 'seq ', 'EpochHeader', 'ModelSelection', 'credentialRef',
                'request/header', 'allowed-once', 'sandbox/mode', 'workspace-write']

# 19 §6.2 的用户界面术语黑名单。词典是桌面端所有可翻译文本的集中入口；扫描它
# 可以在不启动 Electron 的 CI 中拦截新增的内部协议词。最终页面文本由 portable
# 烟测再次覆盖，避免仅检查源代码而漏过渲染路径。
UI_BANNED_TERMS = [
    'tool/result', 'turn/end', 'session/event', 'presentationMeta', 'surfaceOp',
    'EpochHeader', 'ModelSelection', 'ABORTED_BEFORE_DISPATCH',
    'CREDENTIAL_REJECTED', 'TOOL_TIMEOUT', '不变量 I1', 'ADR-0022', 'seq ',
    'surface replace', 'fail-closed', '单调守卫', '水滴/洋葱', '插件降级',
    '派发模式', '回放态', '请求快照', 'todo_write',
]


def check_links():
    files = sorted(glob.glob(os.path.join(DOCS, '*.md'))) + sorted(glob.glob(os.path.join(PROTO, '*.html')))
    broken, total = collections.defaultdict(set), 0
    pat = re.compile(r'\]\((\.\.?/[^)#]+?)(#[^)]*)?\)')
    for f in files:
        text = io.open(f, encoding='utf-8').read()
        for m in pat.finditer(text):
            raw = m.group(1)
            target = os.path.normpath(os.path.join(os.path.dirname(f), raw))
            total += 1
            if not os.path.exists(target):
                broken[os.path.relpath(f, ROOT)].add(raw)
    print('相对链接: %d | 断链: %s' % (total, dict(broken) if broken else '无 OK'))
    return not broken


def check_proto():
    p = os.path.join(PROTO, 'lcode-mvp-prototype.html')
    s = io.open(p, encoding='utf-8').read()
    ok = True
    print('\n原型自检 %s' % os.path.relpath(p, ROOT))
    print('  行数 %d | 屏数 %d | div 配平差 %d'
          % (s.count('\n') + 1, s.count('<section class="screen'),
             s.count('<div') - s.count('</div>')))
    if s.count('<div') != s.count('</div>'):
        ok = False

    # JS 引用与 data-fold 目标必须存在
    html = s[:s.find('<script>')]
    html_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', html))
    js = s[s.find('<script>'):]
    js_ids = set(re.findall(r"""\$\(['"]#([A-Za-z0-9_-]+)['"]\)""", js))
    js_ids |= set(re.findall(r"""getElementById\(['"]([A-Za-z0-9_-]+)['"]\)""", js))
    folds = set(re.findall(r'data-fold="([A-Za-z0-9_-]+)"', s))
    miss_js, miss_fold = sorted(js_ids - html_ids), sorted(folds - html_ids)
    print('  JS 引用 id %d | 缺失 %s' % (len(js_ids), miss_js or '无 OK'))
    print('  data-fold %d | 缺失 %s' % (len(folds), miss_fold or '无 OK'))
    if miss_js or miss_fold:
        ok = False

    # 色值
    extra = sorted({h for h in set(re.findall(r'#[0-9A-Fa-f]{3,6}', s))
                    if h.upper() not in {x.upper() for x in SPEC_HEX}})
    print('  规格外色值: %s' % (extra or '无 OK'))
    if extra:
        ok = False

    # 术语（排除详情区/评审栏/style/script/svg）
    body = re.sub(r'<div class="detbody".*?</div>', '', s, flags=re.S)
    body = re.sub(r'<div class="cap">.*?</div>', '', body, flags=re.S)
    body = re.sub(r'<style.*?</style>', '', body, flags=re.S)
    body = re.sub(r'<script.*?</script>', '', body, flags=re.S)
    body = re.sub(r'<svg.*?</svg>', '', body, flags=re.S)
    hits = {b: body.count(b) for b in BANNED_TERMS if b in body}
    print('  界面残留术语: %s' % (hits or '无 OK'))
    if hits:
        ok = False
    return ok


def check_ui_copy():
    """检查桌面端用户文案词典，不扫描实现代码、日志或可展开诊断详情。"""
    if not os.path.exists(UI_COPY):
        print('\n桌面文案词典: 缺失 %s' % os.path.relpath(UI_COPY, ROOT))
        return False
    text = io.open(UI_COPY, encoding='utf-8').read()
    hits = {term: text.count(term) for term in UI_BANNED_TERMS if term in text}
    print('\n桌面文案词典 %s' % os.path.relpath(UI_COPY, ROOT))
    print('  术语黑名单命中: %s' % (hits or '无 OK'))
    return not hits


if __name__ == '__main__':
    a = check_links()
    b = check_proto()
    c = check_ui_copy()
    print('\n结果: %s' % ('全部通过 OK' if a and b and c else '存在问题'))
