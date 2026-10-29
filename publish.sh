#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
MSG=${1:-"digest update $(date -u +%Y-%m-%dT%H:%MZ)"}

# Refuse to publish template headlines / 推荐理由 (see scripts/editorial.py).
# Checks every day file changed vs HEAD (plus today's UTC+8 date).
PY=.venv/bin/python; [[ -x $PY ]] || PY=python3
CHK_DATES=$( { git diff --name-only HEAD -- data/days/ 2>/dev/null; git ls-files --others --exclude-standard data/days/ 2>/dev/null; } | sed -n 's#^data/days/\([0-9-]*\)\.json$#\1#p' | sort -u)
for D in $CHK_DATES; do
  if ! "$PY" scripts/editorial.py check --date "$D"; then
    echo "ERROR: $D has stub headlines/rec_reason/missing translations. Run: $PY scripts/editorial.py plan --date $D, write work/edits/$D-editorial.json, then apply." >&2
    [[ "${ALLOW_STUBS:-}" == 1 ]] || exit 4
  fi
done

git add data/ index.html static/ .nojekyll README.md config/ scripts/ ingest.py publish.sh .gitignore 2>/dev/null || true
if ! git diff --cached --quiet; then
  git -c user.name="ai-digest-bot" -c user.email="ai-digest@local" commit -m "$MSG"
fi

if [[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]]; then
  TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
  git push "https://x-access-token:${TOKEN}@github.com/zhbink/ai-digest.git" HEAD:main
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  git push origin HEAD:main
else
  echo "ERROR: no GitHub auth (set GH_TOKEN or run gh auth login)" >&2
  exit 3
fi
echo "published: $MSG"
