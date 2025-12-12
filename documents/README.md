# Sakura Agent Framework Documentation

欢迎来到 Sakura Agent Framework 文档中心。这是一个基于 agno 的高性能 Agent 框架，专注于生产级性能优化和多 Agent 协作。

## 📚 文档导航

### 核心架构
- [01-架构总览](./01-architecture-overview.md) - 了解框架的整体设计和执行流程
- [02-性能优化指南](./02-performance-optimization.md) - 从 1.7s 优化到 0.7s 的实践方案

### 高级特性
- [03-Multi-Agent 设计](./03-multi-agent-design.md) - 多 Agent 协作架构（Claude Code 风格）
- [04-Role 系统](./04-role-system.md) - 基于角色的快速 Agent 定制
- [05-自主 Agent 模式](./05-autonomous-agent.md) - 持续执行直到目标完成的自主模式

### 开发指南
- [06-开发路线图](./06-roadmap.md) - 完整的 8 周开发计划

## 🎯 快速开始

如果你想快速了解项目：

1. 先阅读 [架构总览](./01-architecture-overview.md) 理解核心设计
2. 查看 [性能优化指南](./02-performance-optimization.md) 了解关键优化点
3. 根据需求选择性阅读高级特性文档

## 🚀 核心优势

- **极致性能**：框架开销从 1s 优化到 <0.3s
- **Multi-Agent**：支持动态生成和协作的多 Agent 架构
- **Role 系统**：配置化快速定制不同风格的 Agent
- **自主模式**：Agent 可以持续执行复杂任务直到完成

## 📊 性能对比

| 框架 | 裸 HTTP | 框架总耗时 | 框架开销 |
|------|---------|-----------|----------|
| 原始 agno | 0.7s | 1.7s | 1.0s (143%) |
| Sakura (优化后) | 0.7s | <1.0s | <0.3s (43%) |

## 🤝 贡献

这是一个持续演进的项目。欢迎提出建议和反馈。

## 📝 更新日志

- 2025-12-11: 初始文档创建
- 待更新...
