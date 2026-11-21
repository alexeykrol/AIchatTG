#!/usr/bin/env python3
"""Pass counts per kind for several own-judge result sets on the questions judged in all of them.
    python3 scripts/eval/judge_own/compare_pass.py NAME=results.jsonl[,more.jsonl] ...
Later files of one NAME override earlier rows of the same question (for a judge resumed in parts)."""
import collections, json, sys
sets = {}
for arg in sys.argv[1:]:
    name, paths = arg.split('=', 1); d = {}
    for p in paths.split(','):
        for line in open(p, encoding='utf-8'):
            r = json.loads(line)
            if r.get('status') == 'judged': d[r['q']] = r
    sets[name] = d
common = sorted(set.intersection(*(set(d) for d in sets.values())))
kinds = ['answerable', 'unanswerable', 'conflicting']
print(f'common judged questions: {len(common)}')
print('| run | ' + ' | '.join(kinds) + ' | all |\n|---|' + '---:|' * 4)
for name, d in sets.items():
    c = collections.Counter(d[q]['kind'] for q in common if d[q]['pass'])
    n = collections.Counter(d[q]['kind'] for q in common)
    print(f'| {name} | ' + ' | '.join(f'{c[k]}/{n[k]}' for k in kinds) + f' | {sum(c.values())}/{len(common)} |')
