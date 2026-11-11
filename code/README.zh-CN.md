# sakuracode

[English](README.md) · [简体中文](README.zh-CN.md)

**sakuracode 是一个开源的终端编程 Agent（命令行 AI 编程助手）。** 它读写你的代码，运行 shell 命令和测试，能朝着一个目标自己一直做下去；支持任何说 Chat Completions 的模型接口（在配置文件里自己选；DeepSeek 和 OpenCode Go 作为示例内置）。每一次工具调用在执行前都会经过自动审核。它基于 [Sakura Agent 框架](../README.zh-CN.md)（npm 包 `sakura-agent`），用法上类似 OpenAI Codex CLI 和 Claude Code。

```bash
npm install -g sakuracode
export MY_API_KEY=...   # 你在 ~/.sakura/config.toml 里设置的接口的密钥（见下文）
sakuracode "解释一下这个仓库"
```

* 交互式的内联会话：终端的回滚历史保留，提示符和状态栏停在窗口最后几行。大段粘贴显示成 `[Pasted Content N chars]`，但完整发送。
* 回复按 **Markdown** 渲染（标题、列表、表格、代码块、链接）。`exec` 也输出 Markdown。
* 斜杠命令、`!shell`、`@文件` 引用、续接、分叉、撤销、`/compact`、长时间目标（`/goal`）、MCP 服务、图片输入。
* Agent 工作时可以引导、排队或取消。
* 适合脚本和 CI 的 `exec` 模式，带 `--json` 事件流；有带多个方案（profile）的配置文件。
* 对每一次工具调用自动审核（先硬规则，再审核模型）；每一次决定都记录在会话文件里。
* 长会话：上下文快满时自动压缩对话，会话之后可以续接。
* 不绑定服务商：任何 Chat Completions 接口都在配置文件里设置；DeepSeek 和 OpenCode Go 为了方便而内置。

## 默认设置

| | |
|---|---|
| 工作目录 | Agent 从你启动命令的目录开始，并且**可以去任何地方**。没有任何东西被限制在这个目录里，也没有启用"目录之外"的规则。（`-C DIR` 只改变起点。） |
| 审核 | **开启。** 每一次工具调用都经过框架的审核插件：先硬规则，再审核模型。被拒绝的调用会作为工具错误回给 Agent。没有批准提示：审核自己做决定。 |
| 脱敏 | **关闭。** 用 `--redact`、配置里的 `redaction = true` 或 `/redaction on` 开启。它向模型服务商隐藏密钥；磁盘上的会话文件保留真实内容。 |
| 输出 | Markdown。 |

### 让它运行命令安全吗？

它**没有沙箱**：Agent 以你的用户权限运行，可以读写你能访问的任何位置的文件，运行任何命令。挡在它和你的机器之间的是自动审核（先硬规则，再审核模型）：审核检查写入、命令展开、凭据访问和灾难性的命令模式，拒绝它判断有害的操作，并把每一次决定记录在会话文件里。审核是一种判断，不是一堵墙：对不可信的任务，请把 sakuracode 放在你自己提供的容器或虚拟机里运行。对话（包括 Agent 读到的文件内容）会发送给你选择的模型服务商（审核是向同一个服务商的第二个请求，除非你另外配置）；使用 `--redact` 时，密钥在请求发出前被换成占位符，而你磁盘上的会话文件保留真实内容。

## 安装和运行

需要 Node 26 或更新版本（版本更低时 npm 会给出警告）。

```bash
npm install -g sakuracode
```

### 第一次启动：告诉它用哪个模型

sakuracode 不绑定某一家服务商。任何支持 Chat Completions（流式和工具调用）的接口都能用。你只需要在 `~/.sakura/config.toml` 里描述一次你的接口；API 密钥放在环境变量里，sakuracode 从不保存它。

```bash
mkdir -p ~/.sakura
cat > ~/.sakura/config.toml <<'EOF'
provider = "myprovider"

[providers.myprovider]
base_url = "https://api.example.com/v1"   # 你的接口地址
model = "your-model-name"
key_env = "MY_API_KEY"                    # 存放密钥的环境变量名
context_window = 128000                   # 模型的上下文窗口，单位 token
compat = "deepseek"                       # 兼容预设：deepseek、moonshot、openai
# headers = { "x-team" = "a" }            # 额外的请求头（如果接口需要）
# session_header = "x-session-id"         # 接收会话 id 的请求头（如果接口需要）
EOF
export MY_API_KEY=...
cd 你的项目
sakuracode "解释一下这个仓库"
```

`context_window` 很重要：状态栏和自动压缩都以它为准。`sakuracode providers` 显示已知的服务商以及它们的密钥是否已设置（不会显示密钥本身）。第一次启动时会创建 `~/.sakura/sessions/`。

