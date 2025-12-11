# Sakura 实施路线图

6 周开发计划：保留 agno 功能，性能优化，工程化工具。

## 总览

```
Week 1-2: agno 保留 + 性能优化（-70% 框架开销）
Week 3-4: 工程化工具（Task、SubAgent、并行、压缩）
Week 5-6: 完善和测试
```

## Week 1-2: agno 保留 + 性能优化

**目标**：
1. 验证 agno 核心功能完整保留
2. 识别并去除性能瓶颈组件
3. 框架开销从 1s 降到 <0.3s

### Week 1: agno 保留 + 快速优化

#### Day 1: agno 功能验证
- [ ] 验证记忆系统完整保留
  - ConversationMemory API 测试
  - max_messages 功能测试
  - summarize_threshold 功能测试
- [ ] 验证用户画像完整保留
  - UserProfile API 测试
  - 个性化响应测试
  - 多用户支持测试
- [ ] 验证工具系统完整保留
  - @tool 装饰器测试
  - 主循环测试
  - 多轮对话测试

**交付物**：
- agno 功能兼容性测试报告
- 功能保留清单

#### Day 2-3: 性能瓶颈分析
- [ ] 搭建 benchmark 框架
- [ ] 使用 py-spy 分析瓶颈
- [ ] 识别可去除的组件
  - 默认监控系统（-100ms）
  - Pydantic 运行时验证（-50ms）
  - 深拷贝消息（-50ms）
  - 同步/异步自动转换（-50ms）
- [ ] 记录当前性能基准

```bash
# 安装工具
pip install py-spy

# 运行 profiling
py-spy record -o profile.svg -- python benchmark.py

# 分析结果
python -m cProfile -o output.prof benchmark.py
```

**交付物**：
- 性能分析报告
- 可优化组件清单

#### Day 4-6: 实现快速优化
- [ ] 工具 schema 预编译（-100ms）
- [ ] 消息零拷贝（-50ms）
- [ ] 关闭 Pydantic 运行时验证（-50ms）
- [ ] 移除默认监控（-100ms）
- [ ] 纯同步路径（-50ms）

```python
class FastAgent(Agent):
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
        ...
```

**交付物**：
- FastAgent 实现
- 性能优化代码

#### Day 7: 测试验证
- [ ] 运行完整 benchmark
- [ ] 对比优化前后
- [ ] 确认减少 350-500ms
- [ ] 验证 agno 功能未受影响

**Week 1 里程碑**：
- ✅ agno 功能完整保留
- ✅ 框架开销 <800ms
- ✅ 识别所有优化点

### Week 2: 深度优化

#### Day 1-2: FastAgent 完善
- [ ] Agent（标准模式，保留监控）
- [ ] FastAgent（性能模式，关闭监控）
- [ ] API 兼容性测试
- [ ] 确保 agno 用户可无缝迁移

#### Day 3-4: 深度优化
- [ ] 并发工具执行基础实现
- [ ] 消息构建优化
- [ ] 内存使用优化
- [ ] 启动时间优化

#### Day 5-6: 性能测试
- [ ] 与 agno 完整对比测试
- [ ] 长对话性能测试
- [ ] 高并发性能测试
- [ ] 边界情况测试

#### Day 7: 文档
- [ ] 性能优化文档
- [ ] 从 agno 迁移指南
- [ ] FastAgent 使用指南
- [ ] 性能测试报告

**Week 1-2 里程碑**：
- ✅ agno 核心功能 100% 保留
- ✅ 框架开销 <300ms（-70%）
- ✅ FastAgent 可用
- ✅ 完整迁移文档

## Week 3-4: 工程化工具

**目标**：实现 Task、SubAgent、并行、压缩

### Week 3: Task + SubAgent

#### Day 1-2: Task Tool（TODO 管理）
- [ ] Task tool 设计
  - 参数定义（description, status, action）
  - 状态管理（pending/in_progress/completed）
  - 任务持久化
- [ ] Task tool 实现

```python
@tool
def task(
    description: str,
    status: str = "pending",
    action: str = "add"
) -> str:
    """管理任务列表"""
    if action == "add":
        tasks.append(Task(description=description, status=status))
    elif action == "update":
        task = find_task(description)
        task.status = status
    elif action == "list":
        return format_tasks(tasks)
    return format_tasks(tasks)
```

