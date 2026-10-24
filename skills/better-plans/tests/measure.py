"""Measure subagent transcripts: time, round trips, context added, model, tools used.

python measure.py LABEL=PATH.jsonl ...
Time: first to last timestamp. Round trips: distinct assistant message ids.
Context added: (input + cache read + cache creation) on the last call minus the first.
Gaps: seconds from each tool result (or the prompt) to the next assistant message, i.e. model time per round trip.
"""
import json, sys
from datetime import datetime


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def ctx(u):
    return u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)


for arg in sys.argv[1:]:
    label, path = arg.split('=', 1)
    rows = [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]
    rows = [r for r in rows if r.get('timestamp')]
    t0, t1 = ts(rows[0]['timestamp']), ts(rows[-1]['timestamp'])
    ids, usage, model, tools = [], {}, None, []
    gaps, last_in = [], ts(rows[0]['timestamp'])
    for r in rows:
        m = r.get('message') or {}
        if r.get('type') == 'assistant':
            mid = m.get('id')
            if mid not in ids:
                ids.append(mid)
                gaps.append(round((ts(r['timestamp']) - last_in).total_seconds(), 1))
            usage[mid] = m.get('usage', {})
            model = m.get('model', model)
            for c in m.get('content', []):
                if c.get('type') == 'tool_use':
                    n = c['name']
                    if n == 'Bash':
                        n += ':' + c['input'].get('command', '')[:60].replace('\n', ' ')
                    elif n in ('ArtifactData',):
                        n += ':' + c['input'].get('action', '') + ':' + str(c['input'].get('collection', ''))
                    elif n in ('Read', 'Write'):
                        n += ':' + c['input'].get('file_path', '').split('\\')[-1].split('/')[-1]
                    tools.append(n)
        elif r.get('type') == 'user':
            last_in = ts(r['timestamp'])
    first, last = usage[ids[0]], usage[ids[-1]]
    print(f"{label}: {(t1 - t0).total_seconds():.0f} s | {len(ids)} rt | +{(ctx(last) - ctx(first)) / 1000:.1f}k "
          f"(start {ctx(first) / 1000:.1f}k) | {model} | model gaps {gaps}")
    for t in tools:
        print('    ' + t)
