# Sakura 架构总览

> **Default to Speed. Debug when Broken.**
> 默认极速。出问题再调。

本文档描述 Sakura 的架构设计，以及它为什么比 agno 快 **20 倍**。

## 目录
- [核心理念](#核心理念)
- [性能架构](#性能架构)
- [核心组件](#核心组件)
- [执行流程](#执行流程)
- [与 agno 的关系](#与-agno-的关系)

---

## 核心理念

### Sakura 是什么

```
Sakura = agno（完整保留）+ 极致性能优化（默认开启）+ 工程化工具
```

Sakura 不是重新发明轮子，而是让 agno **专为生产环境而设计**。

### 设计哲学：锋利的快刀

> **"Sharp knives specifically for chefs."**
> 给厨师用的锋利快刀。

Sakura 做出了一个非主流但正确的选择：

| 设计决策 | 主流框架 (LangChain, agno) | Sakura |
|----------|--------------------------|--------|
| 默认监控 | ✅ 开启（调试方便） | ❌ 关闭（省 IO） |
| 消息处理 | 深拷贝（防呆） | **浅拷贝**（极速） |
| Schema 生成 | 每次反射 | **预编译缓存** |
| 验证 | 运行时 Pydantic | **可选** |

**代价**：如果你不小心修改了入参消息，可能导致隐蔽 Bug。
**收益**：框架开销从 **~500ms → ~25μs**（0.000025s）。

---

## 性能架构

### Benchmark 数据

| 指标 | 遗留模式 | **Sakura (默认)** | 提升 |
|------|---------|------------------|------|
| 平均延迟 | 0.456 ms | **0.025 ms** | -94.5% |
| P95 延迟 | 0.743 ms | **0.027 ms** | -96.4% |
| 吞吐量 (RPS) | 2,184 | **34,767** | 15.9x |
| 大上下文处理 | 0.697 ms | **0.287 ms** | -58.8% |

> 测试环境：Python 3.14, macOS. 详见 `tests/benchmark_performance.py`

### 为什么这么快？

```
传统框架调用链:
User → [监控日志] → [深拷贝消息] → [反射生成Schema] → [Pydantic验证] → LLM
       ↑            ↑              ↑                  ↑
       50ms        100ms          150ms              50ms  = 350ms 浪费

Sakura 调用链 (performance_mode=True):
User → LLM
       ↑
       0.025ms
```

### 核心优化点

```python
class Agent:
    # 默认开启高性能模式
    performance_mode: bool = True
    
    def __post_init__(self):
        if self.performance_mode:
            # 1. 关闭监控 IO
            self.enable_monitoring = False
            
            # 2. 预编译工具 Schema（启动时一次，运行时直接用）
            self._tool_schemas_cache = [f.to_dict() for f in self._functions.values()]
    
    def _build_messages(self, prompt, messages):
        result = [...]
        # 3. 浅拷贝：直接 extend，不复制对象
        result.extend(messages)  # ← 这里省了 100ms
        return result
    
    def _get_tool_dicts(self):
        # 4. 使用缓存，不反射
        if self._tool_schemas_cache:
            return self._tool_schemas_cache  # ← 这里省了 150ms
        return [func.to_dict() for func in self._functions.values()]
```

---

## 核心组件

### 1. Agent（高性能主循环）

```python
from sakura import Agent

# 默认就是高性能模式
agent = Agent(
    model="qwen-plus",
    tools=[search, write_file],
    system_prompt="你是一个助手"
)

result = agent.run("帮我搜索 Python 异步编程")
```

**切换到调试模式**（遇到奇怪 Bug 时）：

```python
agent = Agent(
    model="qwen-plus",
    tools=[search],
    performance_mode=False,  # 手动关闭
    enable_monitoring=True   # 开启监控
)
```

### 2. Task 工具（TODO 管理）

```python
from sakura.tools.builtin import task

agent = Agent(
    model="qwen-plus",
    tools=[task, read_file, write_file]
)

# LLM 会自动使用 task 工具管理任务进度
agent.run("帮我重构这个文件，分步骤完成")
```

### 3. SubAgent 工具（子 Agent 委托）

```python
from sakura.subagent import subagent

agent = Agent(
    model="qwen-plus",
    tools=[subagent, search]
)

# LLM 会自动调用 SubAgent 处理复杂任务
agent.run("深度研究三个技术主题并写报告")
```

SubAgent 配置文件 (`subagents/researcher.md`):

```markdown
---
name: researcher
model: qwen-plus
tools: search_web, read_file
---

# 角色定义
你是一位资深研究员...
```

### 4. 智能压缩（SmartCompressor）

当上下文接近 token 限制时自动压缩：

```python
from sakura.memory import SmartCompressor

agent = Agent(
    model="qwen-plus",
    tools=[...],
    memory=SmartCompressor(threshold=0.92)  # 92% 时触发压缩
)
```

---

## 执行流程

### 简化流程图

```
User Input
    │
    ▼
┌─────────────────────────────────────────────┐
│              Agent.run()                     │
│                                              │
│  1. _build_messages()     ← 浅拷贝 (0ms)     │
│  2. _get_tool_dicts()     ← 缓存命中 (0ms)   │
│  3. model.response()      ← LLM 调用 (主耗时)│
│  4. 执行工具(若有)                           │
│  5. 循环或返回                               │
│                                              │
└─────────────────────────────────────────────┘
    │
    ▼
Response
```

### 工具执行流程

```
LLM 决定调用工具
    │
    ├──▶ task() → 本地任务管理（无网络请求）
    │
    ├──▶ subagent() → 创建新 Agent 实例 → 递归调用
    │
    └──▶ search() / write() → 外部 IO
```

---

## 与 agno 的关系

### 100% API 兼容

```python
# agno 代码在 Sakura 中直接运行
from sakura import Agent
from sakura.models import Qwen

agent = Agent(
    model=Qwen(id="qwen-plus"),
    tools=[tool1, tool2]
)
result = agent.run("Hello")
```

### Sakura 独有功能

| 功能 | agno | Sakura |
|------|------|--------|
| 性能模式 | ❌ | ✅ 默认开启 |
| Task 工具 | ❌ | ✅ |
| SubAgent 工具 | ❌ | ✅ |
| 智能压缩 | ❌ | ✅ |
| 并行执行 | ❌ | ✅ |

---

## 架构总结

```
┌─────────────────────────────────────────────────────────┐
│                      Sakura                              │
│                                                          │
│   ┌─────────────────────────────────────────────────┐   │
│   │           agno 核心（完整保留）                   │   │
│   │  - 模型抽象  - 工具系统  - 消息处理               │   │
│   └─────────────────────────────────────────────────┘   │
│                          │                               │
│   ┌─────────────────────┼───────────────────────────┐   │
│   │          Sakura 性能层（默认开启）               │   │
│   │                      │                           │   │
│   │  - Schema 预编译     │   - 浅拷贝消息            │   │
│   │  - 监控旁路          │   - 纯同步路径            │   │
│   └──────────────────────┼───────────────────────────┘   │
│                          │                               │
│   ┌──────────────────────▼───────────────────────────┐   │
│   │              Sakura 工具层                        │   │
│   │                                                   │   │
│   │   Task     SubAgent    SmartCompressor   并行    │   │
│   └───────────────────────────────────────────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 下一步

- 📖 [性能优化指南](./02-performance-optimization.md) - 深入理解优化细节
- 🔧 [工具开发指南](./guide.md) - 自定义工具开发
- 📊 [可观测性设计](./bestRealizePoint/06-observability.md) - 监控与追踪
