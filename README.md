# AI Digest（本机流水线）

站点：https://zhbink.github.io/ai-digest/  
仓库：`zhbink/ai-digest`（GitHub Pages，仅静态 `data/` + `index.html`）

本目录在 Pages 仓库之上重建了采集/发布脚本（**不要把 `.secrets/`、`work/`、`.venv/` 提交进 git**）。

## 每日流程

1. **采集（Agent）**：用 Grok Bot 内置 X 读接口 `search_posts_all` 按 `config/sections.json` 账号/关键词拉取约 24h 帖子；每页 JSON 存到 `work/raw/<date>/`，再：
   ```bash
   .venv/bin/python scripts/merge_x_page.py work/raw/DATE/page-NN.json --date DATE --section agent
   ```
2. **ingest**：翻译、打标签、拉文章摘要、打推荐分，写出 `data/days/<date>.json` 并更新 `data/index.json`
   ```bash
   .venv/bin/python ingest.py --date DATE
   ```
3. **媒体**：
   ```bash
   .venv/bin/python scripts/backfill_media.py --date DATE
   ```
3.5 **编辑（Agent 必做，决定卡片质量）**：ingest 只生成草稿（`summary_zh` 是截断首段、`rec_reason` 为空、`needs_editorial: true`），翻译也可能静默失败。Agent 必须逐条阅读原帖和引用帖后亲自写：
   - `summary_zh`（卡片标题）：一句具体中文标题，谁做了什么、关键数字，如「Google TPU 将登陆 Oracle 云（OCI），这是 TPU 首次出现在 Google 以外的云平台」
   - `rec_reason`（推荐理由）：为什么重要/对谁有用，具体且不同于标题，如「TPU 外供打破 NVIDIA 在第三方云的垄断，算力采购多了新选择」
   - `text_zh`：所有非中文帖的完整中文翻译；`article_summary_zh`：X 文章/长文 3–5 句中文要点
   - 禁止「作者：分类」（如 `emollick：Agent / 框架 / 工作流动态。`）、「……——值得跟进」、分类标签（一般动态、长文/深度）
   ```bash
   .venv/bin/python scripts/editorial.py plan --date DATE    # → work/plans/DATE-editorial.json（含引用帖原文）
   # Agent 写 work/edits/DATE-editorial.json：{"<post_id>": {"summary_zh":…, "rec_reason":…, "text_zh":…, "article_summary_zh":…}}
   .venv/bin/python scripts/editorial.py apply --date DATE
   .venv/bin/python scripts/editorial.py check --date DATE   # 必须 bad=0；publish.sh 会自动检查并拒绝发布
   ```
4. **回复（硬门禁）**：Agent 按 `scripts/replies.py plan --date <DATE>` 把每条帖的会话评论抓到 `work/raw/<date>/replies-<id>.json`，写 `data/replies/<date>.summaries.json`（主题式中文讨论观点），再 `apply --date <DATE>`，最后 `check --date <DATE>`。**禁止**「评论区较活跃，详情见原帖。」等占位；`publish.sh` 会跑 `replies.py check`，缺 raw 或占位摘要时拒绝发布（exit 5）
5. **发布**：
   ```bash
   ./publish.sh
   ```
6. **备份关注**（需 CF key）：
   ```bash
   # /workspace/ai-digest-app/.secrets/sync.json → {"CF_DIGEST_ACCESS_KEY":"..."}
   .venv/bin/python scripts/backup_follows.py
   ```
7. **小家通知**（密钥在 `/workspace/.secrets/xiaojia-ai-news-hook.json`）：
   ```bash
   .venv/bin/python scripts/notify_xiaojia.py --date DATE
   ```

## 附属帖（收藏完了）

```bash
.venv/bin/python scripts/attached.py plan --date DATE
# Agent 搜索挑选后写入 work/raw/DATE/attached-<id>.json
.venv/bin/python scripts/attached.py apply --date DATE
./publish.sh
```

## 热度门槛

`models` / `coding` / `creative` / `industry`：约 likes≥120–150 或对应阅读量；`agent` / `zh` / `video` 不限。官方旗舰号有豁免。详见 `config/sections.json`。

## Pipeline scripts

密钥只放在仓库外的 `.secrets/` 和 `/workspace/.secrets/`，从不提交。

- `ingest.py` — 从 `work/seed/<date>/` 生成当日 JSON：翻译、打标、摘要、推荐分，并更新 `data/index.json`。
- `publish.sh` — 跑 editorial 检查后提交并推送 Pages（`data/`、`index.html`、`static/`）。
- `scripts/common.py` — 路径、热度门槛、媒体选取、分类与启发式打分等共用函数。
- `scripts/merge_x_page.py` — 把一页 X 搜索/时间线 JSON 合并进 `work/seed/<date>/`。
- `scripts/backfill_media.py` — 按当日帖子下载图片/短视频到 `data/media/<id>/`。
- `scripts/editorial.py` — 生成编辑计划、写回中文标题/推荐理由/译文，并在发布前检查占位文案。
- `scripts/replies.py` — 列出待拉评论的帖子，并把 `work/raw` 里的评论页写回当日 JSON。
- `scripts/attached.py` — 为已关注条目规划并写回附属帖（`attached_posts`）。
- `scripts/backup_follows.py` — 用 Cloudflare Worker 的访问密钥把关注/评论备份到 `work/follows/`。
- `scripts/notify_xiaojia.py` — 向小家桥发送当日中文简报（不打印 `notify_url`）。
- `scripts/xiaojia_send.py` — 按 `(kind, date)` 去重的小家一次性发送，账本在 `/workspace/.secrets/`。
- `scripts/tools/ingest_replies.py` — 把 Agent 工具输出里的评论页合并进 `work/raw`（从 `work/` 挪出的一次性工具）。
- `scripts/tools/merge_reply_page.py` — 把单个评论 JSON 页合并进 `work/raw/<date>/replies-<id>.json`。