- [ ] 单元测试

**交付物**：
- Task tool 实现
- 单元测试

#### Day 3-4: SubAgent Tool（子 Agent）
- [ ] SubAgent tool 设计
  - 参数定义（prompt, config, description）
  - 递归 Agent 创建
  - 结果返回
- [ ] SubAgent tool 实现

```python
@tool
def subagent(
    prompt: str,
    config: str = "general-purpose",
    description: str = ""
) -> str:
    """创建子 Agent 执行任务"""
    # 加载配置
    config_obj = load_subagent_config(f"subagents/{config}.md")

    # 创建新的 Agent 实例
    sub = Agent(
        model=resolve_model(config_obj.model),
        tools=[get_tool(t) for t in config_obj.tools],
        system_prompt=config_obj.role
    )

    # 递归调用
    result = sub.run(prompt)
    return result.content
```

- [ ] 单元测试

**交付物**：
- SubAgent tool 实现
- 单元测试

#### Day 5: SubAgent Markdown 配置
- [ ] Markdown 解析器
  - YAML frontmatter 解析
  - Markdown body 提取
  - SubAgentConfig 类

```python
class SubAgentConfig:
    @classmethod
    def load(cls, path: str):
        content = Path(path).read_text()
        parts = content.split("---", 2)

        frontmatter = yaml.safe_load(parts[1])
        body = parts[2].strip()

        return cls(
            name=frontmatter["name"],
            tools=frontmatter["tools"].split(", "),
            role=body
        )
```

- [ ] 内置 SubAgent 配置
  - general-purpose.md
  - researcher.md
  - coder.md
  - reviewer.md

**交付物**：
- Markdown 解析器
- 4 个内置 SubAgent

#### Day 6: 多工具并行执行
- [ ] 检测并行工具调用
- [ ] asyncio.gather 实现
- [ ] 错误隔离
- [ ] 性能测试

```python
async def execute_parallel(tool_calls):
    tasks = [
        execute_tool(call.name, call.args)
        for call in tool_calls
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return results
```

**交付物**：
- 并行执行实现
- 性能对比测试

#### Day 7: SubAgent 并行执行
- [ ] 检测并行 SubAgent 调用
- [ ] 并行创建和执行
- [ ] 结果聚合
- [ ] 性能测试

```python
async def execute_subagents_parallel(calls):
    subagents = []
    for call in calls:
        config = load_config(call.args["config"])
        sub = Agent(
            model=resolve_model(config.model),
            tools=[get_tool(t) for t in config.tools],
            system_prompt=config.role
        )
        subagents.append(sub)

    results = await asyncio.gather(*[
        sub.arun(call.args["prompt"])
        for sub, call in zip(subagents, calls)
    ])
    return results
```

**交付物**：
- SubAgent 并行实现
- 性能对比测试

**Week 3 里程碑**：
- ✅ Task tool 可用
- ✅ SubAgent tool 可用
- ✅ 并行执行可用
- ✅ 4+ 内置 SubAgent

### Week 4: 记忆压缩 + 集成测试

#### Day 1-2: 记忆压缩
- [ ] SmartCompressor 设计
  - threshold 检测
  - 多种压缩策略（structured, sliding, importance）
  - 触发机制
- [ ] 结构化摘要实现

```python
class SmartCompressor:
    def __init__(
        self,
        threshold: float = 0.92,
        strategy: str = "structured",
        preserve_last: int = 5
    ):
        self.threshold = threshold
        self.strategy = strategy
        self.preserve_last = preserve_last

    def should_compress(self, messages, context_window):
        token_count = count_tokens(messages)
        usage = token_count / context_window
        return usage > self.threshold

    def compress(self, messages):
        if self.strategy == "structured":
            return structured_summary(messages)
        elif self.strategy == "sliding":
            return messages[-self.window_size:]
        elif self.strategy == "importance":
            return importance_sampling(messages, self.scorer)
```

- [ ] 滑动窗口实现
- [ ] 重要性采样实现

**交付物**：
- SmartCompressor 实现
- 3 种压缩策略
- 单元测试

