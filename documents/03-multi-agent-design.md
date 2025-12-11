# Multi-Agent 架构设计

本文档详细说明如何实现 Claude Code 风格的多 Agent 协作系统。

## 目录
- [设计理念](#设计理念)
- [核心架构](#核心架构)
- [Agent 通信](#agent-通信)
- [任务分解与调度](#任务分解与调度)
- [实现细节](#实现细节)
- [使用示例](#使用示例)

## 设计理念

### Claude Code 的 Multi-Agent 模式

Claude Code 采用的是**动态生成、层级协作**的 Agent 架构：

```
Coordinator Agent (协调者)
    ├─ Researcher Agent (研究员) - 并行执行
    ├─ Coder Agent (编码员) - 并行执行
    └─ Tester Agent (测试员) - 顺序执行
```

**核心特点**：
1. **动态生成**：Agent 根据需要动态创建和销毁
2. **层级结构**：父 Agent 可以创建子 Agent
3. **并行执行**：独立任务的 Agent 并行运行
4. **结果聚合**：父 Agent 收集子 Agent 的结果
5. **自主决策**：每个 Agent 独立思考和行动

### 与传统 Multi-Agent 的区别

| 特性 | 传统方式 (AutoGen/CrewAI) | Sakura 方式 (Claude Code 风格) |
|------|--------------------------|-------------------------------|
| Agent 创建 | 预定义所有 Agent | 动态创建，按需生成 |
| 通信方式 | 消息传递/共享内存 | 父子关系 + 消息总线 |
| 协作模式 | 固定流程/状态机 | 自主决策 + 动态调度 |
| 并发控制 | 手动管理 | 自动并行/串行 |
| 适用场景 | 固定工作流 | 开放式复杂任务 |

## 核心架构

### 整体架构图

```
┌─────────────────────────────────────────────────┐
│            AgentOrchestrator                     │
│  - 全局 Agent 注册表                             │
│  - 消息总线                                       │
│  - 任务调度器                                     │
└────────────┬────────────────────────────────────┘
             │
             ├─────────────┬─────────────┬─────────
             ▼             ▼             ▼
        ┌────────┐    ┌────────┐    ┌────────┐
        │Agent 1 │    │Agent 2 │    │Agent 3 │
        │(Parent)│    │(Child) │    │(Child) │
        └────┬───┘    └────────┘    └────────┘
             │
             ├─────────────┬─────────────
             ▼             ▼
        ┌────────┐    ┌────────┐
        │Agent 4 │    │Agent 5 │
        │(Child) │    │(Child) │
        └────────┘    └────────┘
```

### 核心组件

#### 1. AgentOrchestrator（编排器）

**职责**：
- Agent 生命周期管理（创建、注册、销毁）
- 消息路由和分发
- 任务调度和并发控制
- 结果收集和聚合

```python
class AgentOrchestrator:
    """多 Agent 协调器"""

    def __init__(self):
        self.agents: Dict[str, Agent] = {}      # Agent 注册表
        self.message_bus = MessageBus()         # 消息总线
        self.task_queue = asyncio.Queue()      # 任务队列
        self.results: Dict[str, Any] = {}      # 结果存储

        # Agent 层级关系
        self.parent_map: Dict[str, str] = {}   # child_id -> parent_id
        self.children_map: Dict[str, List[str]] = {}  # parent_id -> [child_ids]

    def spawn_agent(
        self,
        role: str,
        task: str,
        parent_id: Optional[str] = None,
        mode: str = "async"  # "async" or "sync"
    ) -> str:
        """动态创建 Agent"""
        pass

    def kill_agent(self, agent_id: str):
        """销毁 Agent"""
        pass

    async def wait_for_agent(self, agent_id: str) -> Any:
        """等待 Agent 完成"""
        pass

    def send_message(self, from_id: str, to_id: str, content: Any):
        """Agent 间通信"""
        pass

    async def run(self, initial_task: str) -> Any:
        """运行整个 Multi-Agent 系统"""
        pass
```

#### 2. MultiAgent（多 Agent 能力的 Agent）

继承自 `Agent`，增加多 Agent 协作能力：

```python
class MultiAgent(Agent):
    """支持多 Agent 协作的 Agent"""

    def __init__(self, orchestrator: AgentOrchestrator, **kwargs):
        super().__init__(**kwargs)
        self.orchestrator = orchestrator
        self.agent_id = None  # 由 orchestrator 分配
        self.children: List[str] = []  # 子 Agent ID 列表

    async def spawn_child(
        self,
        role: str,
        task: str,
        wait: bool = False
    ) -> Union[str, Any]:
        """创建子 Agent"""
        child_id = self.orchestrator.spawn_agent(
            role=role,
            task=task,
            parent_id=self.agent_id
        )
        self.children.append(child_id)

        if wait:
            return await self.orchestrator.wait_for_agent(child_id)
        return child_id

    async def delegate_tasks(
        self,
        tasks: List[Tuple[str, str]],  # [(role, task), ...]
        mode: str = "parallel"  # "parallel" or "sequential"
    ) -> List[Any]:
        """批量委派任务"""
        if mode == "parallel":
            return await self._delegate_parallel(tasks)
        else:
            return await self._delegate_sequential(tasks)

    async def _delegate_parallel(self, tasks):
        """并行执行多个子任务"""
        child_ids = [
            await self.spawn_child(role, task, wait=False)
            for role, task in tasks
        ]

        # 等待所有子 Agent 完成
        results = await asyncio.gather(*[
            self.orchestrator.wait_for_agent(child_id)
            for child_id in child_ids
        ])

        return results

    async def _delegate_sequential(self, tasks):
        """顺序执行多个子任务"""
        results = []
        for role, task in tasks:
            result = await self.spawn_child(role, task, wait=True)
            results.append(result)
        return results

    def send_to_parent(self, content: Any):
        """向父 Agent 发送消息"""
        parent_id = self.orchestrator.parent_map.get(self.agent_id)
        if parent_id:
            self.orchestrator.send_message(self.agent_id, parent_id, content)

    def send_to_child(self, child_id: str, content: Any):
        """向子 Agent 发送消息"""
        self.orchestrator.send_message(self.agent_id, child_id, content)
```

#### 3. MessageBus（消息总线）

```python
class MessageBus:
    """Agent 间消息传递系统"""

    def __init__(self):
        self.queues: Dict[str, asyncio.Queue] = {}  # agent_id -> queue
        self.handlers: Dict[str, Callable] = {}     # agent_id -> handler

    def register(self, agent_id: str, handler: Callable):
        """注册 Agent 的消息处理器"""
        self.queues[agent_id] = asyncio.Queue()
        self.handlers[agent_id] = handler

    async def send(self, from_id: str, to_id: str, message: Message):
        """发送消息"""
        if to_id not in self.queues:
            raise ValueError(f"Agent {to_id} not found")

        await self.queues[to_id].put({
            "from": from_id,
            "to": to_id,
            "message": message,
            "timestamp": time.time()
        })

    async def listen(self, agent_id: str):
        """监听消息（由 Agent 调用）"""
        if agent_id not in self.queues:
            return None

        try:
            msg = await asyncio.wait_for(
                self.queues[agent_id].get(),
                timeout=0.1  # 非阻塞
            )
            return msg
        except asyncio.TimeoutError:
            return None
```

## Agent 通信

### 通信模式

#### 1. 父子通信（主要）

```python
# 父 -> 子：委派任务
child_id = await parent_agent.spawn_child(
    role="researcher",
    task="研究 Python 最佳实践"
)

# 子 -> 父：返回结果
child_agent.send_to_parent({
    "status": "completed",
    "result": "..."
})

# 父 -> 子：中途通信
parent_agent.send_to_child(child_id, {
    "instruction": "请关注并发编程部分"
})
```

#### 2. 兄弟通信（可选）

```python
# Agent A -> Agent B
orchestrator.send_message(agent_a_id, agent_b_id, {
    "type": "data_share",
    "data": research_results
})
```

#### 3. 广播通信（可选）

```python
# 向所有子 Agent 广播
for child_id in agent.children:
    agent.send_to_child(child_id, {
        "type": "update",
        "content": "全局配置已更新"
    })
```

### 消息格式

```python
class AgentMessage(BaseModel):
    """Agent 间消息"""
    from_agent: str          # 发送者 ID
    to_agent: str            # 接收者 ID
    message_type: str        # "task", "result", "update", "query"
    content: Any             # 消息内容
    timestamp: float         # 时间戳
    require_response: bool   # 是否需要回复
```

## 任务分解与调度

### 任务分解策略

#### 1. LLM 驱动的任务分解

```python
class CoordinatorAgent(MultiAgent):
    """协调者 Agent，负责任务分解"""

    async def decompose_task(self, task: str) -> List[Dict]:
        """让 LLM 分解任务"""
        prompt = f"""
        Please break down this task into subtasks:
        Task: {task}

        Output JSON format:
        [
            {{"role": "researcher", "task": "...", "depends_on": []}},
            {{"role": "coder", "task": "...", "depends_on": ["researcher"]}},
            ...
        ]
        """

        response = await self.arun(prompt, output_schema=TaskBreakdown)
        return response.parsed.subtasks

    async def execute_plan(self, task: str):
        """执行分解后的任务"""
        # 1. 分解任务
        subtasks = await self.decompose_task(task)

        # 2. 构建依赖图
        dep_graph = self._build_dependency_graph(subtasks)

        # 3. 拓扑排序，确定执行顺序
        execution_order = self._topological_sort(dep_graph)

        # 4. 按顺序执行（并行执行无依赖的任务）
        results = {}
        for level in execution_order:
            # 同一 level 的任务并行执行
            level_results = await self.delegate_tasks(
                tasks=[(st["role"], st["task"]) for st in level],
                mode="parallel"
            )
            results.update(dict(zip([st["id"] for st in level], level_results)))

        # 5. 聚合结果
        return self._aggregate_results(results)
```

#### 2. 依赖图构建

```python
def _build_dependency_graph(self, subtasks: List[Dict]) -> Dict:
    """构建任务依赖图"""
    graph = {task["id"]: task for task in subtasks}

    # 添加依赖关系
    for task in subtasks:
        task["children"] = [
            t["id"] for t in subtasks
            if task["id"] in t.get("depends_on", [])
        ]

    return graph

def _topological_sort(self, graph: Dict) -> List[List[Dict]]:
    """拓扑排序，返回分层的任务列表"""
    levels = []
    remaining = set(graph.keys())
    completed = set()

    while remaining:
        # 找出所有依赖已完成的任务
        current_level = [
            graph[task_id]
            for task_id in remaining
            if all(dep in completed for dep in graph[task_id].get("depends_on", []))
        ]

        if not current_level:
            raise ValueError("Circular dependency detected!")

        levels.append(current_level)
        completed.update(t["id"] for t in current_level)
        remaining -= completed

    return levels
```

### 调度策略

#### 1. 并行调度（默认）

适用于独立任务：
```python
results = await coordinator.delegate_tasks([
    ("researcher", "研究 A"),
    ("researcher", "研究 B"),
    ("researcher", "研究 C")
], mode="parallel")
```

#### 2. 顺序调度

适用于有依赖的任务：
```python
results = await coordinator.delegate_tasks([
    ("researcher", "研究"),
    ("coder", "基于研究结果编码"),
    ("tester", "测试代码")
], mode="sequential")
```

#### 3. Pipeline 调度

适用于流水线任务：
```python
async def pipeline_execution(self, tasks):
    """流水线执行：上一个的输出作为下一个的输入"""
    result = None

    for role, task_template in tasks:
        task = task_template.format(previous_result=result)
        result = await self.spawn_child(role, task, wait=True)

    return result
```

## 实现细节

### 完整实现示例

```python
# orchestrator.py
class AgentOrchestrator:
    def __init__(self):
        self.agents: Dict[str, MultiAgent] = {}
        self.message_bus = MessageBus()
        self.results: Dict[str, Any] = {}
        self.parent_map: Dict[str, str] = {}
        self.children_map: Dict[str, List[str]] = defaultdict(list)
        self._agent_tasks: Dict[str, asyncio.Task] = {}

    def spawn_agent(
        self,
        role: str,
        task: str,
        parent_id: Optional[str] = None,
        mode: str = "async"
    ) -> str:
        """创建新 Agent"""
        # 生成唯一 ID
        agent_id = f"{role}_{uuid.uuid4().hex[:8]}"

        # 从 Role 创建 Agent
        agent = MultiAgent.from_role(role)
        agent.agent_id = agent_id
        agent.orchestrator = self

        # 注册
        self.agents[agent_id] = agent
        self.message_bus.register(agent_id, agent._handle_message)

        # 维护层级关系
        if parent_id:
            self.parent_map[agent_id] = parent_id
            self.children_map[parent_id].append(agent_id)

        # 启动 Agent 执行任务
        if mode == "async":
            task_coro = self._run_agent(agent_id, task)
            self._agent_tasks[agent_id] = asyncio.create_task(task_coro)
        else:
            # 同步模式：阻塞执行
            result = asyncio.run(self._run_agent(agent_id, task))
            self.results[agent_id] = result

        return agent_id

    async def _run_agent(self, agent_id: str, task: str):
        """执行 Agent 任务"""
        agent = self.agents[agent_id]

        try:
            # 运行 Agent
            result = await agent.arun(task)

            # 存储结果
            self.results[agent_id] = result

            # 通知父 Agent（如果有）
            if agent_id in self.parent_map:
                parent_id = self.parent_map[agent_id]
                await self.message_bus.send(
                    agent_id,
                    parent_id,
                    Message(role="tool", content=f"Child {agent_id} completed")
                )

            return result

        except Exception as e:
            self.results[agent_id] = {"error": str(e)}
            raise

    async def wait_for_agent(self, agent_id: str, timeout: Optional[float] = None) -> Any:
        """等待 Agent 完成"""
        if agent_id not in self._agent_tasks:
            # 同步模式，直接返回结果
            return self.results.get(agent_id)

        task = self._agent_tasks[agent_id]

        if timeout:
            await asyncio.wait_for(task, timeout=timeout)
        else:
            await task

        return self.results.get(agent_id)

    def kill_agent(self, agent_id: str):
        """销毁 Agent"""
        if agent_id in self._agent_tasks:
            self._agent_tasks[agent_id].cancel()

        # 递归销毁所有子 Agent
        for child_id in self.children_map.get(agent_id, []):
            self.kill_agent(child_id)

        # 清理
        self.agents.pop(agent_id, None)
        self.results.pop(agent_id, None)
        self._agent_tasks.pop(agent_id, None)

    async def run(self, initial_task: str, coordinator_role: str = "coordinator") -> Any:
        """运行整个系统"""
        # 创建主协调者 Agent
        main_agent_id = self.spawn_agent(
            role=coordinator_role,
            task=initial_task,
            mode="async"
        )

        # 等待主 Agent 完成
        result = await self.wait_for_agent(main_agent_id)

        return result
```

### Multi-Agent 工具

为了让 Agent 能够创建子 Agent，需要提供专用工具：

```python
@tool
def spawn_agent_tool(role: str, task: str, wait: bool = False) -> str:
    """
    创建一个子 Agent 来执行特定任务

    Args:
        role: Agent 角色（researcher, coder, planner等）
        task: 要执行的任务描述
        wait: 是否等待 Agent 完成再返回

    Returns:
        Agent ID 或执行结果（如果 wait=True）
    """
    # 从上下文获取当前 Agent
    current_agent = get_current_agent()

    if wait:
        result = await current_agent.spawn_child(role, task, wait=True)
        return str(result)
    else:
        child_id = await current_agent.spawn_child(role, task, wait=False)
        return f"Created agent {child_id}"

@tool
def wait_for_agent_tool(agent_id: str) -> str:
    """等待指定 Agent 完成并获取结果"""
    current_agent = get_current_agent()
    result = await current_agent.orchestrator.wait_for_agent(agent_id)
    return str(result)

@tool
def send_message_tool(agent_id: str, content: str) -> str:
    """向另一个 Agent 发送消息"""
    current_agent = get_current_agent()
    current_agent.orchestrator.send_message(
        current_agent.agent_id,
        agent_id,
        Message(role="user", content=content)
    )
    return "Message sent"
```

## 使用示例

### 示例 1：简单的研究 + 编码任务

```python
from sakura import AgentOrchestrator, MultiAgent

# 创建编排器
orchestrator = AgentOrchestrator()

# 定义主任务
task = """
请完成一个完整的项目：
1. 研究 Python 异步编程最佳实践
2. 基于研究结果编写一个异步 Web 爬虫
3. 编写单元测试
4. 生成项目文档
"""

# 运行（会自动分解任务并创建子 Agent）
result = await orchestrator.run(task, coordinator_role="project_manager")

print(result)
```

### 示例 2：手动控制子 Agent

```python
class CustomCoordinator(MultiAgent):
    async def run_custom_workflow(self, topic: str):
        """自定义工作流"""

        # 1. 并行研究多个方面
        research_results = await self.delegate_tasks([
            ("researcher", f"研究 {topic} 的基础概念"),
            ("researcher", f"研究 {topic} 的最佳实践"),
            ("researcher", f"研究 {topic} 的常见陷阱")
        ], mode="parallel")

        # 2. 基于研究结果编码
        code_result = await self.spawn_child(
            role="coder",
            task=f"基于以下研究结果编写代码：\n{research_results}",
            wait=True
        )

        # 3. 测试代码
        test_result = await self.spawn_child(
            role="tester",
            task=f"为以下代码编写测试：\n{code_result}",
            wait=True
        )

        # 4. 生成文档
        doc_result = await self.spawn_child(
            role="documenter",
            task=f"为项目生成文档，包含研究、代码和测试",
            wait=True
        )

        return {
            "research": research_results,
            "code": code_result,
            "tests": test_result,
            "docs": doc_result
        }

# 使用
coordinator = CustomCoordinator(orchestrator=orchestrator)
result = await coordinator.run_custom_workflow("asyncio")
```

### 示例 3：动态决策的 Agent

```python
class AdaptiveCoordinator(MultiAgent):
    """根据中间结果动态调整策略的 Agent"""

    async def run_adaptive(self, goal: str):
        """自适应执行"""

        # 1. 初步研究
        initial_research = await self.spawn_child(
            "researcher",
            f"快速研究 {goal} 的可行性",
            wait=True
        )

        # 2. 根据研究结果决定下一步
        if "复杂" in initial_research:
            # 复杂任务：分解为多个子任务
            subtasks = await self._decompose_complex_task(goal)
            results = await self.delegate_tasks(subtasks, mode="parallel")
        else:
            # 简单任务：直接执行
            results = await self.spawn_child(
                "coder",
                f"直接实现 {goal}",
                wait=True
            )

        # 3. 验证结果
        validation = await self.spawn_child(
            "validator",
            f"验证结果是否符合要求：{results}",
            wait=True
        )

        # 4. 如果验证失败，重试
        if "失败" in validation:
            results = await self._retry_with_feedback(goal, validation)

        return results
```

## 最佳实践

### 1. 角色设计

为不同类型的任务设计专门的角色：

```python
roles = {
    "coordinator": "负责任务分解和协调",
    "researcher": "负责信息收集和研究",
    "coder": "负责编写代码",
    "tester": "负责测试验证",
    "reviewer": "负责代码审查",
    "documenter": "负责文档编写",
    "debugger": "负责问题诊断和修复"
}
```

### 2. 避免过度嵌套

```python
# ❌ 不好：层级太深
coordinator
  └─ sub_coordinator
       └─ sub_sub_coordinator
            └─ worker

# ✅ 好：扁平化
coordinator
  ├─ worker_1
  ├─ worker_2
  └─ worker_3
```

### 3. 设置超时

```python
# 避免子 Agent 无限执行
result = await orchestrator.wait_for_agent(
    agent_id,
    timeout=300  # 5 分钟超时
)
```

### 4. 错误处理

```python
try:
    result = await agent.spawn_child(role, task, wait=True)
except TimeoutError:
    # 超时处理
    result = "Task timeout, using fallback"
except Exception as e:
    # 其他错误
    result = f"Task failed: {e}"
```

## 下一步

了解如何通过 Role 系统快速定制不同类型的 Agent：
- [Role 系统设计](./04-role-system.md)
