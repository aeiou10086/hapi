# 本地开发约定

## 改完源码不需要"部署"

`hapi` 命令是个 wrapper 脚本，直接用 `bun run` 跑本仓库源码。

`which hapi` → `/Users/maseww/.nvm/versions/node/v22.18.0/bin/hapi`（symlink）→ `…/lib/node_modules/@twsxtd/hapi/bin/hapi.cjs`：
```bash
#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
exec bun run --cwd "$HOME/projects/hapi/cli" src/index.ts "$@"
```

所以改 cli/hub：保存即生效，下次执行 `hapi` 就是新版本。

⚠️ **唯一例外：web 端的修改**。hub 服务的是 `web/dist/` 里的预构建 bundle（`hub/src/web/server.ts:181`）。改完 `web/src/**` 必须 `bun run build:web` 重打 + 浏览器硬刷新（Cmd+Shift+R 避开 PWA SW 缓存）；或开 `bun run dev:web` 用 Vite HMR（访问的是 Vite dev 端口，不是 hapi 端口）。

可选 typecheck：`bun run typecheck`（或 `:cli` / `:web` / `:hub`）。

## 提交：push 到自己的 fork

远程 `mine` → `git@github.com:aeiou10086/hapi.git`。`origin` 是上游 `tiann/hapi`，**不要直接 push**。

## 修改与验证流程（重要）

每次改完源码后：

1. 改完 → 跟用户说清"改了什么"，并**明确告诉他验证这次改动需要做什么**：
   - 改了 `web/src/**` → "需要 `bun run build:web` + 浏览器硬刷新"
   - 改了 `hub/src/**` → "需要重启 hub"
   - 改了 `cli/src/**` → "**需要新开一个 hapi session**——老 session 在启动时就把 cli 代码加载进内存了，不会自动 reload，里面跑的还是旧代码"
     - 例外：`claudeRemote.ts` 里 init handler 这种"每次 spawn binary 都重新执行"的代码段，老 session 触发新一轮 binary spawn 就能生效，不必新开
   - 然后**主动询问用户是否已验证**
2. 用户**确认验证通过** → **立即** `git add` + `git commit` + `git push mine`，**别等用户再催**
3. 用户**还没验证 / 只验证了部分** → 把"未验证的具体改动列表"明确记下来（必要时 TodoWrite），后面有交互机会就**主动提醒** "刚才的 X、Y 改动你还没验证，要不要现在测一下"
4. **不要积累一堆未验证 + 未提交的改动**——回头分不清哪个是干净的、哪个还在调

**典型踩坑**：长跑 1 天以上的 session 里测一个新加的 cli 命令处理逻辑——永远看不到效果，因为老 session 用的是它启动那天的代码。先在 web UI 里**新建会话**再测。

## 不要做的事

- **不要 `bun run build:single-exe` 然后覆盖 `bin/hapi`**——会替换掉上面那个 wrapper，失去"改完即生效"。
- **不要 `bun run release-all`**——这是上游 `@twsxtd` scope 的 npm 发布脚本，本地 fork 没权限。

如果误覆盖了 wrapper：`npm i -g @twsxtd/hapi` 重装，再把 wrapper 内容写回 `…/@twsxtd/hapi/bin/hapi.cjs`。

## Hub 本地数据：`~/.hapi/hapi.db`（SQLite / better-sqlite3）

排查 web ↔ CLI 同步、消息丢失/重复时，查 DB 比看日志快。`hapi.db-wal` / `-shm` 是 WAL 模式副产物。

**关键表**：
- `messages` — 列：`id, session_id, content (JSON 字符串), created_at, seq, local_id`
- `sessions` — `metadata` 列里有 `claudeSessionId` 等

**`local_id` 前缀反查写入方**——出问题时按前缀就能定位代码：
- `local-<ts>-<rand>` → web 端 `web/src/lib/messages.ts` 的 `makeClientSideId('local')`（webapp 通过 `POST /sessions/:id/messages` 写入）
- `tw:<jsonl-uuid>` → hub 端 `hub/src/sync/transcriptWatcher.ts` 同步 JSONL transcript 时生成
- `null` → 多半是 CLI 通过 socket `'message'` 事件 push 的 agent 输出

**常用查询**：
```bash
# claude session id (来自 ps 里 --resume) → hub session id
sqlite3 ~/.hapi/hapi.db "SELECT id FROM sessions WHERE metadata LIKE '%<claude-session-uuid>%' LIMIT 1;"

# 某 session 最近的 user 消息（排除 tool_result 噪声）
sqlite3 ~/.hapi/hapi.db "SELECT seq, datetime(created_at/1000,'unixepoch','localtime'), local_id, substr(content,1,80) \
  FROM messages WHERE session_id='<hapi-session-id>' AND content LIKE '%role\":\"user\"%' AND content NOT LIKE '%tool_result%' \
  ORDER BY seq DESC LIMIT 10;"
```

**Claude Code 自身的 JSONL transcript** 是另一份独立来源：`~/.claude/projects/<escaped-cwd>/<claude-session-uuid>.jsonl`（escaped-cwd 把 `/` 换成 `-`）。这是二进制直接写的真相，hub DB 是同步进来的副本。**两边对不上时以 JSONL 为准**。