#### Day 3-4: 端到端测试
- [ ] 简单任务测试（不需要工具）
- [ ] Task tool 测试
- [ ] SubAgent tool 测试
- [ ] 并行执行测试
- [ ] 记忆压缩测试
- [ ] 组合使用测试

**测试场景**：
```python
# 场景 1：复杂工作流
agent.run("""
    1. 研究 Python asyncio（用 researcher SubAgent）
    2. 实现异步爬虫（用 coder SubAgent）
    3. 审查代码（用 reviewer SubAgent）
    4. 生成文档（用 documenter SubAgent）
""")

# 场景 2：并行分析
agent.run("用三个专家分析这个架构问题")

# 场景 3：长对话
for i in range(100):
    agent.run(f"任务 {i}")
```

**交付物**：
- 完整测试套件
- 测试报告

#### Day 5-6: 性能测试
- [ ] Task tool 性能测试
- [ ] SubAgent 创建开销测试
- [ ] 并行执行性能测试
- [ ] 记忆压缩性能测试
- [ ] 完整配置性能测试

**性能目标**：
- Task tool 开销 <10ms
- SubAgent 创建 <100ms
- 并行执行至少节省 50%
- 记忆压缩 <50ms

**交付物**：
- 性能测试报告
- 优化建议

#### Day 7: 文档
- [ ] Task tool 使用指南
- [ ] SubAgent tool 使用指南
- [ ] SubAgent markdown 配置格式
- [ ] 并行执行指南
- [ ] 记忆压缩指南
- [ ] 最佳实践

**Week 3-4 里程碑**：
- ✅ 所有工程化工具可用
- ✅ 4+ 内置 SubAgent
- ✅ 并行执行稳定
- ✅ 记忆压缩可用
- ✅ 完整文档

## Week 5-6: 完善和测试

### Week 5: 功能完善

#### Day 1-2: 高级特性
- [ ] SubAgent 超时控制
- [ ] 错误恢复机制
- [ ] 自定义压缩策略
- [ ] 工具并发控制

#### Day 3-4: 工具生态
- [ ] 内置工具（10+）
  - read_file, write_file
  - search_web, fetch_url
  - bash, python_exec
  - git_commit, git_push
  - calculate, convert
  - summarize, translate

#### Day 5-7: 示例和案例
- [ ] 研究+报告生成
  - 使用 researcher SubAgent
  - 使用 Task tool 跟踪进度
  - 使用记忆压缩处理长文档
- [ ] 代码审查工作流
  - 使用 coder SubAgent 实现
  - 使用 reviewer SubAgent 审查
  - 使用 Task tool 管理任务
- [ ] 自动化测试
  - 使用 SubAgent 并行执行测试
  - 使用 Task tool 跟踪测试进度
- [ ] 文档生成
  - 使用 documenter SubAgent
  - 使用多工具并行收集信息
- [ ] Claude Code 风格工作流
  - 组合使用所有工具
  - 演示完整能力

**交付物**：
- 10+ 内置工具
- 5+ 完整示例
- 示例文档

### Week 6: 测试和发布

#### Day 1-3: 完整测试
- [ ] 单元测试（>80% 覆盖）
  - Agent 核心测试
  - agno 功能保留测试
  - 工具系统测试
  - 性能优化测试
  - 工程化工具测试
- [ ] 集成测试
  - 端到端场景测试
  - 错误恢复测试
  - 边界情况测试
- [ ] 性能回归测试
  - 确保 <300ms 框架开销
  - 确保 agno 功能未退化
- [ ] 压力测试
  - 高并发测试
  - 长时间运行测试
  - 内存泄漏测试

**交付物**：
- 完整测试套件
- 测试覆盖率报告
- 性能回归报告

#### Day 4-5: 文档完善
- [ ] README.md（已完成）
- [ ] guide.md（已完成）
- [ ] roadmap.md（已完成）
- [ ] API 文档
  - Agent API
  - FastAgent API
  - Tools API
  - Memory API
  - SubAgent API
- [ ] 故障排除
  - 常见错误
  - 调试技巧
  - 性能调优
- [ ] FAQ
  - 与 agno 的区别
  - 迁移指南
  - 最佳实践

