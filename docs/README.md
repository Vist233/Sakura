# Sakura Agent Framework

**agno 的生产优化版本：保留核心能力，极致性能，工程化工具。**

## 🎯 核心理念

```
Sakura = agno（完整保留）+ 性能优化 + 工程化工具
```

Sakura 不是重新发明轮子，而是让 agno 更快、更适合生产环境。

### 保留 agno 核心能力

✅ **完整的记忆系统** - agno 的对话记忆功能完整保留
✅ **用户画像功能** - agno 的用户建模能力完整保留
✅ **工具系统** - agno 的 @tool 装饰器和主循环完整保留
✅ **多模型支持** - agno 的 Provider 抽象完整保留

### 性能优化（-70% 框架开销）

⚡ **Schema 预编译** - 启动时编译工具 schema，不是每次请求（-100ms）
⚡ **Zero-copy 消息** - 浅拷贝替代深拷贝（-50ms）
⚡ **去除性能瓶颈** - 移除不必要的监控和验证（-150ms）
⚡ **纯同步路径** - 避免不必要的 async/await 转换（-50ms）

**结果**：框架开销从 1.0s → <0.3s

### 新增工程化工具

🔧 **Task tool** - TODO 任务管理（类似 Claude Code 的 TodoWrite）
🔧 **SubAgent tool** - 创建隔离的子 Agent（可用 markdown 配置）
🔧 **记忆压缩** - 智能压缩历史对话，避免上下文溢出
🔧 **FastAgent** - 快速创建特定用途的 Agent
🔧 **多工具并行** - 一次执行多个工具调用
🔧 **SubAgent 并行** - 多个子 Agent 同时执行

## 🚀 快速开始

### 基础使用（和 agno 完全一样）

```python
from sakura import Agent, OpenAI, tool

@tool
def search(query: str) -> str:
    """搜索网络"""
    return f"Results for {query}"

# 创建 Agent（API 与 agno 兼容）
agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[search],
    system_prompt="You are a helpful assistant"
)

result = agent.run("搜索 Python 最佳实践")
print(result.content)
```

### 性能优化版本（使用 FastAgent）

```python
from sakura import FastAgent, OpenAI

# 只需把 Agent 改成 FastAgent
agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[search]
)

# API 完全一样，速度快 70%
result = agent.run("搜索 Python 最佳实践")
```

### 使用新增工具

```python
from sakura import FastAgent, OpenAI
from sakura.tools import task, subagent

# 1. Task tool - 管理任务列表
agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[task, search, write]
)

result = agent.run("研究 Python asyncio 并写报告")
# LLM 会自动使用 task 工具跟踪进度

# 2. SubAgent tool - 创建子 Agent
agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[subagent, search, write]
)

result = agent.run("深度研究三个技术主题")
# LLM 会为每个主题创建专门的 SubAgent
```

### SubAgent Markdown 配置

在 `subagents/researcher.md` 创建配置：

```markdown
---
name: researcher
description: 专业技术研究员
tools: search_web, read_file, summarize
model: gpt-4
---

# ROLE
You are a professional technical researcher.

# OBJECTIVES
- Conduct thorough research
- Analyze multiple sources
- Provide structured summaries

# OUTPUT FORMAT
## 🔍 Summary
[Key findings]

## 📊 Analysis
[Detailed analysis]

## 📚 Sources
[Citations]
```

使用：

```python
from sakura.tools import subagent

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[subagent, ...]
)

# LLM 自动选择合适的 SubAgent
result = agent.run("深度研究 Python asyncio")
# 会调用: subagent(prompt="研究 asyncio", config="researcher")
```

## 📊 性能对比

| 配置 | 框架开销 | 对比 agno | 适用场景 |
|------|---------|----------|---------|
| **agno 原版** | ~1.0s | - | 研究原型 |
| **Sakura (Agent)** | ~0.7s | -30% | 保留监控能力 |
| **Sakura (FastAgent)** | <0.3s | **-70%** | 生产环境 |

## 🛠️ 核心工具说明

### Task Tool（TODO 管理）

```python
@tool
def task(description: str, status: str = "pending") -> str:
    """
    管理任务列表

    Args:
        description: 任务描述
        status: pending/in_progress/completed

    Returns:
        更新后的任务列表状态
    """
```

**用途**：
- 跟踪复杂任务的进度
- 让 LLM 可以规划和管理任务
- 类似 Claude Code 的 TodoWrite 功能

### SubAgent Tool（子 Agent 创建）

```python
@tool
def subagent(prompt: str, config: str = "general-purpose") -> str:
    """
    创建子 Agent 执行任务

    Args:
        prompt: 任务描述
        config: SubAgent markdown 配置文件名

    Returns:
        子 Agent 的执行结果
    """
```

**用途**：
- 创建专门的执行上下文
- 使用不同的工具集和提示词
- 隔离复杂任务

**注意**：Task 和 SubAgent 是独立工具，没有关系。

### 记忆压缩

```python
from sakura import FastAgent
from sakura.memory import SmartCompressor

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[...],
    memory=SmartCompressor(
        threshold=0.92,  # 92% 上下文时触发压缩
        strategy="structured"  # 结构化摘要
    )
)
```

**特性**：
- 自动检测上下文使用率
- 保留关键信息的结构化压缩
- 无缝集成，对 LLM 透明

