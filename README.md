# zcode2dsh

把 **ZCode / ZCodium** 的可迁移配置转移到 **DSH Desktop Beta** 的本地工具。

- 读取：Provider、模型、API Key、MCP server、全局 `AGENTS.md`、代理设置
- 写入：DSH profile 的 `cordis.patch.yml`、`.credentials.yaml`、`.env`、`AGENTS.md`
- 默认不覆盖 DSH 已有配置
- 所有写入前自动备份，支持一键恢复
- 全程不打印明文密钥
- 提供 `scan` / `plan` / `apply` / `restore` / `doctor` / `diff`

> 跨产品配置模型不同，**100% 无损不可能**。本工具保证：可映射字段都有确定映射；不可映射字段逐项写入报告；不静默丢弃；不覆盖已有配置。

---

## 一、快速开始

要求：Windows + Node.js 18+，DSH Desktop Beta 已安装。

```bat
cd /d <解压目录>

:: 1. 体检
node bin\zcode2dsh.js doctor

:: 2. 只读盘点
node bin\zcode2dsh.js scan

:: 3. 查看将执行的动作和 diff（不写文件）
node bin\zcode2dsh.js plan

:: 4. 确认后应用（建议先关闭 DSH Desktop Beta）
node bin\zcode2dsh.js apply

:: 5. 如需回滚
node bin\zcode2dsh.js restore --backup <备份ID>
```

也可以使用 `zcode2dsh.cmd`：

```bat
zcode2dsh.cmd scan
zcode2dsh.cmd plan
zcode2dsh.cmd apply
```

---

## 二、默认路径

### 源

| 内容 | 官方 ZCode | ZCodium |
|---|---|---|
| Provider 配置 | `<dataBaseDir>\.zcode\v2\config.json` | `<ZCODIUM_DATA_BASE_DIR>\.zcodium\v2\provider_config.json` |
| Provider 顺序 | 同目录 `model-provider-display-order.json` | 配置内 `providerOrder` |
| MCP / skills | `%USERPROFILE%\.zcode\cli\config.json` | `%USERPROFILE%\.zcodium\cli\config.json` |
| 设置 | `%USERPROFILE%\.zcode\v2\setting.json` | `%USERPROFILE%\.zcodium\v2\setting.json` |
| 全局指令 | `%USERPROFILE%\.zcode\AGENTS.md` | `%USERPROFILE%\.zcodium\AGENTS.md` |

- 官方 ZCode 的数据根优先读取 `setting.json` 的 `dataBaseDir`，失败时回退 `%USERPROFILE%\.zcode`。
- ZCodium 的数据根来自 `--zcodium-config`、`ZCODIUM_DATA_BASE_DIR`，或自动探测。
- 找不到时可用 `--zcode-config` / `--zcodium-config` 直接指定文件。

### 目标

| 内容 | 路径 |
|---|---|
| Profile patch | `%USERPROFILE%\.dsh-beta\profiles\desktop\cordis.patch.yml` |
| 凭据 | `%USERPROFILE%\.dsh-beta\.credentials.yaml` |
| 代理 | `%USERPROFILE%\.dsh-beta\.env` |
| 全局指令 | `%USERPROFILE%\.dsh-beta\AGENTS.md` |
| Skills | 不复制；DSH 扫描共享目录 `%USERPROFILE%\.agents\skills` |

DSH home 可用 `--dsh-home` 或 `DSH_HOME` 覆盖。
DSH 安装目录（用于加载自带 `yaml` 包）会自动从 `--dsh-app`、`DSH_APP_DIR`、`%LOCALAPPDATA%`、`%PROGRAMFILES%`、卸载注册表和常见盘符中探测。

路径都可以用参数覆盖，见下文。

---

## 三、映射规则

### Provider

| ZCode `kind` | DSH `api` |
|---|---|
| `anthropic` | `anthropic-messages` |
| `openai-compatible` | `openai-completions` |
| `openai` | `openai-responses` |

- Provider key：`zcode-<providerId前8位>` 或 `zcodium-<slug>`；冲突自动加后缀。
- `displayName` 使用 ZCode 的 provider 名称。
- `baseURL` 原样保留。
- API Key 不写进 `cordis.patch.yml`：
  - 生成 ref：`ZCODE_<8HEX>_API_KEY` / `ZCODIUM_<SLUG>_API_KEY`
  - 写入 `.credentials.yaml` 的 `refs`
  - provider 配置只写 `apiKeyEnv`
- 跳过：`enabled: false`、`systemDisabledReason`、空 Key、无模型、未知 kind。
- 保留 `model-provider-display-order.json` 的顺序。

### Model

