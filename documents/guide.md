# Sakura 使用指南

完整的使用指南，30 分钟掌握所有核心功能。

## 目录
- [Part 1: Agent 基础](#part-1-agent-基础)
- [Part 1.5: agno 保留功能](#part-15-agno-保留功能)
- [Part 2: 工程化工具](#part-2-工程化工具)
- [Part 3: 性能优化](#part-3-性能优化)
- [Part 4: 最佳实践](#part-4-最佳实践)

---

## Part 1: Agent 基础

### Agent 核心

Sakura 继承 agno 的核心架构，基于一个**主循环**：

```python
class Agent:
    def run(self, prompt):
        messages = [system_prompt, user_prompt]

        while True:
            # 调用 LLM
            response = model.invoke(messages, tools)

            # 如果有工具调用，执行并继续
            if response.tool_calls:
                results = execute_tools(response.tool_calls)
                messages.append(results)
                continue

            # 否则返回
            return response
```

### 创建第一个 Agent

```python
from sakura import Agent, OpenAI, tool

# 1. 定义工具
@tool
def search(query: str) -> str:
    """搜索网络"""
    # 实现搜索逻辑
    return f"Results for {query}"

@tool
def calculate(expression: str) -> float:
    """计算数学表达式"""
    return eval(expression)

# 2. 创建 Agent
agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[search, calculate],
    system_prompt="You are a helpful assistant"
)

# 3. 运行
result = agent.run("搜索 Python 并计算 2+2")
print(result.content)
```

### 多轮对话

```python
messages = []

# 第一轮
result = agent.run("你好", messages=messages)
messages.append({"role": "assistant", "content": result.content})

# 第二轮
messages.append({"role": "user", "content": "我想学 Python"})
result = agent.run("", messages=messages)
```

### 流式响应

```python
# 异步流式
async for chunk in agent.astream("写一个故事"):
    print(chunk.content, end="", flush=True)
```

---

## Part 1.5: agno 保留功能

### 记忆系统

agno 的对话记忆系统**完整保留**：

```python
from sakura import Agent
from sakura.memory import ConversationMemory

# 创建带记忆的 Agent
agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[search],
    memory=ConversationMemory(
        max_messages=50,  # 保留最近 50 条消息
        summarize_threshold=40  # 超过 40 条时自动总结
    )
)

# 记忆会自动管理
result = agent.run("我叫张三")
result = agent.run("我叫什么名字？")  # 会记得 "张三"
```

**特性**：
- ✅ 自动记忆历史对话
- ✅ 可配置记忆窗口大小
- ✅ 自动总结旧消息
- ✅ 完全兼容 agno API

### 用户画像

agno 的用户画像功能**完整保留**：

```python
from sakura import Agent
from sakura.user import UserProfile

# 创建用户画像
profile = UserProfile(
    user_id="user123",
    preferences={
        "language": "Chinese",
        "expertise_level": "intermediate",
        "interests": ["Python", "AI"]
    }
)

# Agent 使用用户画像
agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[search],
    user_profile=profile
)

# Agent 会根据用户画像调整行为
result = agent.run("教我编程")
# 会考虑 expertise_level=intermediate 和 language=Chinese
```

**特性**：
- ✅ 持久化用户偏好
- ✅ 个性化响应
- ✅ 多用户支持
- ✅ 完全兼容 agno API

### 去除的组件

为了性能优化，Sakura 去除了以下 agno 组件：

#### 1. 默认监控系统

```python
# ❌ agno：默认启用监控（-100ms）
agent = AgnoAgent(model=..., tools=...)
# 自动记录所有调用、token 使用、耗时等

# ✅ Sakura：监控可选
agent = Agent(model=..., tools=..., monitor=None)  # 不监控

# 需要时可以启用
from sakura.monitor import PerformanceMonitor
agent = Agent(model=..., tools=..., monitor=PerformanceMonitor())
```

**原因**：监控系统在每次调用时都会记录日志，增加 100ms 开销。生产环境通常不需要详细监控。

#### 2. Pydantic 运行时验证

```python
# ❌ agno：每次都验证（-50ms）
class Message(BaseModel):
    role: str
    content: str
    # 每次赋值都会验证类型

# ✅ Sakura：关闭运行时验证
class Message(BaseModel):
    model_config = ConfigDict(validate_assignment=False)
    # 只在初始化时验证，后续不验证
```

**原因**：消息对象创建和修改频繁，运行时验证成为瓶颈。初始化验证已经足够。

#### 3. 深拷贝消息

```python
# ❌ agno：深拷贝保护（-50ms）
messages = copy.deepcopy(history)
messages.append(new_msg)

# ✅ Sakura：浅拷贝
messages = [*history, new_msg]
```

**原因**：深拷贝很慢，消息对象通常不会被修改，浅拷贝足够安全。

#### 4. 同步/异步自动转换

```python
# ❌ agno：run() 内部调用 arun()（-50ms）
def run(self, prompt):
    return asyncio.run(self.arun(prompt))

# ✅ Sakura：纯同步路径
def run(self, prompt):
    response = self.model.invoke_sync(...)
    return response
```

**原因**：asyncio.run() 会创建新事件循环，有显著开销。纯同步实现更快。

### 保留 vs 优化 vs 去除

| 功能 | agno | Sakura | 说明 |
|------|------|--------|------|
| **记忆系统** | ✅ | ✅ 保留 | 完整 API 兼容 |
| **用户画像** | ✅ | ✅ 保留 | 完整 API 兼容 |
| **工具系统** | ✅ | ✅ 保留 | 完整 API 兼容 |
| **主循环** | ✅ | ✅ 保留 | 完整 API 兼容 |
| **监控系统** | ✅ 默认 | ⚡ 可选 | 性能优化 |
| **Pydantic 验证** | ✅ 运行时 | ⚡ 初始化 | 性能优化 |
| **消息拷贝** | 🐌 深拷贝 | ⚡ 浅拷贝 | 性能优化 |
| **同步/异步** | 🐌 自动转换 | ⚡ 独立实现 | 性能优化 |

**总结**：
- **保留**：所有核心功能（记忆、用户画像、工具、主循环）
- **优化**：去除性能瓶颈，保持 API 兼容
- **结果**：-70% 框架开销，100% 功能保留

---

## Part 2: 工程化工具

Sakura 新增一系列工程化工具，让 Agent 更适合生产环境。

### 2.1 Task Tool（TODO 管理）

Task tool 让 LLM 可以跟踪和管理任务进度，类似 Claude Code 的 TodoWrite。

#### 基本使用

```python
from sakura import FastAgent, OpenAI
from sakura.tools import task

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[task, search, write, code]
)

result = agent.run("""
    帮我完成以下任务：
    1. 研究 Python asyncio 最佳实践
    2. 实现一个异步爬虫
    3. 编写单元测试
    4. 生成文档
""")
```

#### Task Tool 实现

```python
@tool
def task(
    description: str,
    status: str = "pending",
    action: str = "add"
) -> str:
    """
    管理任务列表

    Args:
        description: 任务描述
        status: pending/in_progress/completed
        action: add/update/list

    Returns:
        当前任务列表状态
    """
    # 类似 TodoWrite 的实现
    if action == "add":
        # 添加新任务
        tasks.append(Task(description=description, status=status))
    elif action == "update":
        # 更新任务状态
        task = find_task(description)
        task.status = status
    elif action == "list":
        # 列出所有任务
        return format_tasks(tasks)

    return format_tasks(tasks)
```

#### LLM 如何使用

```python
# 用户请求
result = agent.run("研究 Python asyncio 并实现爬虫")

# LLM 内部会调用：
# 1. task(description="研究 Python asyncio", status="pending", action="add")
# 2. task(description="研究 Python asyncio", status="in_progress", action="update")
# 3. search("Python asyncio 最佳实践")
# 4. task(description="研究 Python asyncio", status="completed", action="update")
# 5. task(description="实现异步爬虫", status="in_progress", action="add")
# 6. code("async def crawl()...")
# 7. task(description="实现异步爬虫", status="completed", action="update")
```

#### 特性

- ✅ 自动跟踪任务进度
- ✅ 可视化任务列表
- ✅ 支持并行任务
- ✅ 持久化任务状态

### 2.2 SubAgent Tool（子 Agent）

SubAgent tool 创建隔离的子 Agent，拥有独立的工具集和提示词。

#### 基本使用

```python
from sakura import FastAgent, OpenAI
from sakura.tools import subagent

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[subagent, search, write]
)

result = agent.run("深度研究三个技术主题并生成报告")
```

#### SubAgent Tool 实现

```python
@tool
def subagent(
    prompt: str,
    config: str = "general-purpose",
    description: str = ""
) -> str:
    """
    创建子 Agent 执行任务

    Args:
        prompt: 任务描述
        config: SubAgent markdown 配置文件名
        description: 简短描述（可选）

    Returns:
        子 Agent 的执行结果
    """
    # 加载配置
    config_obj = load_subagent_config(f"subagents/{config}.md")

    # 创建新的 Agent 实例
    sub = Agent(
        model=resolve_model(config_obj.model),
        tools=[get_tool(t) for t in config_obj.tools],
        system_prompt=config_obj.role  # markdown 内容作为提示词
    )

    # 递归调用（这是关键）
    result = sub.run(prompt)
    return result.content
```

#### SubAgent Markdown 配置

在 `subagents/researcher.md` 创建配置：

```markdown
---
name: researcher
description: 专业技术研究员
tools: search_web, read_file, summarize
model: gpt-4
---

# ROLE
You are a professional technical researcher specializing in deep analysis.

Your responsibilities:
- Conduct thorough research
- Analyze multiple sources
- Provide structured summaries
- Cite all sources

# AVAILABLE TOOLS
- **search_web**: Search the internet for information
- **read_file**: Read local files and documentation
- **summarize**: Create concise summaries of content

# WORK PRINCIPLES
1. Always verify information from multiple sources
2. Prioritize recent and authoritative sources
3. Structure findings clearly with headings
4. Include proper citations for all claims
5. Highlight contradictions or uncertainties

# OUTPUT FORMAT
## 🔍 Executive Summary
[2-3 sentences summarizing key findings]

## 📊 Detailed Findings
### Finding 1: [Title]
[Detailed analysis with evidence]

### Finding 2: [Title]
[Detailed analysis with evidence]

## 📚 Sources
- [Source 1 with URL and date]
- [Source 2 with URL and date]

## 💡 Recommendations
[Actionable next steps based on research]
```

#### 配置字段说明

**Frontmatter（YAML 头）**：

```yaml
---
name: researcher           # 必需：SubAgent 名称
description: "..."         # 必需：简短描述
tools: tool1, tool2        # 必需：可用工具（逗号分隔）
model: gpt-4              # 可选：模型（不写则继承主 Agent）
---
```

**正文部分**：

- **ROLE**：定义 SubAgent 的身份和职责（作为系统提示词）
- **AVAILABLE TOOLS**：解释每个工具的用途
- **WORK PRINCIPLES**：工作方法和准则
- **OUTPUT FORMAT**：强制输出格式（确保一致性）

#### 内置 SubAgent

Sakura 提供几个内置 SubAgent：

```
subagents/
├── general-purpose.md    # 通用 Agent
├── researcher.md         # 研究员（深度分析）
├── coder.md             # 编码员（实现功能）
├── reviewer.md          # 审查员（代码审查）
└── documenter.md        # 文档编写员
```

#### LLM 如何使用

```python
# 用户请求
result = agent.run("深度研究 Python asyncio 最佳实践")

# LLM 内部会调用：
# 1. subagent(
#      prompt="研究 Python asyncio 最佳实践",
#      config="researcher",
#      description="深度技术研究"
#    )
# 2. SubAgent 执行（使用 researcher.md 配置）：
#    - search_web("Python asyncio best practices")
#    - read_file("asyncio_docs.md")
#    - summarize(...)
# 3. SubAgent 返回结构化报告
```

#### 特性

- ✅ 隔离的执行上下文
- ✅ 独立的工具集
- ✅ 专门的提示词
- ✅ Markdown 配置易维护
- ✅ 支持自定义 SubAgent

**重要**：Task 和 SubAgent 是**完全独立**的工具，没有关系。

### 2.3 多工具并行执行

Sakura 支持并行执行多个工具调用，提升效率。

#### 基本使用

```python
from sakura import FastAgent, OpenAI

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[search, fetch, calculate],
    parallel_tools=True  # 启用并行
)

result = agent.run("搜索三个主题并获取它们的详细信息")
```

#### 工作原理

```python
# LLM 可能返回多个工具调用：
response.tool_calls = [
    ToolCall(name="search", args={"query": "Python asyncio"}),
    ToolCall(name="search", args={"query": "Python typing"}),
    ToolCall(name="search", args={"query": "Python dataclass"})
]

# Sakura 并行执行：
import asyncio

async def execute_parallel(tool_calls):
    tasks = [
        execute_tool(call.name, call.args)
        for call in tool_calls
    ]
    # 并行等待所有工具完成
    results = await asyncio.gather(*tasks)
    return results

# 结果返回给 LLM
```

#### 性能对比

```python
# ❌ 串行执行（agno）
search("topic1")  # 2s
search("topic2")  # 2s
search("topic3")  # 2s
# 总计：6s

# ✅ 并行执行（Sakura）
[search("topic1"), search("topic2"), search("topic3")]  # 并行
# 总计：2s（节省 4s）
```

#### 特性

- ✅ 自动检测可并行工具
- ✅ 显著减少执行时间
- ✅ 完全透明（LLM 无需改变）
- ✅ 错误隔离（一个失败不影响其他）

### 2.4 SubAgent 并行执行

创建多个 SubAgent 同时工作。

#### 基本使用

```python
from sakura import FastAgent, OpenAI
from sakura.tools import subagent

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[subagent, search, write],
    parallel_subagents=True  # 启用 SubAgent 并行
)

result = agent.run("用三个专家分析这个技术问题")
```

#### 工作原理

```python
# LLM 可能创建多个 SubAgent：
response.tool_calls = [
    ToolCall(name="subagent", args={"prompt": "分析架构", "config": "architect"}),
    ToolCall(name="subagent", args={"prompt": "分析性能", "config": "perf-expert"}),
    ToolCall(name="subagent", args={"prompt": "分析安全", "config": "security-expert"})
]

# Sakura 并行创建和执行：
async def execute_subagents(calls):
    subagents = []
    for call in calls:
        config = load_config(call.args["config"])
        sub = Agent(
            model=resolve_model(config.model),
            tools=[get_tool(t) for t in config.tools],
            system_prompt=config.role
        )
        subagents.append(sub)

    # 并行执行所有 SubAgent
    results = await asyncio.gather(*[
        sub.arun(call.args["prompt"])
        for sub, call in zip(subagents, calls)
    ])
    return results
```

#### 使用场景

**✅ 适合并行**：
- 多个独立的分析任务
- 不同专家视角
- 大规模信息收集
- 分布式处理

**❌ 不适合并行**：
- 有依赖关系的任务（A 必须在 B 之前）
- 共享状态的任务
- 需要协调的任务

#### 性能对比

```python
# ❌ 串行 SubAgent（agno）
researcher.run("研究主题1")    # 10s
coder.run("实现功能1")         # 15s
reviewer.run("审查代码1")      # 8s
# 总计：33s

# ✅ 并行 SubAgent（Sakura）
[
    researcher.run("研究主题1"),
    coder.run("实现功能1"),
    reviewer.run("审查代码1")
]  # 并行执行
# 总计：15s（最慢的那个）
```

### 2.5 记忆压缩

智能压缩历史对话，避免上下文溢出。

#### 基本使用

```python
from sakura import FastAgent, OpenAI
from sakura.memory import SmartCompressor

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[search, write],
    memory=SmartCompressor(
        threshold=0.92,         # 92% 上下文时触发
        strategy="structured",  # 结构化摘要
        preserve_last=5         # 保留最后 5 条消息
    )
)

# 长对话不会溢出
for i in range(100):
    result = agent.run(f"任务 {i}")
    # 自动压缩，无需手动管理
```

#### 压缩策略

**1. 结构化摘要（structured）**：

```python
# 原始消息（50 条）
messages = [
    {"role": "user", "content": "任务1..."},
    {"role": "assistant", "content": "结果1..."},
    # ... 很多消息
]

# 压缩后（8 部分结构）
compressed = {
    "intent": "用户的主要意图",
    "concepts": ["关键概念1", "关键概念2"],
    "files": ["操作的文件"],
    "errors": ["遇到的错误"],
    "solving": "解决方案摘要",
    "user_messages": ["重要的用户指令"],
    "tasks": ["待完成任务"],
    "current_work": "当前工作内容"
}
```

**2. 滑动窗口（sliding）**：

```python
# 只保留最近 N 条消息
memory = SmartCompressor(
    threshold=0.92,
    strategy="sliding",
    window_size=20
)
# 超过 20 条时，删除最旧的
```

**3. 重要性采样（importance）**：

```python
# 保留最重要的消息
memory = SmartCompressor(
    threshold=0.92,
    strategy="importance",
    scorer=importance_scorer  # 自定义评分函数
)
# 根据重要性得分保留消息
```

#### 触发机制

```python
class SmartCompressor:
    def should_compress(self, messages, context_window):
        # 计算当前使用率
        token_count = count_tokens(messages)
        usage = token_count / context_window

        # 超过阈值时触发
        return usage > self.threshold  # 例如 0.92

    def compress(self, messages):
        if self.strategy == "structured":
            return structured_summary(messages)
        elif self.strategy == "sliding":
            return messages[-self.window_size:]
        elif self.strategy == "importance":
            return importance_sampling(messages, self.scorer)
```

#### 特性

- ✅ 自动检测上下文使用率
- ✅ 多种压缩策略
- ✅ 保留关键信息
- ✅ 完全透明（LLM 无感知）
- ✅ 可配置触发阈值

---

## Part 3: 性能优化

### 问题分析

**测量结果**：
- 裸 HTTP 调用：0.7s
- agno 框架：1.7s
- **框架开销：1.0s (143%)**

**开销来源**：
1. 消息序列化/反序列化（200-300ms）
2. 工具 schema 生成（100-200ms）
3. 监控/日志系统（100-200ms）
4. 重试/缓存逻辑（50-100ms）
5. 同步/异步转换（50-100ms）

### 快速优化（减少 500ms）

#### 1. 工具 Schema 预编译

```python
class FastAgent(Agent):
    def __init__(self, tools):
        super().__init__(tools)
        # 启动时编译一次，不是每次请求
        self._tool_schemas = [t.to_json_schema() for t in tools]

    def run(self, prompt):
        # 直接使用缓存的 schema
        response = self.model.invoke(
            messages=messages,
            tools=self._tool_schemas  # 预编译的
        )
```

**收益**：-100ms

#### 2. 消息零拷贝

```python
# ❌ 慢：深拷贝
messages = copy.deepcopy(history)
messages.append(new_msg)

# ✅ 快：浅拷贝
messages = [*history, new_msg]
```

**收益**：-50ms

#### 3. 关闭 Pydantic 验证

```python
from pydantic import ConfigDict

class FastMessage(BaseModel):
    model_config = ConfigDict(
        validate_assignment=False  # 关闭运行时验证
    )
```

**收益**：-50ms

#### 4. 移除默认监控

```python
class FastAgent(Agent):
    def __init__(self, monitor=None):  # 可选
        self.monitor = monitor

    def run(self, prompt):
        if self.monitor:  # 只在需要时记录
            self.monitor.log(...)
```

**收益**：-100ms

#### 5. 纯同步路径

```python
# ❌ 慢：在同步函数里调用 asyncio
def run(self, prompt):
    return asyncio.run(self.arun(prompt))

# ✅ 快：真正的同步实现
def run(self, prompt):
    response = self.model.invoke_sync(...)
    return response
```

**收益**：-50ms

### 使用 FastAgent

```python
from sakura import FastAgent

# 生产环境使用
agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[search, read],
    monitor=None  # 关闭监控
)

# 性能：从 1.7s → <1.0s
result = agent.run("task")
```

### Benchmark

```python
from sakura.benchmark import compare_performance

# 对比测试
results = compare_performance(
    agents={
        "agno": AgnoAgent(...),
        "sakura": FastAgent(...)
    },
    n_runs=100
)

# 输出：
# agno:   mean=1700ms, p95=1850ms
# sakura: mean=950ms,  p95=1100ms  (-44%)
```

---

## Part 4: 最佳实践

### 工具设计

#### 好的工具

```python
@tool
def search_web(query: str, max_results: int = 5) -> str:
    """
    搜索网络并返回结果

    Args:
        query: 搜索关键词
        max_results: 最多返回结果数

    Returns:
        格式化的搜索结果
    """
    # 清晰的文档字符串
    # 类型提示
    # 合理的默认值
    results = perform_search(query, max_results)
    return format_results(results)
```

#### 避免

```python
# ❌ 文档不清晰
@tool
def do_stuff(x, y):
    return x + y

# ❌ 过于复杂
@tool
def super_tool(config: Dict[str, Any]) -> Any:
    # 太多参数，LLM 难以使用
    pass
```

### 系统提示词

#### 好的提示词

```python
system_prompt = """
You are a professional Python developer.

When writing code:
1. Follow PEP 8 style guide
2. Add type hints
3. Include docstrings
4. Handle errors gracefully

Always test your code mentally before providing it.
"""
```

#### 避免

```python
# ❌ 太模糊
system_prompt = "You are helpful"

# ❌ 太长太散
system_prompt = """
[5000 words of rambling instructions...]
"""
```

### 工具使用决策

#### 何时使用 Task

✅ **应该使用**：
- 多步骤任务
- 需要跟踪进度
- 复杂工作流

❌ **不必使用**：
- 单步简单任务
- 不需要进度跟踪

#### 何时使用 SubAgent

✅ **应该使用**：
- 需要不同工具集的专门任务
- 需要不同系统提示词的角色
- 需要隔离执行环境

❌ **不必使用**：
- 简单的单步任务
- 不需要专门工具的任务

#### 示例

```python
# ✅ 好：复杂的研究+编码任务
agent.run("""
    1. 深度研究 Python asyncio 最佳实践（用 researcher SubAgent）
    2. 基于研究实现异步爬虫（用 coder SubAgent）
    3. 编写完整文档（用 documenter SubAgent）
""")

# ❌ 不必要：简单任务
agent.run("计算 2+2")  # 不需要 Task 或 SubAgent
```

### 错误处理

```python
from sakura import Agent, AgentError

agent = Agent(...)

try:
    result = agent.run("task")
except AgentError as e:
    print(f"Agent error: {e}")
except Exception as e:
    print(f"Unexpected error: {e}")
```

### 流式响应

```python
import asyncio

async def main():
    agent = Agent(...)

    # 流式输出
    async for chunk in agent.astream("写一个故事"):
        print(chunk.content, end="", flush=True)

        # 可以实时处理每个 chunk
        if "错误" in chunk.content:
            print("\n[检测到错误，停止]")
            break

asyncio.run(main())
```

### 生产环境配置

```python
from sakura import FastAgent

# 生产环境最佳实践
agent = FastAgent(
    model=OpenAI(
        id="gpt-4",
        timeout=60,          # 超时设置
        max_retries=3        # 重试次数
    ),
    tools=[task, subagent, search, read, write],
    system_prompt=load_from_file("prompts/production.txt"),
    memory=SmartCompressor(threshold=0.92),
    monitor=None,            # 关闭监控降低开销
    max_iterations=20,       # 限制循环次数
    parallel_tools=True,     # 启用并行
    parallel_subagents=True  # 启用 SubAgent 并行
)
```

### 调试技巧

```python
# 1. 启用详细日志
import logging
logging.basicConfig(level=logging.DEBUG)

# 2. 检查消息历史
result = agent.run("task")
print("Messages:", agent.last_messages)  # 查看完整对话

# 3. Benchmark 工具
from sakura.benchmark import profile_agent

profile_agent(agent, "test task")
# 输出每个步骤的耗时
```

### 常见陷阱

#### 1. 工具循环

```python
# ❌ 可能无限循环
@tool
def recursive_tool():
    return agent.run("call recursive_tool")  # 危险

# ✅ 设置限制
agent = Agent(..., max_iterations=10)
```

#### 2. 过大的上下文

```python
# ❌ 不管理上下文
for i in range(1000):
    result = agent.run(f"task {i}", messages=messages)
    # messages 会越来越大

# ✅ 使用记忆压缩
agent = FastAgent(
    ...,
    memory=SmartCompressor(threshold=0.92)
)
```

#### 3. 工具太多

```python
# ❌ 100 个工具
agent = Agent(model=..., tools=list_of_100_tools)  # LLM 会困惑

# ✅ 分组或使用 SubAgent
agent = Agent(model=..., tools=[task, subagent, basic_tools])
```

---

## 总结

### 核心架构

```
Sakura = agno（完整保留）+ 性能优化 + 工程化工具
```

### 四个关键部分

1. **agno 基础**：记忆系统、用户画像、工具系统、主循环（完整保留）
2. **工程化工具**：Task、SubAgent、记忆压缩、并行执行（新增）
3. **性能优化**：FastAgent，-70% 框架开销
4. **最佳实践**：工具设计、提示词、错误处理、生产配置

### 学习路径

```
5 分钟   → 理解核心概念（README）
30 分钟  → 创建第一个 Agent（Part 1）
1 小时   → 使用 agno 功能（Part 1.5）
2 小时   → 使用工程化工具（Part 2）
1 天     → 性能优化（Part 3）
持续     → 最佳实践（Part 4）
```

### 下一步

- 查看 [实施路线图](./roadmap.md)
- 创建你的第一个 Agent
- 尝试 Task 和 SubAgent 工具
- 测试性能优化效果

---

**简洁是终极的复杂。** - 达芬奇
