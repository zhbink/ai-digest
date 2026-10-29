#!/usr/bin/env python3
from pathlib import Path
import json, re, sys
ROOT = Path('/workspace/ai-digest-app')
RAW = ROOT/'work/raw/2026-10-29'
TOOLS = Path('/workspace/agent-tools')
STATE = ROOT/'work/plans/reply-ingest-seen.json'
seen = set(json.loads(STATE.read_text())) if STATE.exists() else set()
day=json.load(open(ROOT/'data/days/2026-10-29.json'))
post_ids={p['id'] for p in day['posts']}

def extract_json(text):
  text=re.sub(r'</?cursor_untrusted[^>]*>','',text).strip()
  i=text.find('{'); j=text.rfind('}')
  if i<0 or j<0: return None
  return json.loads(text[i:j+1])

def merge(pid, page):
  out=RAW/f'replies-{pid}.json'
  cur=json.load(out.open()) if out.exists() else {'data':[],'includes':{'users':[]},'meta':{}}
  seen_ids={t['id'] for t in cur.get('data') or []}
  users={u['id']:u for u in (cur.get('includes') or {}).get('users') or []}
  for t in page.get('data') or []:
    if t['id'] not in seen_ids:
      cur.setdefault('data',[]).append(t); seen_ids.add(t['id'])
  for u in (page.get('includes') or {}).get('users') or []:
    users[u['id']]=u
  cur['includes']={'users':list(users.values())}
  cur['meta']=page.get('meta') or cur.get('meta') or {}
  json.dump(cur, out.open('w'), ensure_ascii=False, indent=2)
  return len(cur['data'])

n_new=0
for f in TOOLS.glob('*.txt'):
  if f.name in seen: continue
  try: page=extract_json(f.read_text())
  except: continue
  if not page or 'data' not in page: continue
  conv=None
  for t in page.get('data') or []:
    cid=t.get('conversation_id')
    if cid and cid in post_ids: conv=cid; break
  if not conv:
    for t in page.get('data') or []:
      for ref in t.get('referenced_tweets') or []:
        if ref.get('type')=='replied_to' and ref.get('id') in post_ids:
          conv=ref['id']; break
      if conv: break
  if not conv: continue
  merge(conv, page); seen.add(f.name); n_new+=1
STATE.write_text(json.dumps(sorted(seen),indent=2))
plan=json.load(open(ROOT/'work/plans/2026-10-29-replies.json'))
for p in plan['posts']:
  path=RAW/f"replies-{p['id']}.json"
  if path.exists():
    cur=json.load(path.open())
    p['n']=len(cur.get('data') or [])
    p['next_token']=(cur.get('meta') or {}).get('next_token')
    p['fetched_pages']=max(1, (p.get('n')+24)//25)
json.dump(plan, open(ROOT/'work/plans/2026-10-29-replies.json','w'), ensure_ascii=False, indent=2)
have=sum(1 for p in plan['posts'] if p.get('n'))
need=[p['id'] for p in plan['posts'] if not p.get('n')]
print(json.dumps({'new':n_new,'have':have,'need':len(need),'next':need[:30]},ensure_ascii=False))
