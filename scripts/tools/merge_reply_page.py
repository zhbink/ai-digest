#!/usr/bin/env python3
import json,sys
from pathlib import Path
pid=sys.argv[1]
path=Path(sys.argv[2])
raw=json.load(path.open())
out=Path(f"work/raw/2026-10-29/replies-{pid}.json")
if out.exists():
  cur=json.load(out.open())
else:
  cur={"data":[],"includes":{"users":[]},"meta":{}}
seen={t["id"] for t in cur.get("data") or []}
users={u["id"]:u for u in (cur.get("includes") or {}).get("users") or []}
for t in raw.get("data") or []:
  if t["id"] not in seen:
    cur.setdefault("data",[]).append(t); seen.add(t["id"])
for u in (raw.get("includes") or {}).get("users") or []:
  users[u["id"]]=u
cur["includes"]={"users":list(users.values())}
cur["meta"]=raw.get("meta") or cur.get("meta") or {}
json.dump(cur,out.open("w"),ensure_ascii=False,indent=2)
print(json.dumps({"id":pid,"n":len(cur["data"]),"next_token":(cur.get("meta") or {}).get("next_token")}))
