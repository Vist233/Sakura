# Sakura 架构总览

本文档描述 Sakura 的真实架构设计。

## 目录
- [核心理念](#核心理念)
- [架构组成](#架构组成)
- [核心组件](#核心组件)
- [执行流程](#执行流程)
- [与 agno 的关系](#与-agno-的关系)

## 核心理念

### Sakura 是什么

```
Sakura = agno（完整保留）+ 性能优化 + 工程化工具
```

Sakura 不是重新发明轮子，而是让 agno 更快、更适合生产环境。

**三个核心原则**：
1. **完全兼容 agno**：所有 agno 功能保留（记忆、用户画像、工具系统）
2. **极致性能**：框架开销从 1s 降到 <0.3s（-70%）
3. **工程化工具**：添加生产级工具（Task、SubAgent、并行、压缩）

### 设计原则

```python
# 这是真实的架构
class Agent:
    def run(self, prompt):
        # 主循环
        while True:
            response = self.model.invoke(messages, tools)

            if response.tool_calls:
                # 执行工具（包括 Task、SubAgent 等）
                results = self.execute_tools(response.tool_calls)
                messages.append(results)
            else:
                break

        return response

# Task 工具 = TODO 管理
@tool
def task(description: str, status: str = "pending") -> str:
    """管理任务列表（类似 Claude Code 的 TodoWrite）"""
    # 添加、更新、列出任务
    # 与 SubAgent 无关
    ...

# SubAgent 工具 = 创建子 Agent
@tool
def subagent(prompt: str, config: str) -> str:
    """创建子 Agent 执行任务"""
    # 加载 SubAgent 配置
    config_obj = load_subagent_config(f"subagents/{config}.md")

    # 创建新的 Agent 实例（隔离执行）
    sub = Agent(
        model=config_obj.model,
        tools=config_obj.tools,
        system_prompt=config_obj.role
    )

    # 递归调用
    result = sub.run(prompt)
    return result.content
```

**重要**：Task 和 SubAgent 是完全独立的工具，没有关系。

## 架构组成

### 整体架构图

```
┌──────────────────────────────────────────────────────┐
│                    User Input                         │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│              Agent Main Loop                          │
│                                                       │
│  1. 构建消息 (build_messages)                         │
│  2. 调用 LLM (model.invoke)                           │
│  3. 解析响应 (parse_response)                         │
│  4. 执行工具 (execute_tools)                          │
│  5. 更新消息 (update_messages)                        │
│  6. 循环或返回                                        │
│                                                       │
└────────────────────┬─────────────────────────────────┘
                     │
          ┌──────────┴───────────────────┐
          │                              │
          ▼                              ▼
   ┌──────────────┐              ┌──────────────────┐
   │  Task 工具    │              │  SubAgent 工具    │
   │              │              │                  │
   │ - 添加任务    │              │ - 加载配置        │
   │ - 更新状态    │              │ - 创建 Agent     │
   │ - 列出任务    │              │ - 递归调用       │
   │              │              │ - 返回结果       │
   └──────────────┘              └────────┬─────────┘
                                          │
                                 ┌────────▼──────────┐
                                 │    SubAgent       │
                                 │ (新 Agent 实例)    │
                                 │                   │
                                 │ - 独立消息历史     │
                                 │ - 独立工具集       │
                                 │ - 独立系统提示词   │
                                 │ - markdown 配置    │
                                 └───────────────────┘
```

### agno 保留功能

**完整保留**：
- ✅ 记忆系统（ConversationMemory）
- ✅ 用户画像（UserProfile）
- ✅ 工具系统（@tool 装饰器）
- ✅ 主循环（Agent.run()）
- ✅ 多模型支持（Provider 抽象）

**性能优化**：
- ⚡ 去除默认监控（改为可选）
- ⚡ 去除 Pydantic 运行时验证
- ⚡ 浅拷贝替代深拷贝
- ⚡ 纯同步路径

**新增工具**：
- 🔧 Task tool（TODO 管理）
- 🔧 SubAgent tool（子 Agent）
- 🔧 SmartCompressor（记忆压缩）
- 🔧 并行执行（工具和 SubAgent）

## 核心组件

### 1. Agent（主循环）

```python
class Agent:
    """单一主循环 Agent"""

    def __init__(self, model, tools, system_prompt):
        self.model = model
        self.tools = tools
        self.system_prompt = system_prompt
        self._functions = {t.name: t for t in tools}

    def run(self, prompt: str, messages: List[Message] = None):
        """主执行循环"""
        messages = messages or []

        # 添加系统提示
        messages.insert(0, Message(role="system", content=self.system_prompt))

        # 添加用户输入
        messages.append(Message(role="user", content=prompt))

        # 主循环
        while True:
            # 调用 LLM
            response = self.model.invoke(
                messages=messages,
                tools=[t.to_schema() for t in self.tools]
            )

            # 添加 assistant 消息
            messages.append(Message(
                role="assistant",
                content=response.content,
                tool_calls=response.tool_calls
            ))

            # 如果没有工具调用，结束
            if not response.tool_calls:
                break

            # 执行工具
            for tool_call in response.tool_calls:
                result = self._execute_tool(tool_call)
                messages.append(Message(
                    role="tool",
                    tool_call_id=tool_call.id,
                    content=result
                ))

        return response

    def _execute_tool(self, tool_call):
        """执行单个工具"""
        tool = self._functions[tool_call.name]
        return tool.execute(**tool_call.arguments)
```

### 2. FastAgent（性能优化版）

```python
class FastAgent(Agent):
    """高性能 Agent"""

    def __init__(self, tools, monitor=None):
        super().__init__(tools)
        # 预编译 schema
        self._tool_schemas = [t.to_json_schema() for t in tools]
        # 监控可选
        self.monitor = monitor

    def run(self, prompt):
        # 使用预编译的 schema
        # 浅拷贝消息
        # 纯同步实现
        # 可选监控
        ...
```

### 3. Task 工具（TODO 管理）

```python
@tool
def task(
    description: str,
    status: str = "pending",
    action: str = "add"
) -> str:
    """
    管理任务列表（类似 Claude Code 的 TodoWrite）

    Args:
        description: 任务描述
        status: pending/in_progress/completed
        action: add/update/list

    Returns:
        当前任务列表状态
    """
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

### 4. SubAgent 工具（子 Agent 创建）

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
        config: SubAgent 配置文件名（不含 .md 后缀）
        description: 简短描述

    Returns:
        子 Agent 的执行结果
    """
    # 加载 SubAgent 配置
    config_obj = load_subagent_config(f"subagents/{config}.md")

    # 创建新的 Agent 实例（隔离执行）
    sub = Agent(
        model=resolve_model(config_obj.model),
        tools=[get_tool(t) for t in config_obj.tools],
        system_prompt=config_obj.role
    )

    # 递归调用（这是关键）
    result = sub.run(prompt)

    return result.content
```

### 5. SubAgent 配置（markdown 文件）

```markdown
---
name: researcher
description: 专业的研究人员
tools: search_web, read_file, summarize
model: gpt-4
---

# ROLE
You are a professional researcher...

# OBJECTIVES
1. Conduct thorough research
2. Synthesize information
3. Provide structured summaries

# WORK PRINCIPLES
- Use search_web to find information
- Read and analyze sources
- Summarize findings clearly

# OUTPUT FORMAT
## Summary
[主要发现]

## Sources
- [来源1]
- [来源2]
```

### 6. 智能压缩（SmartCompressor）

```python
class SmartCompressor:
    """上下文智能压缩"""

    COMPRESSION_THRESHOLD = 0.92  # 92% token 使用率触发

    def compress_if_needed(
        self,
        messages: List[Message],
        max_tokens: int
    ) -> Tuple[List[Message], bool]:
        """检查并压缩上下文"""

        # 计算 token 使用率
        current_tokens = count_tokens(messages)
        usage_ratio = current_tokens / max_tokens

        # 低于阈值，不压缩
        if usage_ratio < self.COMPRESSION_THRESHOLD:
            return messages, False

        # 执行压缩
        compressed = self._compress(messages)
        return compressed, True

    def _compress(self, messages: List[Message]) -> List[Message]:
        """压缩消息历史"""
        # 结构化摘要
        summary = self._structured_summary(messages)

        # 返回压缩后的消息
        return [
            messages[0],  # 系统提示
            Message(role="system", content=f"[压缩的历史]\n{summary}"),
            *messages[-5:]  # 最近 5 条消息
        ]
```

## 执行流程

### 完整流程示例

```
User: "请研究 Python 异步编程"
    ↓
Agent.run(prompt)
    ↓
[构建消息]
messages = [
    {role: "system", content: "You are helpful"},
    {role: "user", content: "请研究 Python 异步编程"}
]
    ↓
[调用 LLM]
response = model.invoke(messages, tools=[task, subagent, search, ...])
    ↓
[LLM 决定使用工具]
response.tool_calls = [
    {name: "task", arguments: {description: "研究 asyncio", action: "add"}},
    {name: "subagent", arguments: {prompt: "研究 asyncio", config: "researcher"}}
]
    ↓
[执行 Task 工具]
task() → 添加任务到列表
    ↓
[执行 SubAgent 工具]
subagent() 函数被调用
    ↓
[加载 SubAgent 配置]
config = load_subagent_config("subagents/researcher.md")
  → tools: [search_web, read_file, summarize]
  → role: "You are a professional researcher..."
    ↓
[创建 SubAgent（新 Agent 实例）]
sub_agent = Agent(
    model=GPT4(),
    tools=[search_web, read_file, summarize],
    system_prompt=config.role
)
    ↓
[SubAgent 执行（递归调用）]
sub_result = sub_agent.run("研究 asyncio")
  → SubAgent 自己的主循环
  → 可能调用 search_web, read_file 等
  → 返回研究结果
    ↓
[返回结果给主 Agent]
messages.append({
    role: "tool",
    content: sub_result.content
})
    ↓
[主 Agent 继续循环]
再次调用 LLM，整合结果
    ↓
[更新 Task 状态]
task(description="研究 asyncio", status="completed", action="update")
    ↓
[最终响应]
return "基于研究结果，Python asyncio..."
```

### 关键点

1. **单一主循环**：只有一个 `Agent.run()` 在执行
2. **独立工具**：Task 和 SubAgent 是独立的工具，互不依赖
3. **递归调用**：SubAgent 工具创建新的 `Agent` 实例并调用 `run()`
4. **隔离执行**：SubAgent 有独立的消息历史和工具集
5. **结果传递**：所有工具的结果作为工具结果返回给主 Agent

## 与 agno 的关系

### 保持兼容

Sakura 基于 agno，保持 API 兼容：

```python
# agno 的代码仍然可用
from sakura import Agent, OpenAI

agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[tool1, tool2]
)

result = agent.run("Hello")
```

### 新增功能

```python
# 新增：FastAgent（性能优化）
from sakura import FastAgent

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[tool1, tool2]
)
result = agent.run("Hello")  # -70% 框架开销

# 新增：Task 工具（TODO 管理）
from sakura.tools import task

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[task, read_file, write_file]
)

# LLM 可以使用 task 管理任务
result = agent.run("研究并实现一个功能")

# 新增：SubAgent 工具（子 Agent）
from sakura.tools import subagent

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[subagent, search, write]
)

# LLM 可以创建 SubAgent
result = agent.run("深度研究三个技术主题")

# 新增：记忆压缩
from sakura.memory import SmartCompressor

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[...],
    memory=SmartCompressor(threshold=0.92)
)
```

## 性能优化点

基于 agno 的实现，关键优化点：

1. **工具 schema 预编译**（启动时生成一次，-100ms）
2. **消息零拷贝**（浅拷贝替代深拷贝，-50ms）
3. **可选监控**（关闭默认监控，-100ms）
4. **纯同步路径**（避免 asyncio 开销，-50ms）
5. **Pydantic 优化**（关闭运行时验证，-50ms）

详见 [性能优化指南](./02-performance-optimization.md)

## 总结

### Sakura 的真实架构

```
agno（完整保留）
    +
性能优化（-70% 开销）
    +
Task 工具（TODO 管理）
    +
SubAgent 工具（子 Agent）
    +
SmartCompressor（记忆压缩）
    +
并行执行（工具和 SubAgent）
```

### 核心价值

1. **100% 兼容 agno**：所有功能保留
2. **极致性能**：框架开销 <300ms
3. **工程化工具**：生产级功能
4. **简洁设计**：易于理解和维护

## 下一步

- 查看 [完整使用指南](./guide.md) 了解详细用法
- 查看 [性能优化指南](./02-performance-optimization.md) 了解优化细节
- 查看 [实施路线图](./roadmap.md) 了解开发计划
