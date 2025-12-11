# 自主 Agent 模式

本文档说明如何实现 Claude Code 风格的自主执行 Agent，能够持续工作直到完成复杂目标。

## 目录
- [设计理念](#设计理念)
- [核心架构](#核心架构)
- [实现细节](#实现细节)
- [停止条件](#停止条件)
- [状态管理](#状态管理)
- [使用示例](#使用示例)

## 设计理念

### 什么是自主 Agent？

**传统 Agent**：
```python
# 用户每次都要明确指示下一步
agent.run("研究 Python")
agent.run("基于研究写代码")
agent.run("测试代码")
```

**自主 Agent**：
```python
# 给定目标，Agent 自己决定所有步骤
agent.run_autonomous("创建一个完整的 Python 异步爬虫项目")

# Agent 自动完成：
# 1. 研究异步编程和爬虫技术
# 2. 设计项目架构
# 3. 编写代码
# 4. 编写测试
# 5. 运行测试并修复 bug
# 6. 编写文档
# 7. 完成！
```

### Claude Code 的自主模式

Claude Code 的 Agent 有以下特点：

1. **自主决策**：Agent 自己规划下一步做什么
2. **持续执行**：循环执行直到目标完成
3. **动态调整**：根据中间结果调整策略
4. **任务队列**：维护待办任务列表
5. **目标检测**：判断目标是否达成
6. **暂停机制**：在需要人类介入时暂停

## 核心架构

### 整体流程

```
Start
  ↓
Initialize (goal, state, task_queue)
  ↓
┌──────────────────────────────┐
│   Main Loop (max iterations) │
│   ┌────────────────────┐     │
│   │ 1. Plan next step  │     │
│   └─────────┬──────────┘     │
│             ↓                │
│   ┌────────────────────┐     │
│   │ 2. Execute action  │     │
│   └─────────┬──────────┘     │
│             ↓                │
│   ┌────────────────────┐     │
│   │ 3. Update state    │     │
│   └─────────┬──────────┘     │
│             ↓                │
│   ┌────────────────────┐     │
│   │ 4. Check goal      │     │
│   └─────────┬──────────┘     │
│             ↓                │
│        Goal achieved?        │
│       /            \         │
│     Yes            No        │
│      │              │        │
│      │              ↓        │
│      │      ┌──────────────┐ │
│      │      │ Should pause?│ │
│      │      └───┬──────────┘ │
│      │          │            │
│      │        Yes            │
│      │         │             │
└──────┼─────────┼─────────────┘
       │         │
       ↓         ↓
    Success   Paused
```

### 核心状态

```python
class AgentState:
    """自主 Agent 的状态"""
    goal: str                          # 最终目标
    completed_steps: List[Step]        # 已完成的步骤
    pending_tasks: List[Task]          # 待办任务队列
    current_context: Dict[str, Any]    # 当前上下文（文件、变量等）
    iteration: int                     # 当前迭代次数
    status: str                        # running, completed, paused, failed
```

## 实现细节

### AutonomousAgent 类

```python
from typing import Optional, List, Dict, Any, Callable
from dataclasses import dataclass
from enum import Enum

class AgentStatus(Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    PAUSED = "paused"
    FAILED = "failed"

@dataclass
class Step:
    """执行步骤"""
    action: str              # 动作类型（search, write_code, run_test等）
    description: str         # 步骤描述
    result: Any              # 执行结果
    timestamp: float         # 时间戳
    duration: float          # 耗时

@dataclass
class Task:
    """待办任务"""
    id: str
    description: str
    priority: int = 0
    depends_on: List[str] = None

    def __post_init__(self):
        if self.depends_on is None:
            self.depends_on = []

class AutonomousAgent(Agent):
    """自主执行的 Agent"""

    def __init__(
        self,
        max_iterations: int = 50,
        stop_conditions: List[str] = None,
        goal_checker: Optional[Callable] = None,
        **kwargs
    ):
        super().__init__(**kwargs)

        self.max_iterations = max_iterations
        self.stop_conditions = stop_conditions or [
            "user_approval_needed",
            "critical_error",
            "goal_achieved"
        ]
        self.goal_checker = goal_checker

        # 状态
        self.state = None

    async def run_autonomous(self, goal: str) -> Dict[str, Any]:
        """自主执行直到完成目标"""

        # 初始化状态
        self.state = {
            "goal": goal,
            "completed_steps": [],
            "pending_tasks": [Task(id="initial", description=goal)],
            "context": {},
            "iteration": 0,
            "status": AgentStatus.RUNNING
        }

        # 主循环
        for i in range(self.max_iterations):
            self.state["iteration"] = i

            # 1. 规划下一步
            next_action = await self._plan_next_step()

            if next_action is None:
                # 没有更多任务
                break

            # 2. 执行动作
            result = await self._execute_action(next_action)

            # 3. 记录步骤
            step = Step(
                action=next_action["action"],
                description=next_action["description"],
                result=result,
                timestamp=time.time(),
                duration=result.get("duration", 0)
            )
            self.state["completed_steps"].append(step)

            # 4. 更新上下文
            self._update_context(result)

            # 5. 检查目标
            if await self._is_goal_achieved():
                self.state["status"] = AgentStatus.COMPLETED
                break

            # 6. 检查停止条件
            pause_reason = self._should_pause(result)
            if pause_reason:
                self.state["status"] = AgentStatus.PAUSED
                self.state["pause_reason"] = pause_reason
                break

            # 7. 更新任务队列
            await self._update_task_queue(result)

        # 生成最终报告
        return self._generate_report()

    async def _plan_next_step(self) -> Optional[Dict]:
        """规划下一步动作"""

        # 如果没有待办任务，返回 None
        if not self.state["pending_tasks"]:
            return None

        # 构造规划提示词
        prompt = f"""
Current situation:
- Goal: {self.state['goal']}
- Completed steps: {len(self.state['completed_steps'])}
- Pending tasks: {[t.description for t in self.state['pending_tasks']]}
- Current context: {self._summarize_context()}

Based on the current situation, what should I do next?

Output in JSON format:
{{
    "action": "tool_name or action_type",
    "description": "brief description of what to do",
    "arguments": {{}},
    "reason": "why this is the next best step"
}}

Choose the most important task and decide the concrete action.
"""

        # 让 LLM 决策
        response = await self.arun(
            prompt,
            output_schema=NextActionSchema
        )

        return response.parsed.dict() if response.parsed else None

    async def _execute_action(self, action: Dict) -> Dict:
        """执行动作"""
        action_type = action["action"]
        arguments = action.get("arguments", {})

        start_time = time.time()

        try:
            # 如果是工具调用
            if action_type in self._functions:
                tool = self._functions[action_type]
                result = await tool.aexecute(**arguments)
                success = True
                output = result.result

            # 如果是 LLM 生成内容
            elif action_type in ["generate", "write", "create"]:
                response = await self.arun(action["description"])
                success = True
                output = response.content

            # 其他动作类型
            else:
                output = await self._handle_custom_action(action)
                success = True

        except Exception as e:
            success = False
            output = str(e)

        duration = time.time() - start_time

        return {
            "success": success,
            "output": output,
            "duration": duration,
            "action": action
        }

    def _update_context(self, result: Dict):
        """更新上下文信息"""
        action = result["action"]

        # 根据动作类型更新上下文
        if action["action"] == "read_file":
            file_path = action["arguments"]["path"]
            self.state["context"][f"file:{file_path}"] = result["output"]

        elif action["action"] == "write_file":
            file_path = action["arguments"]["path"]
            self.state["context"][f"file:{file_path}"] = "modified"

        elif action["action"] == "search":
            query = action["arguments"]["query"]
            self.state["context"][f"search:{query}"] = result["output"]

        # 保存最近的执行结果
        self.state["context"]["last_result"] = result["output"]

    async def _is_goal_achieved(self) -> bool:
        """检查目标是否达成"""

        # 如果提供了自定义检查器
        if self.goal_checker:
            return await self.goal_checker(self.state)

        # 使用 LLM 判断
        prompt = f"""
Goal: {self.state['goal']}

Completed steps:
{self._format_completed_steps()}

Current context:
{self._summarize_context()}

Has the goal been fully achieved? Answer with JSON:
{{
    "achieved": true/false,
    "reason": "explanation",
    "remaining": ["list of remaining tasks if not achieved"]
}}
"""

        response = await self.arun(prompt, output_schema=GoalCheckSchema)

        if response.parsed:
            return response.parsed.achieved

        return False

    def _should_pause(self, result: Dict) -> Optional[str]:
        """检查是否需要暂停"""

        # 检查工具执行结果
        if not result["success"]:
            # 关键错误
            if "critical" in result["output"].lower():
                return "critical_error"

        # 检查是否需要用户确认
        if result.get("requires_approval"):
            return "user_approval_needed"

        # 检查是否需要外部输入
        if result.get("requires_input"):
            return "user_input_needed"

        return None

    async def _update_task_queue(self, result: Dict):
        """更新任务队列"""

        # 移除已完成的任务
        action = result["action"]
        self.state["pending_tasks"] = [
            t for t in self.state["pending_tasks"]
            if t.description != action["description"]
        ]

        # 根据结果添加新任务
        prompt = f"""
I just completed: {action['description']}
Result: {result['output']}

Goal: {self.state['goal']}
Remaining tasks: {[t.description for t in self.state['pending_tasks']]}

Should I add any new tasks? Output JSON:
{{
    "new_tasks": [
        {{"description": "...", "priority": 1}},
        ...
    ]
}}

Only add tasks that are necessary to achieve the goal.
"""

        response = await self.arun(prompt, output_schema=TaskUpdateSchema)

        if response.parsed and response.parsed.new_tasks:
            for task_data in response.parsed.new_tasks:
                task = Task(
                    id=f"task_{len(self.state['pending_tasks'])}",
                    description=task_data["description"],
                    priority=task_data.get("priority", 0)
                )
                self.state["pending_tasks"].append(task)

            # 按优先级排序
            self.state["pending_tasks"].sort(key=lambda t: -t.priority)

    def _generate_report(self) -> Dict[str, Any]:
        """生成执行报告"""
        return {
            "status": self.state["status"].value,
            "goal": self.state["goal"],
            "iterations": self.state["iteration"],
            "completed_steps": len(self.state["completed_steps"]),
            "steps": [
                {
                    "action": s.action,
                    "description": s.description,
                    "duration": s.duration
                }
                for s in self.state["completed_steps"]
            ],
            "final_context": self.state["context"],
            "pause_reason": self.state.get("pause_reason"),
            "summary": self._generate_summary()
        }

    def _generate_summary(self) -> str:
        """生成执行摘要"""
        steps_summary = "\n".join([
            f"{i+1}. {s.description} ({s.duration:.1f}s)"
            for i, s in enumerate(self.state["completed_steps"])
        ])

        return f"""
Goal: {self.state['goal']}
Status: {self.state['status'].value}
Total steps: {len(self.state['completed_steps'])}

Steps taken:
{steps_summary}
"""

    def _summarize_context(self) -> str:
        """总结当前上下文"""
        context_items = []

        for key, value in self.state["context"].items():
            if isinstance(value, str):
                # 截断长文本
                preview = value[:100] + "..." if len(value) > 100 else value
                context_items.append(f"- {key}: {preview}")

        return "\n".join(context_items) if context_items else "No context yet"

    def _format_completed_steps(self) -> str:
        """格式化已完成步骤"""
        return "\n".join([
            f"{i+1}. {s.description}"
            for i, s in enumerate(self.state["completed_steps"])
        ])
```

## 停止条件

### 内置停止条件

```python
class StopCondition(Enum):
    # 正常完成
    GOAL_ACHIEVED = "goal_achieved"

    # 需要暂停
    USER_APPROVAL_NEEDED = "user_approval_needed"
    USER_INPUT_NEEDED = "user_input_needed"
    EXTERNAL_EXECUTION = "external_execution"

    # 错误情况
    CRITICAL_ERROR = "critical_error"
    MAX_ITERATIONS = "max_iterations"
    TIMEOUT = "timeout"

    # 手动停止
    USER_STOPPED = "user_stopped"
```

### 自定义停止条件

```python
def custom_stop_checker(state: Dict) -> Optional[str]:
    """自定义停止检查器"""

    # 示例：检查预算
    total_cost = sum(s.cost for s in state["completed_steps"])
    if total_cost > 10.0:  # $10 限制
        return "budget_exceeded"

    # 示例：检查时间
    elapsed = time.time() - state["start_time"]
    if elapsed > 3600:  # 1 小时限制
        return "time_limit_exceeded"

    # 示例：检查文件数量
    files_created = len([
        s for s in state["completed_steps"]
        if s.action == "write_file"
    ])
    if files_created > 50:
        return "too_many_files"

    return None

# 使用
agent = AutonomousAgent(
    stop_conditions=[custom_stop_checker]
)
```

## 状态管理

### 状态持久化

```python
class AutonomousAgent(Agent):
    def save_state(self, path: str):
        """保存当前状态"""
        with open(path, "w") as f:
            json.dump({
                "goal": self.state["goal"],
                "completed_steps": [
                    {
                        "action": s.action,
                        "description": s.description,
                        "result": str(s.result),
                        "timestamp": s.timestamp,
                        "duration": s.duration
                    }
                    for s in self.state["completed_steps"]
                ],
                "pending_tasks": [
                    {"id": t.id, "description": t.description, "priority": t.priority}
                    for t in self.state["pending_tasks"]
                ],
                "context": self.state["context"],
                "iteration": self.state["iteration"],
                "status": self.state["status"].value
            }, f, indent=2)

    @classmethod
    def load_state(cls, path: str, **kwargs) -> "AutonomousAgent":
        """从保存的状态恢复"""
        with open(path) as f:
            state_data = json.load(f)

        agent = cls(**kwargs)
        agent.state = {
            "goal": state_data["goal"],
            "completed_steps": [
                Step(**s) for s in state_data["completed_steps"]
            ],
            "pending_tasks": [
                Task(**t) for t in state_data["pending_tasks"]
            ],
            "context": state_data["context"],
            "iteration": state_data["iteration"],
            "status": AgentStatus(state_data["status"])
        }

        return agent

    async def resume(self) -> Dict[str, Any]:
        """从暂停状态恢复执行"""
        if self.state["status"] != AgentStatus.PAUSED:
            raise ValueError("Agent is not paused")

        # 重置状态
        self.state["status"] = AgentStatus.RUNNING

        # 从当前迭代继续
        start_iteration = self.state["iteration"]

        for i in range(start_iteration, self.max_iterations):
            # ... 继续执行
            pass
```

### 检查点机制

```python
class AutonomousAgent(Agent):
    def __init__(self, checkpoint_interval: int = 10, **kwargs):
        super().__init__(**kwargs)
        self.checkpoint_interval = checkpoint_interval

    async def run_autonomous(self, goal: str):
        # ...主循环

        for i in range(self.max_iterations):
            # ... 执行步骤

            # 定期保存检查点
            if i % self.checkpoint_interval == 0:
                self.save_state(f"checkpoint_{i}.json")
```

## 使用示例

### 示例 1：完整项目开发

```python
from sakura import AutonomousAgent

# 创建自主 Agent
agent = AutonomousAgent(
    model=Claude(id="claude-3-5-sonnet"),
    tools=[
        search_web,
        read_file,
        write_file,
        run_command,
        run_tests
    ],
    max_iterations=50
)

# 给定高层目标
goal = """
创建一个完整的 Python 异步 Web 爬虫项目：
1. 支持并发爬取
2. 包含错误处理和重试机制
3. 有完整的单元测试（覆盖率 > 80%）
4. 包含 README 和使用文档
"""

# 自主执行
result = await agent.run_autonomous(goal)

print(f"Status: {result['status']}")
print(f"Completed {result['completed_steps']} steps")
print(f"\n{result['summary']}")
```

### 示例 2：自适应研究

```python
agent = AutonomousAgent.from_role("researcher", max_iterations=30)

goal = """
深入研究 Python 异步编程，并输出一份完整报告。
报告应包含：
- 基础概念
- 常见模式
- 最佳实践
- 性能对比
- 实际案例
"""

result = await agent.run_autonomous(goal)
```

### 示例 3：Bug 修复

```python
agent = AutonomousAgent.from_role("debugger", max_iterations=20)

goal = """
修复项目中的所有测试失败：
1. 运行测试找出所有失败
2. 分析每个失败的原因
3. 修复代码
4. 重新运行测试验证
5. 重复直到所有测试通过
"""

result = await agent.run_autonomous(goal)
```

### 示例 4：带自定义目标检查器

```python
def project_complete_checker(state: Dict) -> bool:
    """检查项目是否完成"""

    # 检查必需文件
    required_files = [
        "src/main.py",
        "tests/test_main.py",
        "README.md",
        "requirements.txt"
    ]

    for file_path in required_files:
        if f"file:{file_path}" not in state["context"]:
            return False

    # 检查测试是否通过
    test_results = [
        s.result for s in state["completed_steps"]
        if s.action == "run_tests"
    ]

    if not test_results or "FAILED" in test_results[-1]:
        return False

    return True

# 使用自定义检查器
agent = AutonomousAgent(
    goal_checker=project_complete_checker,
    max_iterations=50
)

result = await agent.run_autonomous("创建完整项目")
```

### 示例 5：暂停和恢复

```python
# 第一次运行
agent = AutonomousAgent(max_iterations=50)

try:
    result = await agent.run_autonomous("复杂任务")
except KeyboardInterrupt:
    # 用户中断，保存状态
    agent.save_state("paused_state.json")
    print("Progress saved")

# 稍后恢复
agent = AutonomousAgent.load_state(
    "paused_state.json",
    model=Claude(id="claude-3-5-sonnet"),
    tools=[...]
)

# 继续执行
result = await agent.resume()
```

### 示例 6：实时监控

```python
class MonitoredAutonomousAgent(AutonomousAgent):
    """带实时监控的自主 Agent"""

    async def run_autonomous(self, goal: str):
        # 启动监控界面
        monitor = AgentMonitor()

        # Hook 到步骤执行
        async def on_step_complete(step: Step):
            monitor.update(
                iteration=self.state["iteration"],
                current_task=step.description,
                completed=len(self.state["completed_steps"]),
                pending=len(self.state["pending_tasks"])
            )

        self.on_step_complete = on_step_complete

        # 运行
        return await super().run_autonomous(goal)

# 使用
agent = MonitoredAutonomousAgent(...)
result = await agent.run_autonomous("目标")

# 用户可以实时看到：
# Iteration: 15/50
# Current: Writing unit tests
# Completed: 14 steps
# Pending: 3 tasks
```

## 最佳实践

### 1. 设置合理的迭代次数

```python
# 简单任务
agent = AutonomousAgent(max_iterations=10)

# 中等复杂度
agent = AutonomousAgent(max_iterations=30)

# 复杂项目
agent = AutonomousAgent(max_iterations=100)
```

### 2. 提供清晰的目标

```python
# ❌ 不好：模糊
goal = "做一个网站"

# ✅ 好：具体
goal = """
创建一个博客网站，包含：
- 用户认证系统
- 文章 CRUD 功能
- 评论系统
- 响应式设计
- 单元测试（覆盖率 > 70%）
"""
```

### 3. 使用检查点

```python
# 长时间运行的任务应启用检查点
agent = AutonomousAgent(
    max_iterations=100,
    checkpoint_interval=10  # 每 10 步保存一次
)
```

### 4. 监控资源使用

```python
def resource_monitor(state: Dict) -> Optional[str]:
    """监控资源使用"""
    # Token 使用量
    total_tokens = sum(s.tokens for s in state["completed_steps"])
    if total_tokens > 100000:
        return "token_limit_exceeded"

    # API 调用次数
    api_calls = len(state["completed_steps"])
    if api_calls > 200:
        return "too_many_api_calls"

    return None

agent = AutonomousAgent(stop_conditions=[resource_monitor])
```

### 5. 错误恢复

```python
class ResilientAutonomousAgent(AutonomousAgent):
    """具有错误恢复能力的 Agent"""

    async def _execute_action(self, action: Dict) -> Dict:
        max_retries = 3

        for attempt in range(max_retries):
            try:
                return await super()._execute_action(action)
            except Exception as e:
                if attempt == max_retries - 1:
                    # 最后一次尝试失败
                    return {
                        "success": False,
                        "output": f"Failed after {max_retries} attempts: {e}",
                        "action": action
                    }

                # 等待后重试
                await asyncio.sleep(2 ** attempt)  # 指数退避
```

## 性能考虑

### 1. 减少 LLM 调用

```python
# ❌ 每步都调用 LLM 规划
for i in range(50):
    next_step = await self._plan_next_step()  # LLM 调用

# ✅ 批量规划多个步骤
plan = await self._plan_multiple_steps(n=5)  # 一次 LLM 调用
for step in plan:
    await self._execute_action(step)
```

### 2. 并行执行

```python
async def _execute_parallel_actions(self, actions: List[Dict]):
    """并行执行独立的动作"""
    results = await asyncio.gather(*[
        self._execute_action(action)
        for action in actions
    ])
    return results
```

### 3. 缓存决策

```python
class CachedAutonomousAgent(AutonomousAgent):
    """缓存相似决策"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._decision_cache = {}

    async def _plan_next_step(self):
        # 计算当前状态的哈希
        state_hash = self._hash_state()

        # 检查缓存
        if state_hash in self._decision_cache:
            return self._decision_cache[state_hash]

        # 调用 LLM
        decision = await super()._plan_next_step()

        # 缓存决策
        self._decision_cache[state_hash] = decision

        return decision
```

## 下一步

查看完整的开发路线图：
- [开发路线图](./06-roadmap.md)