- `id` = 实际发给 provider 的 wire model id。ZCode 模型带 `name` 字段时，`name` 才是 wire id；否则使用模型对象键。
- `name` = ZCode 模型对象键，作为 DSH 界面上的显示名。
- 示例：ZCode 对象键 `deepseek-v4.1-flash`、`name: deepseek-v4-flash` → DSH `id: deepseek-v4-flash`、`name: deepseek-v4.1-flash`。
- `contextWindow` = `limit.context`。
- `maxTokens` = `limit.output`。
- `input` = `modalities.input`，只保留 `text` / `image`；其他模态报告丢弃。
- `reasoning`：
  - 默认省略 `reasoningEfforts`，避免把 ZCode 的 `max` / `enabled` 直接当成网关 wire 值导致请求失败；
  - 报告中保留源端 `variants` / `defaultVariant`；
  - `--reasoning map` 可做直接映射（`off → null`，`enabled → high`，其他同名）。
- `zcode.modified`、`zcode.priority`、`deletedModels` 等元数据不迁移，报告中说明。

### MCP

- `type: http` → `transport: streamable-http`，映射 `url`、`headers`、`timeoutMs → toolCallTimeoutMs`。
- `type: stdio` → `transport: stdio`，映射 `command`、`args`、`env`、`cwd`。
- `type: sse` 不支持，报告中跳过。
- 每个 server 追加一条 `id: mcp-<source>-<serverName>` 的顶层条目。
- HTTP `Authorization` 头原样保留；`plan` 的 diff 会脱敏，实际写入的配置中包含原值。

### 代理

- 读取 `setting.json` 的 `httpProxy`。
- 写入 `$DSH_HOME/.env`：
  - `http_proxy=http://<host:port>`
  - `https_proxy=http://<host:port>`
- DSH 只支持 HTTP 代理，不支持 SOCKS/PAC；遇到 `socks5://` 跳过并报告。
- 启动环境已有 `HTTP_PROXY` / `HTTPS_PROXY` 时，启动环境优先于 `.env`。

### AGENTS.md 与 Skills

- 全局 `AGENTS.md` 原样复制到 `$DSH_HOME/AGENTS.md`；目标已存在时默认保留。
- Skills 不复制：DSH 已扫描 `~/.agents/skills`，与 ZCode 共用。
- ZCode `cli/config.json` 中 `enable: false` 的 skill 在 DSH 中仍会可见；DSH 没有等价的逐 skill 开关，报告会提示。

### 默认模型

- 默认**不改变** DSH 现有的 `agent-default-model`。
- `--set-default` 时从 ZCode 最新日志的 `runtimeModel` 检测；检测失败需显式 `--default <provider>/<model>`。
- 示例：`--set-default` 或 `--default zcode-0624d1ca/gemini-3.8-flash`。

---

## 四、冲突策略

`--conflict`：

| 策略 | 行为 |
|---|---|
| `keep`（默认） | 保留 DSH 已有 provider / credential ref / AGENTS / .env / 默认模型，只新增不存在的项；冲突逐项报告 |
| `prefer-zcode` | 用 ZCode 值覆盖冲突项，覆盖前备份 |
| `fail` | 遇到任何冲突立即中止，不写任何文件 |

已有 `deepseek` provider 和 `DEEPSEEK_API_KEY` 永远保留；迁移项使用独立 key 和 ref，不共享、不覆盖。

凭据 ref 冲突时：

- 值相同：直接复用；
- 值不同且策略为 `keep`：创建 `_2` 后缀的新 ref，不覆盖原值；
- 值不同且策略为 `prefer-zcode`：覆盖原 ref；
- 值不同且策略为 `fail`：中止。

---

## 五、命令与参数

```text
zcode2dsh scan   [options]     只读盘点
zcode2dsh plan   [options]     输出动作、冲突、diff
zcode2dsh apply  [options]     备份 → 写入 → 校验 → 报告
zcode2dsh restore --backup ID  恢复指定备份
zcode2dsh doctor [options]     检查路径、YAML、凭据、进程状态
zcode2dsh diff   [options]     只输出 diff
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--source zcode\|zcodium\|all` | 源，默认 `zcode` |
| `--dsh-home <path>` | DSH home，默认 `%USERPROFILE%\.dsh-beta` |
| `--profile <name>` | DSH profile，默认 `desktop` |
| `--dsh-app <path>` | DSH `resources/app`，用于加载自带 `yaml` 包 |
| `--conflict keep\|prefer-zcode\|fail` | 冲突策略 |
| `--reasoning omit\|map` | 推理等级映射 |
| `--set-default` | 设置 DSH 默认模型 |
| `--default <provider>/<model>` | 显式设置默认模型 |
| `--no-providers` | 跳过 provider |
| `--no-mcp` | 跳过 MCP |
| `--no-proxy` | 跳过代理 |
| `--no-agents` | 跳过 AGENTS.md |
| `--backup <id>` | 恢复用的备份 ID |
| `--backup-dir <path>` | 备份目录 |
| `--report-dir <path>` | 报告目录 |
| `--force` | DSH 正在运行时仍允许 apply/restore |
| `--restart` | apply 成功后启动 DSH |
| `--dry-run` | 等同于 plan |
| `--json` | 机器可读输出 |
| `--verbose` | 额外诊断 |

测试/调试用的路径覆盖：