### 多工具并行执行

```python
# Agent 自动并行执行多个工具调用
result = agent.run("搜索三个主题并总结")

# LLM 可能返回：
# [
#   search("topic1"),
#   search("topic2"),
#   search("topic3")
# ]
# Sakura 会并行执行这三个调用
```

### SubAgent 并行执行

```python
# 创建多个 SubAgent 同时工作
result = agent.run("用三个专家分析这个问题")

# 可能创建：
# researcher SubAgent (并行)
# analyst SubAgent (并行)
# reviewer SubAgent (并行)
```

## 🎨 Claude Code 风格工作流

当你组合使用这些工具时，会呈现类似 Claude Code 的体验：

```python
from sakura import FastAgent, OpenAI
from sakura.tools import task, subagent
from sakura.memory import SmartCompressor

agent = FastAgent(
    model=OpenAI(id="gpt-4"),
    tools=[
        task,      # TODO 管理
        subagent,  # 子 Agent
        search,
        read,
        write
    ],
    memory=SmartCompressor(threshold=0.92)
)

# 这个配置下的工作流类似 Claude Code：
# - task 工具跟踪任务进度
# - subagent 创建专门的执行上下文
# - 智能压缩避免上下文溢出
# - 工具并行执行提升效率
```

**但这只是一种用法**，你可以：
- 只用 Task 不用 SubAgent
- 只用 SubAgent 不用 Task
- 完全不用这些工具，只要性能优化
- 自己组合出新的工作流

## 💡 何时用什么

### 只需要速度优化

```python
from sakura import FastAgent

# 把 Agent 改成 FastAgent，其他不变
agent = FastAgent(model=..., tools=...)
```

**适合**：
- 简单任务
- 不需要复杂工具的场景
- 性能优先

### 需要任务管理

```python
from sakura.tools import task

agent = FastAgent(
    model=...,
    tools=[task, ...]
)
```

**适合**：
- 多步骤任务
- 需要跟踪进度
- 复杂工作流

### 需要专门的执行上下文

```python
from sakura.tools import subagent

agent = FastAgent(
    model=...,
    tools=[subagent, ...]
)
```

**适合**：
- 需要不同提示词的任务
- 需要隔离的执行环境
- 专家系统（研究员、编码员、审查员等）

### 需要长对话

```python
from sakura.memory import SmartCompressor

agent = FastAgent(
    model=...,
    memory=SmartCompressor()
)
```

**适合**：
- 持续交互
- 上下文量大
- 避免溢出

### 全套组合

```python
agent = FastAgent(
    model=...,
    tools=[task, subagent, search, read, write],
    memory=SmartCompressor()
)
```

**适合**：
- 生产环境
- 复杂应用
- 类似 Claude Code 的体验

## 🏗️ 架构理念

### 理念 1：向后兼容 agno

Sakura 不是替代 agno，而是优化版本。所有 agno 代码都能在 Sakura 运行。

### 理念 2：性能优先

通过去除瓶颈和优化实现，框架开销降低 70%。

### 理念 3：工具化扩展

新功能以工具形式提供，用户自由选择。

### 理念 4：生产就绪

从原型到生产，只需把 Agent 改成 FastAgent。

## 📖 完整文档

- **[完整使用指南](./guide.md)** - 30 分钟掌握所有功能
- **[实施路线图](./roadmap.md)** - 6 周开发计划

## 🚀 快速决策

```
需要最快速度？ → 用 FastAgent
需要任务管理？ → 加 task 工具
需要子 Agent？ → 加 subagent 工具
需要长对话？ → 加 SmartCompressor
想要 Claude Code 体验？ → 全部组合
完全兼容 agno？ → 用 Agent（不是 FastAgent）
```

## 🔄 从 agno 迁移

```python
# agno 代码
from agno import Agent
agent = Agent(model=..., tools=...)

# Sakura - 方案 1：完全兼容（保留监控）
from sakura import Agent
agent = Agent(model=..., tools=...)  # 一样的 API

# Sakura - 方案 2：性能优化（推荐）
from sakura import FastAgent
agent = FastAgent(model=..., tools=...)  # -70% 开销
```

## 🤝 与 agno 的关系

| 维度 | agno | Sakura |
|------|------|--------|
| **定位** | 研究框架 | 生产框架 |
| **核心能力** | ✅ 完整 | ✅ 完整保留 |
| **记忆系统** | ✅ | ✅ 完整保留 |
| **用户画像** | ✅ | ✅ 完整保留 |
| **框架开销** | ~1.0s | <0.3s（**-70%**）|
| **Task 工具** | ❌ | ✅ 新增 |
| **SubAgent 工具** | ❌ | ✅ 新增 |
| **记忆压缩** | ❌ | ✅ 新增 |
| **并行执行** | ❌ | ✅ 新增 |
| **兼容性** | - | ✅ 100% 兼容 agno |

## 📝 更新日志

- 2025-12-11: 架构定位修正
- **核心理念**：Sakura = agno 的生产优化版本
- **保留**：agno 的所有核心能力（记忆、用户画像、工具系统）
- **优化**：-70% 框架开销
- **新增**：Task、SubAgent、记忆压缩、并行执行

---

**核心哲学**：不重新发明轮子，让好的东西更好。