**交付物**：
- 完整 API 文档
- 故障排除指南
- FAQ 文档

#### Day 6-7: 发布准备
- [ ] 版本号确定（v1.0.0）
- [ ] CHANGELOG 编写
  - 核心功能：agno 完整保留
  - 性能优化：-70% 框架开销
  - 新增工具：Task、SubAgent、并行、压缩
- [ ] PyPI 打包
  - setup.py 配置
  - 依赖管理
  - 打包测试
- [ ] GitHub Release
  - Release notes
  - 示例代码
  - 迁移指南

**Week 5-6 里程碑**：
- ✅ 功能完整
- ✅ 测试覆盖 >80%
- ✅ 文档完整
- ✅ 准备发布

## 检查清单

### 功能检查
- [ ] agno 核心功能保留
  - [ ] 记忆系统
  - [ ] 用户画像
  - [ ] 工具系统
  - [ ] 主循环
- [ ] 性能优化
  - [ ] FastAgent
  - [ ] Schema 预编译
  - [ ] Zero-copy 消息
  - [ ] 可选监控
- [ ] 工程化工具
  - [ ] Task tool
  - [ ] SubAgent tool
  - [ ] 多工具并行
  - [ ] SubAgent 并行
  - [ ] 记忆压缩
- [ ] 内置 SubAgent (4+)
- [ ] 内置工具 (10+)
- [ ] 流式响应
- [ ] 错误处理

### 性能检查
- [ ] 框架开销 <300ms
- [ ] agno 功能无性能退化
- [ ] Task tool 开销 <10ms
- [ ] SubAgent 创建 <100ms
- [ ] 并行执行至少节省 50%
- [ ] 记忆压缩 <50ms
- [ ] Benchmark 通过

### 测试检查
- [ ] 单元测试 >80%
- [ ] 集成测试完整
- [ ] 性能回归测试
- [ ] agno 兼容性测试
- [ ] 示例可运行

### 文档检查
- [ ] README.md ✅
- [ ] guide.md ✅
- [ ] roadmap.md ✅
- [ ] API 文档
- [ ] 迁移指南
- [ ] 示例代码
- [ ] FAQ

## 优先级

### P0（必须）
- agno 功能保留验证
- 性能优化
- Task 和 SubAgent 工具
- 核心文档

### P1（应该）
- 并行执行
- 记忆压缩
- 内置工具
- 示例案例
- 完整测试

### P2（可选）
- 高级特性
- 额外优化

## 风险和缓解

### 风险 1：agno 功能兼容性
**缓解**：
- Week 1 Day 1 优先验证
- 建立完整测试套件
- 持续回归测试

### 风险 2：性能目标未达成
**缓解**：
- 提前 profiling
- 分阶段验证
- 备选方案

### 风险 3：工具复杂度
**缓解**：
- 从简单开始
- 充分测试
- 清晰文档

### 风险 4：时间不足
**缓解**：
- 优先 P0 功能
- P1/P2 可延后
- 每周回顾调整

## 成功标准

### 技术指标
- ✅ agno 功能 100% 保留
- ✅ 框架开销 <300ms（-70%）
- ✅ 测试覆盖 >80%
- ✅ 4+ 内置 SubAgent
- ✅ 10+ 内置工具

### 用户体验
- ✅ 5 分钟上手
- ✅ 30 分钟掌握
- ✅ API 简洁直观
- ✅ 文档清晰完整
- ✅ 从 agno 无缝迁移

## 下一步

### 立即开始（Day 1）

1. **验证 agno 功能**
```bash
git clone https://github.com/yourusername/sakura.git
cd sakura
pip install -e ".[dev]"

# 运行 agno 兼容性测试
pytest tests/test_agno_compat.py
```

2. **运行 profiler**
```bash
py-spy record -o profile.svg -- python benchmark.py
```

3. **实现第一个优化**
- Schema 预编译
- 验证效果
- 确保 agno 功能未受影响

### 本周目标
- [ ] 完成 agno 功能验证
- [ ] 完成性能分析
- [ ] 实现 3+ 快速优化
- [ ] 减少 300ms 开销

---

**记住**：Sakura = agno 的生产优化版本。保留所有核心能力，提升性能，添加工程化工具。
