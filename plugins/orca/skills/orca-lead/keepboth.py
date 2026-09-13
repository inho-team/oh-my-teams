#!/usr/bin/env python3
"""충돌 마커가 있는 파일에서 양쪽을 모두 살린다 — 진행 기록처럼 **둘 다 덧붙인** 문서용.
코드 파일에는 쓰지 마라(양쪽을 이어 붙이면 컴파일이 안 되거나 더 나쁘게 된다)."""
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
pat = re.compile(r'^<<<<<<< [^\n]*\n(.*?)(?:^\|\|\|\|\|\|\| [^\n]*\n.*?)?^=======\n(.*?)^>>>>>>> [^\n]*\n', re.S | re.M)
n = 0
def sub(m):
    global n; n += 1
    a, b = m.group(1), m.group(2)
    return (a.rstrip('\n') + '\n\n' + b) if (a.strip() and b.strip()) else (a or b)
open(p, 'w', encoding='utf-8').write(pat.sub(sub, s))
print('  %s: 충돌 %d곳 — 양쪽 다 살림' % (p, n))