**示例：OpenCode Go。**这是开发 sakuracode 时用的配置；其他任何接口的设置方式都一样：

```toml
provider = "opencode"

[providers.opencode]
base_url = "https://opencode.ai/zen/go/v1"
model = "deepseek-v4.1-flash"
key_env = "OPENCODE_API_KEY"
context_window = 1000000
compat = "deepseek"
images = true
session_header = "x-opencode-session"   # OpenCode Go 会拒绝没有会话 id 的请求
```

为了方便，DeepSeek 和 OpenCode Go 也是内置的：只设置了 `DEEPSEEK_API_KEY` 或 `OPENCODE_API_KEY`、没有配置文件时，sakuracode 使用它们的内置设置（128,000 token 窗口），并选第一个设置了密钥的。`--provider 名字` 可以为单次运行指定服务商。

缺什么，它会告诉你怎么做：

| 情况 | 你会看到 | 退出码 |
|---|---|---|
| 任何服务商都没有设置密钥 | `no API key found; set one of: ...` | 2 |
| 你选的服务商没有设置密钥 | `provider "myprovider" needs the environment variable MY_API_KEY` | 1 |
| 在管道或脚本里运行交互命令 | `the interactive session needs a terminal; use sakuracode exec for pipes and scripts` | 2 |

### 命令

```bash
sakuracode                          # 交互式会话
sakuracode "修好失败的测试"          # 交互式，提示立刻发出
sakuracode --provider opencode      # 选择服务商
sakuracode -i error.png "这个报错是什么意思？"   # 附上图片
sakuracode resume --last            # 续接最近的会话（不加 --last 会出现选择列表）
sakuracode fork --last              # 把最近的会话复制成新会话
sakuracode review --base main       # 对照 main 审查改动，并打印审查结果
sakuracode exec "总结这个仓库"                   # 运行一次，Markdown 输出到 stdout
sakuracode exec --json "列出 TODO" | jq .        # 事件以 JSON 行输出
echo "解释这个报错" | sakuracode exec -          # 从 stdin 读取提示
sakuracode sessions                 # 列出会话
sakuracode providers                # 服务商以及它们的密钥是否已设置（不显示密钥）
sakuracode acp                      # 在标准输入输出上提供 Agent Client Protocol（见下文）
```

### 选项

| 选项 | 含义 |
|---|---|
| `--provider NAME` | `deepseek`、`opencode`，或配置文件里的服务商 |
| `-p, --profile NAME` | 配置文件里的设置方案 |
| `-m, --model NAME` | 服务商的模型 |
| `--permissions NAME` | `auto`（默认）、`read-only`、`strict`、`full-access` |
| `-i, --image FILE[,FILE]` | 给第一条提示附上图片（png、jpg、gif、webp、bmp）；提示里的 `@pic.png` 或拖入的文件路径效果相同 |
| `--redact` / `--no-redact` | 开启 / 关闭脱敏（默认关闭） |
| `--thinking LEVEL` | `off`、`low`、`medium`、`high` |
| `--max-tokens N` | 每个模型请求的输出上限 |
| `-C, --cwd DIR` | 起始目录 |
| `--resume REF` | 续接会话（id、id 前缀、`last`） |
| `--json` | `exec`：事件以 JSON 行输出（第一行是 `session`，最后一行是 `result`） |
| `--raw` | `exec`：即使在终端里也原样输出 Markdown |
| `-q, --quiet` | `exec`：stderr 不输出进度行（警告和错误仍会显示） |
| `--output-last-message FILE` | `exec`：同时把最后的回复写入 FILE |
| `--no-color` | 不用颜色 |

`exec` 的退出码：0 完成，1 出错，2 用法错误或被审核熔断器暂停，130 已取消。在 `exec` 里，进度输出到 stderr（每个工具调用一行），最后的回复输出到 stdout；在终端里是渲染后的效果，在管道里是原始的 Markdown。

## 在会话里

