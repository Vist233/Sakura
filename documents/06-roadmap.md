# 开发路线图

本文档提供完整的 8 周开发计划，从性能优化到高级特性实现。

## 目录
- [整体规划](#整体规划)
- [Week 1-2: 性能优化](#week-1-2-性能优化)
- [Week 3-4: Multi-Agent 基础](#week-3-4-multi-agent-基础)
- [Week 5-6: Role 系统](#week-5-6-role-系统)
- [Week 7-8: 自主 Agent](#week-7-8-自主-agent)
- [Week 9+: 生态和文档](#week-9-生态和文档)
- [里程碑](#里程碑)

## 整体规划

### 项目目标

| 目标 | 当前状态 | 目标状态 | 优先级 |
|------|---------|---------|--------|
| 性能优化 | 1.7s (1s 开销) | <1.0s (<0.3s 开销) | P0 |
| Multi-Agent | 无 | Claude Code 风格 | P0 |
| Role 系统 | 无 | 配置化快速定制 | P1 |
| 自主模式 | 无 | 持续执行复杂任务 | P1 |
| 文档和生态 | 基础 | 完整文档 + 工具库 | P2 |

### 关键指标

**性能指标**：
- 框架开销：从 1000ms → <300ms（-70%）
- P95 延迟：从 1850ms → <1100ms
- 工具调用延迟：<50ms（目标）

**功能指标**：
- 支持 5+ 内置角色
- 支持 20+ 内置工具
- Multi-Agent 并发度：10+ agents
- 自主模式最大迭代：100+ steps

## Week 1-2: 性能优化

### 目标
从 1.7s 优化到 <1.0s，框架开销从 1s 降到 <0.3s

### Week 1: 快速优化

#### Day 1-2: 性能分析
- [ ] 搭建 benchmark 框架
  ```python
  # tests/benchmark/test_performance.py
  class PerformanceBenchmark:
      def test_simple_query(self):
          # 测试简单查询性能

      def test_tool_call(self):
          # 测试工具调用性能

      def test_multi_turn(self):
          # 测试多轮对话性能
  ```

- [ ] 使用 profiler 找出瓶颈
  ```bash
  # 运行 profiling
  py-spy record -o profile.svg -- python benchmark.py

  # 分析结果
  python -m cProfile -o output.prof benchmark.py
  python -m pstats output.prof
  ```

- [ ] 记录当前性能基准
  - 平均延迟
  - P50/P95/P99
  - 各模块耗时分布

**交付物**：
- 性能 baseline 报告
- 瓶颈分析报告（Top 10 最慢操作）

#### Day 3-4: 实现快速优化

- [ ] 工具 Schema 预编译
  ```python
  class FastAgent(Agent):
      def __init__(self, tools):
          # 启动时编译，不是运行时
          self._tool_schemas = self._compile_schemas(tools)
  ```

- [ ] 消息零拷贝
  ```python
  def build_messages(history, new_msg):
      # 浅拷贝替代深拷贝
      return [*history, new_msg]
  ```

- [ ] 关闭 Pydantic 验证（生产模式）
  ```python
  class FastMessage(BaseModel):
      model_config = ConfigDict(validate_assignment=False)
  ```

- [ ] 移除默认监控
  ```python
  class Agent:
      def __init__(self, monitor=None):  # 可选
          self.monitor = monitor
  ```

**交付物**：
- 优化后的代码
- 性能对比报告（预期减少 350-500ms）

#### Day 5-7: 架构优化

- [ ] 实现 FastAgent 类
  ```python
  class FastAgent(Agent):
      """生产级高性能 Agent"""
      def __init__(self, model, tools):
          super().__init__(
              model=model,
              tools=tools,
              strict=False,
              monitor=False
          )
          self._precompile_everything()
  ```

- [ ] 提供纯同步路径
  ```python
  def run_sync(self, prompt):
      # 真正的同步实现，不经过 asyncio
  ```

- [ ] 优化消息构建流程
- [ ] 移除不必要的中间层

**交付物**：
- FastAgent 实现
- API 兼容性测试
- 性能测试结果

### Week 2: 深度优化

#### Day 1-3: 底层优化（可选）

- [ ] 评估 msgspec 替换 Pydantic
  ```python
  import msgspec

  class Message(msgspec.Struct):
      role: str
      content: str
  ```

- [ ] 使用 orjson 替换标准 json
  ```python
  import orjson

  def serialize(obj):
      return orjson.dumps(obj)
  ```

- [ ] 工具并行执行优化
  ```python
  # 使用进程池（CPU 密集型）
  executor = ProcessPoolExecutor(max_workers=4)
  ```

**交付物**：
- 底层优化实现
- 性能测试报告

#### Day 4-5: 性能测试和调优

- [ ] 运行完整 benchmark suite
- [ ] 对比不同配置的性能
- [ ] 调优参数（缓存、并发度等）
- [ ] 压力测试（高并发场景）

**交付物**：
- 完整性能测试报告
- 优化建议文档
- 性能调优指南

#### Day 6-7: 文档和示例

- [ ] 更新性能数据到文档
- [ ] 编写性能优化最佳实践
- [ ] 提供 FastAgent 使用示例
- [ ] 性能对比图表

**交付物**：
- 性能优化文档
- 使用示例
- Benchmark 结果可视化

**Week 1-2 里程碑**：
- ✅ 框架开销从 1s 降到 <300ms
- ✅ 平均延迟从 1700ms 降到 <1000ms
- ✅ 提供生产级 FastAgent
- ✅ 完整的性能测试框架

## Week 3-4: Multi-Agent 基础

### 目标
实现 Claude Code 风格的 Multi-Agent 协作系统

### Week 3: 核心架构

#### Day 1-2: AgentOrchestrator

- [ ] 实现 AgentOrchestrator 类
  ```python
  class AgentOrchestrator:
      def spawn_agent(self, role, task, parent_id=None) -> str
      def kill_agent(self, agent_id: str)
      async def wait_for_agent(self, agent_id: str) -> Any
      def send_message(self, from_id, to_id, content)
  ```

- [ ] Agent 注册表
- [ ] 层级关系管理（父子、兄弟）
- [ ] 生命周期管理

**交付物**：
- AgentOrchestrator 实现
- 单元测试

#### Day 3-4: 消息总线

- [ ] 实现 MessageBus 类
  ```python
  class MessageBus:
      def register(self, agent_id, handler)
      async def send(self, from_id, to_id, message)
      async def listen(self, agent_id)
  ```

- [ ] 消息路由
- [ ] 异步消息传递
- [ ] 消息队列管理

**交付物**：
- MessageBus 实现
- 消息传递测试

#### Day 5-7: MultiAgent

- [ ] 实现 MultiAgent 类
  ```python
  class MultiAgent(Agent):
      async def spawn_child(self, role, task, wait=False)
      async def delegate_tasks(self, tasks, mode="parallel")
      def send_to_parent(self, content)
      def send_to_child(self, child_id, content)
  ```

- [ ] 子 Agent 创建和管理
- [ ] 任务委派（并行/串行）
- [ ] 父子通信

**交付物**：
- MultiAgent 实现
- 完整测试覆盖

### Week 4: 高级特性

#### Day 1-2: 任务分解

- [ ] LLM 驱动的任务分解
  ```python
  async def decompose_task(self, task: str) -> List[Dict]
  ```

- [ ] 依赖图构建
  ```python
  def _build_dependency_graph(self, subtasks)
  ```

- [ ] 拓扑排序
  ```python
  def _topological_sort(self, graph) -> List[List[Dict]]
  ```

**交付物**：
- 任务分解实现
- 依赖处理测试

#### Day 3-4: 任务调度

- [ ] 并行调度
- [ ] 顺序调度
- [ ] Pipeline 调度
- [ ] 优先级调度

**交付物**：
- 调度器实现
- 调度策略测试

#### Day 5-6: Multi-Agent 工具

- [ ] spawn_agent_tool
  ```python
  @tool
  def spawn_agent(role: str, task: str, wait: bool = False)
  ```

- [ ] wait_for_agent_tool
- [ ] send_message_tool

**交付物**：
- Multi-Agent 工具集
- 工具测试

#### Day 7: 集成测试

- [ ] 端到端测试场景
  - 简单的 2-agent 协作
  - 复杂的多层级 agent
  - 并行执行多个 agent
  - 动态创建和销毁

**交付物**：
- 集成测试套件
- Demo 示例

**Week 3-4 里程碑**：
- ✅ Multi-Agent 核心架构完成
- ✅ 支持动态创建和层级管理
- ✅ 支持并行和串行调度
- ✅ 完整的测试覆盖

## Week 5-6: Role 系统

### 目标
实现配置化的 Role 系统，快速定制 Agent

### Week 5: 核心实现

#### Day 1-2: Role 定义

- [ ] Role 数据结构
  ```python
  class Role:
      name: str
      description: str
      model: Dict
      system_prompt: str
      tools: List[str]
      thinking_mode: str
      config: RoleConfig
  ```

- [ ] YAML 配置格式
- [ ] 角色继承机制

**交付物**：
- Role 类实现
- 配置格式规范

#### Day 3-4: RoleRegistry

- [ ] 实现 RoleRegistry
  ```python
  class RoleRegistry:
      def register(self, role: Role)
      def get(self, name: str) -> Role
      def list_roles() -> List[str]
  ```

- [ ] 从文件加载角色
- [ ] 角色搜索路径
- [ ] 内置角色加载

**交付物**：
- RoleRegistry 实现
- 角色加载测试

#### Day 5-7: 思考模式

- [ ] 实现 4 种思考模式
  - Fast（快速）
  - Thorough（深思熟虑）
  - Structured（结构化）
  - Creative（创意）

- [ ] 系统提示词调整
  ```python
  def _apply_thinking_mode(system_prompt, mode) -> str
  ```

**交付物**：
- 思考模式实现
- 各模式效果测试

### Week 6: 内置角色和集成

#### Day 1-3: 内置角色

- [ ] Researcher（研究员）
- [ ] Coder（编码员）
- [ ] Tester（测试员）
- [ ] Coordinator（协调员）
- [ ] Planner（规划员）

每个角色包含：
- YAML 配置文件
- 系统提示词
- 工具列表
- 思考模式
- 使用示例

**交付物**：
- 5+ 内置角色
- 角色文档

#### Day 4-5: Agent.from_role()

- [ ] 实现 Agent.from_role()
  ```python
  @classmethod
  def from_role(cls, role_name: str, **overrides) -> Agent
  ```

- [ ] 配置覆盖机制
- [ ] 角色验证
- [ ] 错误处理

**交付物**：
- from_role 实现
- 使用示例

#### Day 6-7: 文档和示例

- [ ] Role 系统文档
- [ ] 创建自定义角色指南
- [ ] 角色继承示例
- [ ] 最佳实践

**交付物**：
- 完整文档
- 示例代码
- 最佳实践指南

**Week 5-6 里程碑**：
- ✅ Role 系统核心完成
- ✅ 5+ 内置角色可用
- ✅ 支持配置化快速定制
- ✅ 完整文档和示例

## Week 7-8: 自主 Agent

### 目标
实现持续执行的自主 Agent 模式

### Week 7: 核心实现

#### Day 1-2: AutonomousAgent 基础

- [ ] AutonomousAgent 类
  ```python
  class AutonomousAgent(Agent):
      async def run_autonomous(self, goal: str) -> Dict
      async def _plan_next_step(self) -> Optional[Dict]
      async def _execute_action(self, action: Dict) -> Dict
      async def _is_goal_achieved(self) -> bool
  ```

- [ ] 状态管理
  ```python
  class AgentState:
      goal: str
      completed_steps: List[Step]
      pending_tasks: List[Task]
      context: Dict
  ```

**交付物**：
- AutonomousAgent 实现
- 状态管理代码

#### Day 3-4: 执行循环

- [ ] 主执行循环
- [ ] 任务队列管理
  ```python
  async def _update_task_queue(self, result: Dict)
  ```

- [ ] 上下文更新
  ```python
  def _update_context(self, result: Dict)
  ```

**交付物**：
- 执行循环实现
- 任务管理逻辑

#### Day 5-7: 停止条件和目标检测

- [ ] 停止条件系统
  ```python
  class StopCondition(Enum):
      GOAL_ACHIEVED = "goal_achieved"
      USER_APPROVAL_NEEDED = "user_approval_needed"
      CRITICAL_ERROR = "critical_error"
      # ...
  ```

- [ ] 目标检测
  ```python
  async def _is_goal_achieved(self) -> bool
  def _should_pause(self, result: Dict) -> Optional[str]
  ```

- [ ] 自定义停止条件支持

**交付物**：
- 停止条件实现
- 目标检测逻辑
- 测试覆盖

### Week 8: 高级特性

#### Day 1-2: 状态持久化

- [ ] 状态保存和加载
  ```python
  def save_state(self, path: str)
  @classmethod
  def load_state(cls, path: str) -> "AutonomousAgent"
  ```

- [ ] 检查点机制
  ```python
  checkpoint_interval: int = 10
  ```

- [ ] 恢复执行
  ```python
  async def resume(self) -> Dict[str, Any]
  ```

**交付物**：
- 持久化实现
- 恢复机制测试

#### Day 3-4: 错误恢复

- [ ] 重试机制
- [ ] 错误处理策略
- [ ] 降级执行

**交付物**：
- 错误恢复实现
- 容错性测试

#### Day 5-6: 优化和性能

- [ ] 减少 LLM 调用
  - 批量规划
  - 决策缓存
- [ ] 并行执行优化
- [ ] 资源使用监控

**交付物**：
- 性能优化实现
- 资源监控工具

#### Day 7: 文档和示例

- [ ] 自主 Agent 文档
- [ ] 使用示例（5+ 场景）
- [ ] 最佳实践指南

**交付物**：
- 完整文档
- 示例代码
- 最佳实践

**Week 7-8 里程碑**：
- ✅ 自主 Agent 核心完成
- ✅ 支持持续执行复杂任务
- ✅ 状态持久化和恢复
- ✅ 完整文档和示例

## Week 9+: 生态和文档

### 目标
完善生态系统、工具库和文档

### Week 9: 工具生态

#### 内置工具扩展

- [ ] 文件操作工具（10+）
  - read_file, write_file, append_file
  - list_directory, create_directory
  - move_file, copy_file, delete_file
  - search_in_file, replace_in_file

- [ ] 代码工具（10+）
  - search_code, read_code
  - analyze_code, lint_code
  - format_code, test_code
  - git_commit, git_push

- [ ] 网络工具（5+）
  - search_web, fetch_url
  - download_file, api_call
  - send_email

- [ ] 数据工具（5+）
  - parse_json, parse_yaml
  - query_database, analyze_data
  - generate_chart

**交付物**：
- 20+ 内置工具
- 工具文档
- 使用示例

### Week 10: 部署方案

- [ ] Docker 镜像
- [ ] Kubernetes 配置
- [ ] Serverless 部署（AWS Lambda/Azure Functions）
- [ ] 环境配置管理

**交付物**：
- 部署文档
- 配置文件
- 部署脚本

### Week 11: 文档完善

- [ ] 完整 API 文档
- [ ] 架构设计文档（已完成）
- [ ] 使用教程（初级/中级/高级）
- [ ] FAQ 和故障排除

**交付物**：
- 完整文档网站
- 中英文文档
- 视频教程（可选）

### Week 12: Benchmark 和案例

- [ ] 性能 Benchmark 报告
  - vs agno
  - vs LangChain
  - vs AutoGen

- [ ] 实际案例（5+）
  - 数据分析项目
  - Web 应用开发
  - 自动化测试
  - 研究报告生成
  - 代码审查

**交付物**：
- Benchmark 报告
- 案例研究文档
- 示例项目代码

## 里程碑

### M1: 性能优化完成（Week 2 末）
- ✅ 框架开销 <300ms
- ✅ FastAgent 可用
- ✅ 性能测试框架

### M2: Multi-Agent 可用（Week 4 末）
- ✅ 动态创建和管理
- ✅ 并行/串行调度
- ✅ 父子通信

### M3: Role 系统可用（Week 6 末）
- ✅ 配置化角色
- ✅ 5+ 内置角色
- ✅ from_role() API

### M4: 自主模式可用（Week 8 末）
- ✅ 持续执行
- ✅ 状态管理
- ✅ 错误恢复

### M5: 生态完善（Week 12 末）
- ✅ 20+ 工具
- ✅ 完整文档
- ✅ 部署方案

## 优先级矩阵

| 功能 | 优先级 | 价值 | 难度 | 时间 |
|------|--------|------|------|------|
| 性能优化 | P0 | 高 | 中 | 2周 |
| Multi-Agent | P0 | 高 | 高 | 2周 |
| Role 系统 | P1 | 高 | 低 | 2周 |
| 自主模式 | P1 | 高 | 高 | 2周 |
| 工具生态 | P2 | 中 | 低 | 1周 |
| 文档 | P2 | 中 | 低 | 3周 |
| 部署 | P2 | 低 | 中 | 1周 |

## 风险和缓解

### 风险 1：性能优化达不到目标
**缓解**：
- 提前做充分的 profiling
- 分阶段优化，每阶段验证
- 如果某个优化效果不佳，快速切换方案

### 风险 2：Multi-Agent 复杂度过高
**缓解**：
- 从简单场景开始（2-agent）
- 逐步增加复杂度
- 充分的单元测试和集成测试

### 风险 3：自主模式不稳定
**缓解**：
- 设置合理的停止条件
- 提供状态持久化和恢复
- 详细的日志和调试工具

### 风险 4：时间不够
**缓解**：
- 优先完成 P0 功能
- P1 和 P2 功能可以延后
- 使用敏捷开发，每周回顾和调整

## 每周检查清单

### 每周开始
- [ ] 回顾上周目标完成情况
- [ ] 制定本周详细计划
- [ ] 确认优先级

### 每周结束
- [ ] 运行所有测试
- [ ] 更新文档
- [ ] 性能 benchmark
- [ ] 代码审查
- [ ] 准备 demo（如果有里程碑）

## 成功标准

### 技术指标
- ✅ 框架开销 <300ms（-70%）
- ✅ 支持 10+ 并发 Agents
- ✅ 自主模式最大迭代 100+ steps
- ✅ 测试覆盖率 >80%
- ✅ 文档完整度 >90%

### 用户体验
- ✅ Agent 创建：1 行代码
  ```python
  agent = Agent.from_role("researcher")
  ```
- ✅ Multi-Agent：直观的 API
  ```python
  await agent.spawn_child("coder", "write code")
  ```
- ✅ 自主模式：简单启动
  ```python
  await agent.run_autonomous("build a project")
  ```

### 生态系统
- ✅ 20+ 内置工具
- ✅ 5+ 内置角色
- ✅ 完整文档和示例
- ✅ 部署方案

## 下一步行动

### 立即开始（Day 1）

1. **搭建开发环境**
   ```bash
   git clone https://github.com/yourusername/sakura.git
   cd sakura
   pip install -e ".[dev]"
   ```

2. **创建项目结构**
   ```
   sakura/
   ├── sakura/          # 主代码
   ├── tests/           # 测试
   │   ├── unit/
   │   ├── integration/
   │   └── benchmark/
   ├── documents/       # 文档（已创建）
   ├── examples/        # 示例
   └── roles/           # 内置角色
   ```

3. **运行第一个 profiler**
   ```bash
   py-spy record -o profile.svg -- python benchmark.py
   ```

4. **开始第一个优化**
   - 实现工具 schema 预编译
   - 运行 benchmark 验证效果

### 本周目标（Week 1）
- [ ] 完成性能基准测试
- [ ] 实现 3+ 快速优化
- [ ] 减少 300ms 开销
- [ ] 周末：回顾和调整计划

## 持续改进

- **每日**：代码审查、单元测试
- **每周**：性能测试、集成测试
- **每月**：用户反馈、功能调整
- **每季度**：架构审查、重构

---

**记住**：
1. 先做 profiling，再优化
2. 每次优化都要有数据支撑
3. 保持代码简洁和可维护性
4. 文档和代码同步更新
5. 持续测试和验证

准备好了吗？让我们开始吧！🚀
