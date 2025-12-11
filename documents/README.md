# Sakura Agent Framework Documentation

欢迎来到 Sakura Agent Framework 文档中心。这是一个基于 agno 的高性能 Agent 框架，融合 **agno 的快轻特性** 和 **Claude Code 的全面专业能力**。

## 📚 文档导航

### 🚀 核心架构（agno 基础）
- [01-架构总览](./01-architecture-overview.md) - 了解框架的整体设计和执行流程
- [02-性能优化指南](./02-performance-optimization.md) - 从 1.7s 优化到 <1.0s 的实践方案

### 🔥 高级特性（agno 扩展）
- [03-Multi-Agent 设计](./03-multi-agent-design.md) - 多 Agent 协作架构
- [04-Role 系统](./04-role-system.md) - 基于角色的快速 Agent 定制
- [05-自主 Agent 模式](./05-autonomous-agent.md) - 持续执行直到目标完成的自主模式

### ⭐ 专业增强（Claude Code 模式）
- [07-Claude-Code 专业增强](./07-claude-code-enhancements.md) - SubAgent markdown 配置、智能压缩、高级特性

### 📋 开发指南
- [06-开发路线图](./06-roadmap.md) - 完整的开发计划

## 🎯 快速开始

### 基础使用（agno 模式）

```python
from sakura import Agent, OpenAI

# 创建基础 Agent
agent = Agent(
    model=OpenAI(id="gpt-4"),
    tools=[search, read_file, write_file]
)

# 运行
result = agent.run("帮我搜索并总结 Python 异步编程")
```

### 专业使用（Claude Code 增强）

```python
from sakura import Agent
from sakura.enhancements import enable_claude_code_mode

# 启用 Claude Code 专业特性
agent = Agent.from_subagent(
    "researcher",  # 使用 markdown 配置
    enable_compression=True,  # 92% 智能压缩
    enable_streaming=True     # h2A 流式响应
)

# 运行
result = agent.run("深度研究并生成完整报告")
```

## 🏗️ 框架理念

### agno：快轻基础 ⚡

**核心优势**：
- ✅ 快速上手，API 简洁
- ✅ 轻量级，性能优先
- ✅ 功能齐全，开箱即用
- ✅ 灵活扩展

**适用场景**：
- 快速原型开发
- 简单任务自动化
- 轻量级应用

### Claude Code：全面专业 🎯

**核心增强**：
- ✅ SubAgent markdown 配置（更专业的定义）
- ✅ 智能压缩 92%（更好的内存管理）
- ✅ h2A 异步队列（零延迟流式响应）
- ✅ 6 层权限验证（企业级安全）
- ✅ 细粒度执行控制

**适用场景**：
- 生产环境部署
- 复杂业务逻辑
- 高性能要求
- 企业级应用

## 📊 性能对比

| 指标 | agno 基础 | Sakura (优化后) | Claude Code 增强 |
|------|-----------|----------------|-----------------|
| 框架开销 | 1.0s | <0.3s | <0.2s |
| 首字节延迟 | 1.2s | 0.8s | <0.5s (h2A) |
| 内存使用 | 基准 | -30% | -50% (智能压缩) |
| 并发能力 | 5 tools | 10 tools | 10 tools + 优先级 |

## 🎁 核心优势

### 1. 渐进式增强 🎢

```
Level 1: agno 基础（快速开发）
  ↓
Level 2: 性能优化（生产就绪）
  ↓
Level 3: Claude Code 增强（企业级）
```

### 2. 灵活选择 🔧

```python
# 方式 1: 纯 agno（轻量快速）
agent = Agent(model=..., tools=...)

# 方式 2: agno + 性能优化
from sakura import FastAgent
agent = FastAgent(model=..., tools=...)

# 方式 3: Claude Code 专业模式
agent = Agent.from_subagent("researcher",
    enable_claude_code=True
)
```

### 3. 最佳实践融合 🌟

- agno 的简洁 API
- Claude Code 的专业特性
- 社区最佳实践
- 生产级性能优化

## 🗂️ 文档组织

### Part I: 核心基础（必读）
**目标**：理解框架核心，快速上手

1. **架构总览** - 5 层架构，执行流程
2. **性能优化** - 从 1.7s 到 <1.0s

### Part II: 高级特性（按需）
**目标**：解锁高级能力

3. **Multi-Agent** - 复杂任务协作
4. **Role 系统** - 快速定制 Agent
5. **自主模式** - 持续执行复杂目标

### Part III: 专业增强（进阶）
**目标**：企业级能力

7. **Claude Code 增强** - 全面专业特性
   - SubAgent markdown 配置
   - 智能压缩 92%
   - h2A 异步队列
   - 高级安全机制

### Part IV: 实施指南
6. **开发路线图** - 分阶段实施

## 💡 使用建议

### 场景 1：快速原型
```python
# 使用 agno 基础，快速上手
agent = Agent(model=GPT4(), tools=[search, read])
result = agent.run("task")
```

### 场景 2：生产应用
```python
# 启用性能优化
agent = FastAgent(
    model=GPT4(),
    tools=[search, read],
    enable_monitoring=False  # 关闭监控降低开销
)
```

### 场景 3：企业级
```python
# 完整 Claude Code 增强
agent = Agent.from_subagent("professional-researcher",
    enable_compression=True,      # 智能压缩
    enable_streaming=True,        # 流式响应
    enable_security_layers=True,  # 6 层安全
    parallel_tasks=3              # 并行任务
)
```

## 🚀 快速决策树

```
需要快速开发? → 使用 agno 基础（Part I）
    ↓ 满足需求? YES → 完成 ✓
    ↓ NO
需要更好的性能? → 应用性能优化（Part I.2）
    ↓ 满足需求? YES → 完成 ✓
    ↓ NO
需要复杂协作? → 使用 Multi-Agent（Part II.3）
    ↓ 满足需求? YES → 完成 ✓
    ↓ NO
需要企业级能力? → 启用 Claude Code 增强（Part III.7）
    ↓
完成 ✓
```

## 📝 更新日志

- 2025-12-11: 初始文档创建
- 2025-12-11: 整合 Claude Code 专业增强
- 架构定位：agno 快轻基础 + Claude Code 全面专业

## 🤝 贡献

这是一个持续演进的项目。欢迎提出建议和反馈。

---

**设计理念**：先快后稳，渐进增强。用 agno 快速开发，用 Claude Code 打磨专业。