| 按键 | 空闲时 | Agent 工作时 |
|---|---|---|
| Enter | 发送 | **引导**：在 Agent 的下一个模型请求之前送达 |
| Tab | 补全斜杠命令 | **排队**：Agent 要停下时处理 |
| Shift-Tab | 切换审查模式：auto、strict、read-only（`full-access` 只能用 `/permissions` 设置） | 运行结束后生效 |
| Esc | 关闭弹出列表 | **取消**这次运行 |
| Ctrl-C | 清空提示；在空提示上按两次退出 | 取消这次运行 |
| Ctrl-D | 退出（提示为空时） | |
| Shift-Enter、Alt-Enter、Ctrl-J，或 `\` 再按 Enter | 提示里换行 | |
| 上 / 下 | 历史，或在行之间移动 | |
| Ctrl-A/E/K/U/W/Y、Alt-方向键 | readline 风格的编辑 | |

运行中输入的消息显示在提示上方，标为"引导"或"排队"，直到 Agent 接收。

### 斜杠命令

| 命令 | |
|---|---|
| `/help` | 列出命令 |
| `/status` | 会话、目录、模型、权限、剩余上下文、输入（缓存的和新的）、缓存命中率、输出 |
| `/model [provider[/model]]` | 显示或切换服务商和模型（Agent 会关闭并在同一个会话文件上重新创建） |
| `/permissions [auto\|read-only\|strict\|full-access]` | 显示或修改被审核的范围 |
| `/redaction [on\|off]` | 向模型隐藏密钥 |
| `/rename <name>` | 给会话起名 |
| `/compact` | 总结对话以腾出上下文 |
| `/new`、`/clear` | 开始新会话（`/clear` 同时清屏） |
| `/resume [id\|last]` | 续接之前的会话（不带参数时出现选择列表） |
| `/fork` | 把这个会话复制成新会话，并在新会话里继续 |
| `/undo` | 回到你上一条消息之前，并把它放回提示里（在空提示上按两次 Esc 效果相同） |
| `/init` | 让 Agent 写一份 `AGENTS.md` |
| `/review [focus]` | 让 Agent 审查未提交的改动 |
| `/diff` | 显示 `git diff` |
| `/goal [objective\|clear]` | 显示目标；带文字时设定目标并开始工作；`clear` 结束目标 |
| `/mcp` | 显示 MCP 服务 |
| `/exit`、`/quit` | 退出 |

`!命令` 由你自己运行一条 shell 命令并显示输出（Agent 看不到）。提示里的 `@路径` 向 Agent 指明一个已有的文件或目录。

### 权限预设

| 预设 | |
|---|---|
| `auto`（默认） | 审核开启 |
| `read-only` | 审核开启，并且 Agent 只有 `read` 工具 |
| `strict` | 审核开启；连续三次被拒绝就暂停这次运行 |
| `full-access` | 审核关闭 |

它们都不限制工作目录：审核插件以 `directoryRules: false` 运行，所以启动目录之外的路径本身不是拒绝的理由。写入、命令展开、凭据和灾难性的模式仍然由硬规则和审核模型检查。

## 在 T3 Code 和其他 ACP 客户端里使用

`sakuracode acp` 在标准输入和标准输出上说 [Agent Client Protocol](https://agentclientprotocol.com)（ACP，版本 1），所以 ACP 客户端可以把它当作自己的编程 Agent 来运行。标准输出只有协议消息；日志写到标准错误（`SAKURACODE_ACP_LOG=off|error|warn|info|debug`，默认 `warn`）。

**T3 Code：** Settings → Providers → Add provider → Show more → **Local ACP command**，填写：

到处都要用**绝对路径**：T3 Code 从它自己的工作目录启动命令，相对路径会失败，而且桌面应用的 `PATH` 往往比 shell 里的短。在终端用 `which node` 和 `which sakuracode`（或 `npm root -g`）找到路径。

| 字段 | 内容 |
|---|---|
| Name | `Sakura Code`（随意） |
| Executable | `node` 的绝对路径，例如 `/opt/homebrew/bin/node` |
| Arguments | 每个参数一行：`--disable-warning=ExperimentalWarning`，然后是 `sakuracode.mjs` 的绝对路径（全局安装：`<npm root -g>/sakuracode/dist/code/bin/sakuracode.mjs`；源码目录：`<仓库>/code/bin/sakuracode.mjs`），最后是 `acp` |
| Environment | 你所用服务商的密钥，例如 `DEEPSEEK_API_KEY`、`OPENCODE_API_KEY` 或 `COMMANDCODE_API_KEY`（桌面应用看不到 shell 里的环境变量） |

如果应用里的 `PATH` 完整，Executable 也可以是 `sakuracode` 命令的绝对路径（`which sakuracode`），Arguments 只写一行 `acp`。

然后用这个 provider 开一个对话。想手动验证：运行 `sakuracode acp`，粘贴 `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}` 再按回车，会返回一行 JSON。

模型选择器会列出 `~/.sakura/config.toml` 里的所有服务商（以及内置的）；选一个就在同一段对话上切换过去。有推理强度的模型还会出现思考等级选择器。没有设置密钥的服务商会列出，并说明要设置哪个变量。

现在可用：对话（回复和推理流式显示）、取消正在运行的一轮、同时开多个对话（每个对话一次只处理一条消息）。新对话使用审核模式 `auto`（每次调用都审核）；在 `acp` 后加 `--permissions strict` 或 `read-only` 可以更改，`full-access` 只有在这条命令行上明确要求时才会生效。工具调用显示为卡片（读文件、带 diff 的修改、带输出的命令），上下文计量会随每次回复更新，对话里可以用 `/compact` 和 `/status`。暂时没有：图片、附件、恢复对话、客户端传来的 MCP 服务器。详见 `docs/acp-design.md`。

## 配置

`~/.sakura/config.toml`（设置 `SAKURA_HOME` 可以改用别的目录；会话保存在它旁边的 `sessions/` 里）。优先级：默认值 < 文件 < 方案 < 环境变量（`SAKURA_PROVIDER`、`SAKURA_MODEL`）< 命令行选项。

```toml
provider = "opencode"
permissions = "auto"
redaction = false
thinking = "medium"
max_tokens = 32000
# 空闲自动压缩：在 cache_ttl_minutes 分钟没有活动之后，至少 auto_compact_min_tokens
# （不会低于 1000）大小的上下文会被压缩；方案里也可以设置这些
cache_ttl_minutes = 5
auto_compact_min_tokens = 20000
auto_compact_idle = true