`--zcode-config`、`--zcode-order`、`--zcode-cli`、`--zcode-setting`、`--zcode-agents`、`--zcodium-config`、`--zcodium-cli`、`--zcodium-setting`、`--zcodium-agents`、`--patch-path`、`--credentials-path`、`--dsh-env-path`、`--dsh-agents-path`。

---

## 六、备份与恢复

每次真正写入前，会在 `backups/<时间戳>/` 保存：

- `cordis.patch.yml`
- `.credentials.yaml`
- `.env`
- `AGENTS.md`（如果当时存在）
- `manifest.json`（路径、SHA256、大小、源、冲突策略、变更列表）

> 备份中的 `.credentials.yaml` 包含凭据原文，仅用于回滚。不要把 `backups/` 目录分享或上传。

恢复：

```bat
node bin\zcode2dsh.js restore --backup 2026-10-19T14-30-00-000Z
```

- `restore` 先校验备份 hash；
- 恢复前会再创建一个 `pre-restore-<时间戳>` 备份；
- 迁移时新建、迁移前不存在的文件，需要 `--force` 才会删除；
- 恢复路径必须在 DSH home 内，否则拒绝。

---

## 七、安全设计

1. **密钥零输出**：`scan` / `plan` / 日志 / JSON / HTML 只显示“已配置”或 ref 名；`diff` 中的凭据文件只显示“diff omitted”，MCP Authorization 头会脱敏。
2. **YAML 保真**：用 `yaml` 的 Document API 只修改目标节点，保留现有 `deepseek` provider、注释和顺序；解析失败立即中止。
3. **凭据保真**：保留 `.credentials.yaml` 全部现有 `refs` 和 `records`；只新增缺失 ref；格式不合法时不覆盖。
4. **原子写入**：同目录临时文件 + rename；写入后重新解析校验；失败自动回滚。
5. **幂等**：重复 `apply` 不重复添加 provider/MCP/ref；第二次运行报告“无变化”。
6. **运行状态**：默认要求关闭 DSH 后写入，`--force` 才允许运行中写入。
7. **不修改源**：ZCode / ZCodium 的安装目录和数据只读。

---

## 八、已知不可迁移项

- **会话历史**：ZCode SQLite → DSH zstd JSONL，格式不兼容。
- **ZCode 插件**：DSH Cordis 插件模型不同。
- **OAuth 登录态**：只迁移静态 API Key。
- **UI 设置**：最近项目、托盘、更新、Web 遥控等不迁移。
- **逐 skill 开关**：DSH 扫描共享 `~/.agents/skills`，没有 ZCode 的 `enable: false` 等价配置。
- **推理默认等级**：ZCode 的 `defaultVariant` 没有 DSH 等价字段；默认不写 `reasoningEfforts`。
- **Provider 显示顺序**：DSH 没有显式排序字段，按配置插入顺序展示。
- **`zcode.modified` / `priority` / `deletedModels`**：仅元数据，不迁移。

这些都会写入 `migration-report.json` 的 `warnings` / `skippedProviders` / `modelReport` 中。

---

## 九、输出报告

`apply` 会在 `reports/` 生成：

- `<timestamp>.json`：完整迁移摘要（无密钥）
- `<timestamp>.html`：可读报告（无密钥，diff 已脱敏）

报告内容包括：

- 源/目标路径
- 每个 provider 的映射结果和 action
- 跳过的 provider 及原因
- MCP 映射
- 代理、AGENTS、默认模型
- 凭据 ref 更新（只显示名称）
- 冲突、警告
- 备份 ID 和文件变更

---

## 十、开发与测试

```bat
cd /d <解压目录>
node test\run-tests.js
```

测试覆盖：

- provider/model/MCP/代理/AGENTS 映射
- ZCodium 适配器
- 默认模型检测
- apply 写入、幂等、restore 字节级恢复
- dry-run 不写文件
- 凭据冲突 keep / fail
- YAML 注释保留
- 报告不含明文密钥

依赖：只使用 DSH 安装目录自带的 `yaml` 包（通过 `--dsh-app` 定位），不额外联网安装。

---

## 十一、常见问题

**Q：apply 后 DSH 没看到新 provider？**
A：先完全退出 DSH 再重新启动。Profile patch 不一定热加载；凭据文件会热重载。

**Q：代理没生效？**
A：DSH 启动环境中的 `HTTP_PROXY` / `HTTPS_PROXY` 优先于 `$DSH_HOME/.env`。检查启动 DSH 的终端/快捷方式环境变量。

**Q：某个 provider 的请求失败？**
A：先看 `plan` 报告里的 `modelReport` 和 `api`。ZCode 的 `openai` kind 映射为 `openai-responses`；如果网关只支持 chat completions，需要手工把该 provider 的 `api` 改成 `openai-completions`，或使用 `--conflict prefer-zcode` 后编辑配置。

**Q：如何只迁移 MCP？**
A：`zcode2dsh apply --no-providers --no-agents --no-proxy`。

**Q：如何只迁移 provider？**
A：`zcode2dsh apply --no-mcp --no-agents --no-proxy`。

**Q：会改 ZCode 吗？**
A：不会。工具只读取 ZCode / ZCodium 配置，写入目标是 DSH。
