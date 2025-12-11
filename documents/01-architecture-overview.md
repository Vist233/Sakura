# 架构总览（基于 Claude Code 真实实现）

本文档基于对 Claude Code v1.0.33 的逆向分析，描述 Sakura 的真实架构设计。

## 目录
- [核心理念](#核心理念)
- [真实架构](#真实架构)
- [核心组件](#核心组件)
- [执行流程](#执行流程)
- [与 agno 的关系](#与-agno-的关系)

## 核心理念

### Claude Code 的真实架构

经过对 Claude Code 源码的深度分析，我们发现它**不是**传统的 multi-agent 系统，而是：

```
单一主循环 + Task 工具递归 + 流式响应
```

**关键发现**：
1. **只有一个主 Agent 循环**（nO 函数）
2. **"SubAgent" 是通过 Task 工具递归调用主循环创建的**
3. **SubAgent = 隔离的执行上下文**（不是独立的 autonomous agent）
4. **使用 h2A 异步队列实现流式响应**
5. **92% token 使用率触发智能压缩**

### Sakura 的设计原则

Sakura 对齐 Claude Code 的真实实现：

```python
# 这是真实的架构
class Agent:
    def run(self, prompt):
        # 主循环
        while True:
            response = self.model.invoke(messages, tools)

            if response.tool_calls:
                # 执行工具（包括 Task 工具）
                results = self.execute_tools(response.tool_calls)
                messages.append(results)
            else:
                break

        return response

# Task 工具 = 递归调用
@tool
def task(prompt: str, subagent_config: str):
    """创建 SubAgent 执行任务"""
    # 加载 SubAgent 配置
    config = load_subagent_config(subagent_config)

    # 创建新的 Agent 实例（隔离执行）
    sub_agent = Agent(
        model=config.model,
        tools=config.tools,
        system_prompt=config.role
    )

    # 递归调用
    result = sub_agent.run(prompt)
    return result
```

**不是**这样的编造架构：
```python
# ❌ 这些都是编造的，不存在
class AgentOrchestrator:  # 不存在
    def spawn_agent(self): pass

class MessageBus:  # 不存在
    def send_message(self): pass

class MultiAgent(Agent):  # 不存在
    def delegate_tasks(self): pass

class AutonomousAgent(Agent):  # 不存在
    def run_autonomous(self): pass
```

## 真实架构

### 整体架构图

```
┌──────────────────────────────────────────────────────┐
│                    User Input                         │
└────────────────────┬─────────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────────┐
│              Agent Main Loop (nO)                     │
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
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
   ┌──────────────┐      ┌──────────────────┐
   │  普通工具     │      │   Task 工具       │
   │              │      │                  │
   │ - read_file  │      │ - 加载配置        │
   │ - write_file │      │ - 创建 SubAgent  │
   │ - bash       │      │ - 递归调用       │
   │ - search     │      │ - 返回结果       │
   └──────────────┘      └────────┬─────────┘
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

### Claude Code 对应关系

| Sakura 组件 | Claude Code 对应 | 说明 |
|------------|-----------------|------|
| `Agent.run()` | `nO()` 函数 | 主循环 |
| `Task` 工具 | `I2A()` 函数 | 创建 SubAgent |
| `h2A` 队列 | `h2A` 类 | 异步消息队列 |
| `wU2` 压缩 | `wU2()` 函数 | 智能上下文压缩 |
| SubAgent 配置 | markdown 文件 | SubAgent 定义 |

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

### 2. Task 工具（SubAgent 创建）

```python
@tool
def task(
    prompt: str,
    subagent: str = "general-purpose",
    description: str = ""
) -> str:
    """
    创建 SubAgent 执行任务

    Args:
        prompt: 任务描述
        subagent: SubAgent 配置文件名（不含 .md 后缀）
        description: 简短描述

    Returns:
        SubAgent 的执行结果
    """
    # 加载 SubAgent 配置
    config = load_subagent_config(f"subagents/{subagent}.md")

    # 创建新的 Agent 实例（隔离执行）
    sub_agent = Agent(
        model=Model.from_string(config.model or "inherit"),
        tools=[get_tool(t) for t in config.tools],
        system_prompt=config.role
    )

    # 递归调用（这就是 "SubAgent" 的本质）
    result = sub_agent.run(prompt)

    return result.content
```

### 3. SubAgent 配置（markdown 文件）

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

### 4. 智能压缩（wU2）

```python
class ContextCompressor:
    """上下文智能压缩（对应 Claude Code 的 wU2）"""

    COMPRESSION_THRESHOLD = 0.92  # 92% token 使用率触发

    async def compress_if_needed(
        self,
        messages: List[Message],
        max_tokens: int
    ) -> Tuple[List[Message], bool]:
        """检查并压缩上下文"""

        # 计算 token 使用率
        current_tokens = self.count_tokens(messages)
        usage_ratio = current_tokens / max_tokens

        # 低于阈值，不压缩
        if usage_ratio < self.COMPRESSION_THRESHOLD:
            return messages, False

        # 执行压缩
        compressed = await self._compress(messages)
        return compressed, True

    async def _compress(self, messages: List[Message]) -> List[Message]:
        """压缩消息历史"""
        # 构造压缩提示
        prompt = f"""
        请压缩以下对话历史，保留关键信息：

        {self._format_messages(messages)}

        输出结构化摘要，包含：
        1. 主要任务和意图
        2. 关键技术概念
        3. 重要文件和代码
        4. 错误和修复
        5. 待办任务
        """

        # 调用 LLM 压缩
        summary = await self.model.ainvoke(prompt)

        # 返回压缩后的消息（保留系统提示 + 摘要 + 最近几条）
        return [
            messages[0],  # 系统提示
            Message(role="system", content=f"[压缩的历史]\n{summary}"),
            *messages[-5:]  # 最近 5 条消息
        ]
```

### 5. 流式响应（h2A 队列）

```python
class AsyncMessageQueue:
    """异步消息队列（对应 Claude Code 的 h2A）"""

    def __init__(self):
        self.queue = []
        self.read_resolve = None
        self.is_done = False

    async def next(self):
        """读取下一条消息"""
        # 队列有数据，立即返回
        if self.queue:
            return {"done": False, "value": self.queue.pop(0)}

        # 已结束
        if self.is_done:
            return {"done": True, "value": None}

        # 等待新消息
        return await self._wait_for_message()

    async def _wait_for_message(self):
        """等待新消息（Promise-based）"""
        future = asyncio.Future()
        self.read_resolve = future
        return await future

    def enqueue(self, message):
        """入队消息（零延迟传递）"""
        # 策略1：直接传递给等待的读取者（零延迟）
        if self.read_resolve:
            self.read_resolve.set_result({"done": False, "value": message})
            self.read_resolve = None
            return

        # 策略2：缓冲（读取者不在等待）
        self.queue.append(message)
```

## 执行流程

### 完整流程图

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
response = model.invoke(messages, tools=[task, read_file, ...])
    ↓
[LLM 决定调用 Task 工具]
response.tool_calls = [{
    name: "task",
    arguments: {
        prompt: "深入研究 Python asyncio",
        subagent: "researcher"
    }
}]
    ↓
[执行 Task 工具]
task() 函数被调用
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
sub_result = sub_agent.run("深入研究 Python asyncio")
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
再次调用 LLM，整合 SubAgent 的结果
    ↓
[最终响应]
return "基于研究结果，Python asyncio..."
```

### 关键点

1. **单一主循环**：只有一个 `Agent.run()` 在执行
2. **递归调用**：Task 工具创建新的 `Agent` 实例并调用 `run()`
3. **隔离执行**：SubAgent 有独立的消息历史和工具集
4. **结果传递**：SubAgent 的结果作为工具结果返回给主 Agent

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
# 新增：Task 工具（SubAgent）
from sakura.tools import task

agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[task, read_file, write_file]  # 包含 task 工具
)

# LLM 可以自己决定使用 task 创建 SubAgent
result = agent.run("请研究并实现一个功能")

# 新增：从 SubAgent 配置创建
from sakura import Agent

agent = Agent.from_subagent("researcher")  # 加载 subagents/researcher.md
result = agent.run("研究 Python asyncio")
```

## 性能优化点

基于 Claude Code 的实现，关键优化点：

1. **工具 schema 预编译**（启动时生成一次）
2. **消息零拷贝**（避免深拷贝）
3. **智能压缩**（92% 阈值触发）
4. **流式响应**（h2A 异步队列）
5. **并发工具执行**（最多 10 个并发）

详见 [性能优化指南](./02-performance-optimization.md)

## 总结

### Sakura 的真实架构

```
单一主循环 Agent
    +
Task 工具（递归创建 SubAgent）
    +
markdown 配置文件
    +
智能压缩（92% 阈值）
    +
流式响应（异步队列）
```

### 不是什么

- ❌ 不是多个自主 agent 协作
- ❌ 不是复杂的 orchestrator
- ❌ 不是 message bus 通信
- ❌ 不是 autonomous agent 模式

### 核心价值

1. **对齐真实实现**：基于 Claude Code 逆向分析
2. **简洁设计**：单主循环 + 递归，易于理解和维护
3. **高性能**：优化框架开销到 <300ms
4. **可扩展**：通过 markdown 配置文件扩展 SubAgent

## 下一步

- 查看 [SubAgent 系统](./03-subagent-system.md) 了解如何配置 SubAgent
- 查看 [性能优化指南](./02-performance-optimization.md) 了解优化细节
- 查看 [开发路线图](./04-roadmap.md) 了解实施计划