[profiles.cheap]
provider = "deepseek"
thinking = "low"

[providers.lab]                    # 任何 Chat Completions 接口
base_url = "https://example.com/v1"
model = "some-model"
key_env = "LAB_API_KEY"
context_window = 128000
compat = "deepseek"                # 框架的兼容预设：deepseek、moonshot、openai
headers = { "x-team" = "a" }
session_header = "x-session-id"    # 如果接口需要，把会话 id 放进这个请求头

[mcp.servers.files]
command = "npx"
args = ["-y", "some-mcp-server"]
```

### 服务商

| 名称 | 接口 | 模型 | 密钥 |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| `opencode` | `https://opencode.ai/zen/go/v1` | `deepseek-v4.1-flash` | `OPENCODE_API_KEY` |

两者都用框架的 `compatPresets.deepseek`。OpenCode Go 要求每个请求都带会话请求头；终端会发送 `x-opencode-session: <会话 id>`。不用 `-p` 时，使用第一个设置了密钥的服务商。密钥从环境变量读取，从不打印或保存。

## 常见问题

**它支持哪些模型？** 任何支持 Chat Completions（流式和工具调用）的接口，都可以在 `~/.sakura/config.toml` 里用 `[providers.名字]` 设置。试用过 DeepSeek 和 OpenCode Go，它们也是内置的。

**会话存在哪里，怎么续接？** 在 `~/.sakura/sessions/`（设置 `SAKURA_HOME` 可以改用别的目录），每个会话一个只追加的文件。`sakuracode resume --last` 续接最近的一个；`sakuracode sessions` 列出它们；`/fork` 复制一个。

**对话太长了会怎样？** 上下文快满时（以及空闲几分钟之后）会自动总结，也可以输入 `/compact`；最近的部分原样保留。`/status` 显示上下文有多满，以及输入里有多少来自服务商的缓存。

**能用在脚本和 CI 里吗？** 能：`sakuracode exec "任务"` 不带界面运行一条提示，回复写到 stdout，进度写到 stderr，退出码是 0（完成）、1（出错）、2（用法错误或被审核暂停）或 130（已取消）。`--json` 把事件输出成 JSON 行。

**能让它自己朝一个目标一直做下去吗？** 能：`/goal "让测试通过"` 设定目标并开始工作；Agent 要停下之前会对照目标检查。

**它和 Codex CLI 有什么不同？** Codex CLI 是 OpenAI 的产品，有沙箱模式和批准策略。sakuracode 是开源 Sakura 框架的参考终端：它用自动审核代替沙箱和批准提示，支持任何 Chat Completions 接口，并且只基于公开的 SDK 构建，所以它做的一切，你都可以用 `sakura-agent` 在自己的 Agent 里做到。

## 开发

在仓库根目录运行这些命令：

```bash
npm ci
npm --prefix code start
npm --prefix code test        # 包括伪终端测试（需要 python3）
npm --prefix code run typecheck
npm pack ./code               # 生成发布用的 tarball（npm publish ./code 发布它）
```

测试套件不使用网络。要用真实的服务商测试，运行 `node --disable-warning=ExperimentalWarning code/test/live/interactive.ts PROVIDER WORKDIR [HOME]`。

文档（英文）：[docs/design.md](docs/design.md)（模块和接口）、[docs/test-report.md](docs/test-report.md)（运行了什么，包括失败的）、[docs/framework-gaps.md](docs/framework-gaps.md)（框架缺什么，以及提出的改动）。

## 还没做

剪贴板图片粘贴、后台命令结束时唤醒 Agent、子 Agent 的定义、`--full-auto` 风格的选项（请用 `--permissions full-access`）、主题，以及 TOML 的表数组配置。其中一些要等框架支持，原因见 `docs/framework-gaps.md`。
