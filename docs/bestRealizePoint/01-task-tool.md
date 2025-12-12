# Task Tool 行业最佳实践报告

> ✅ **实现状态：已完成** | 代码位置：`sakura/tools/builtin/task.py`

> 基于 Claude Code TodoWrite、LangGraph Checkpoints、AutoGen TaskManager 的深度分析

---

## 0. Sakura 实现总结

### 已实现功能

| 功能 | 状态 |
|------|------|
| CRUD 操作 (add/update/delete/list) | ✅ |
| 优先级支持 (low/medium/high/critical) | ✅ |
| 状态管理 (pending/in_progress/completed/blocked) | ✅ |
| 强制单一 in_progress | ✅ |
| 子任务层级 | ✅ |
| YAML 持久化 | ✅ |
| Markdown 格式输出 | ✅ |

### 使用示例

```python
from sakura import Agent
from sakura.tools.builtin import task

agent = Agent(
    model="qwen-plus",
    tools=[task, read_file, write_file],
    system_prompt="对于复杂任务，请先使用 task 工具制定计划。"
)

# LLM 会自动使用 task 工具管理任务进度
result = agent.run("帮我重构这个模块")
```

---

## 1. 核心设计理念

### Claude Code TodoWrite 的工作原理

Claude Code 使用 **ReAct 循环**（Reasoning and Acting）：
1. **Query** → 用户提供任务
2. **Plan** → 使用 `TodoWrite` 创建步骤计划
3. **Reason** → 确定下一个逻辑动作
4. **Act** → 执行工具
5. **Observe** → 分析工具输出
6. **Repeat** → 更新计划，继续执行

**关键洞察**：TodoWrite 不是可选功能，而是**强制检查点**。系统提示明确要求：
> "对于任何非简单任务，必须先使用 TodoWrite 制定计划"

### 为什么 Task Tool 有效

| 问题 | 解决方案 |
|------|----------|
| LLM 跳过步骤 | 注册步骤作为强制检查点 |
| 用户不知道进度 | 可视化任务列表 |
| 复杂任务失控 | 结构化分解 |
| 上下文丢失 | 状态持久化 |

---

## 2. 行业实现对比

### 2.1 Claude Code TodoWrite

```json
{
  "tool": "TodoWrite",
  "parameters": {
    "todos": [
      {"id": "1", "content": "分析需求", "status": "completed", "priority": "high"},
      {"id": "2", "content": "设计方案", "status": "in_progress", "priority": "high"},
      {"id": "3", "content": "实现代码", "status": "pending", "priority": "medium"}
    ]
  }
}
```

**特点**：
- 只有一个任务可以是 `in_progress`（强制聚焦）
- 支持优先级
- 每次调用返回完整列表（便于追踪变化）

### 2.2 LangGraph Checkpoints

```python
class StateGraph:
    def __init__(self):
        self.checkpointer = MemorySaver()  # 或 SqliteSaver
    
    def add_node(self, name: str, action: Callable):
        # 每个节点自动成为检查点
        pass
```

**特点**：
- 自动状态持久化
- 支持回退到任意检查点
- 基于图的状态管理

### 2.3 AutoGen TaskManager

```python
class TaskManager:
    def __init__(self):
        self.tasks = {}
        self.conversation_history = []
    
    def register_task(self, task_id: str, description: str):
        self.tasks[task_id] = {
            "description": description,
            "status": "pending",
            "subtasks": [],
            "assigned_agent": None
        }
```

**特点**：
- 支持子任务层级
- 关联到特定 Agent
- 对话历史与任务关联

---

## 3. Sakura 推荐实现

### 3.1 设计原则

1. **轻量优先**：内存中管理，可选持久化
2. **与 Function 系统兼容**：使用 `@tool` 装饰器
3. **单一职责**：Task Tool 只管理任务，不创建 Agent
4. **强制聚焦**：同一时间只有一个 `in_progress` 任务

### 3.2 数据模型

```python
from dataclasses import dataclass, field
from typing import List, Optional, Literal
from enum import Enum
from datetime import datetime
import uuid

class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"

class TaskPriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

@dataclass
class Task:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    priority: TaskPriority = TaskPriority.MEDIUM
    parent_id: Optional[str] = None  # 支持子任务
    created_at: datetime = field(default_factory=datetime.now)
    completed_at: Optional[datetime] = None
    metadata: dict = field(default_factory=dict)
```

### 3.3 管理器实现

```python
class TaskManager:
    """轻量级任务管理器"""
    
    def __init__(self, persist_path: Optional[str] = None):
        self._tasks: dict[str, Task] = {}
        self._persist_path = persist_path
        self._load_if_exists()
    
    def add(self, description: str, priority: str = "medium", parent_id: str = None) -> Task:
        task = Task(
            description=description,
            priority=TaskPriority(priority),
            parent_id=parent_id
        )
        self._tasks[task.id] = task
        self._persist()
        return task
    
    def update_status(self, task_id: str, status: str) -> Task:
        if task_id not in self._tasks:
            raise ValueError(f"Task {task_id} not found")
        
        task = self._tasks[task_id]
        new_status = TaskStatus(status)
        
        # 强制单一 in_progress（可选）
        if new_status == TaskStatus.IN_PROGRESS:
            for t in self._tasks.values():
                if t.status == TaskStatus.IN_PROGRESS and t.id != task_id:
                    t.status = TaskStatus.PENDING
        
        task.status = new_status
        if new_status == TaskStatus.COMPLETED:
            task.completed_at = datetime.now()
        
        self._persist()
        return task
    
    def list_formatted(self, include_completed: bool = True) -> str:
        """生成 Markdown 格式的任务列表"""
        icons = {
            TaskStatus.PENDING: "⬜",
            TaskStatus.IN_PROGRESS: "🔄",
            TaskStatus.COMPLETED: "✅",
            TaskStatus.BLOCKED: "🚫"
        }
        priority_badge = {
            TaskPriority.CRITICAL: "🔴",
            TaskPriority.HIGH: "🟠",
            TaskPriority.MEDIUM: "🟡",
            TaskPriority.LOW: "🟢"
        }
        
        lines = ["## 任务列表\n"]
        
        # 分组：进行中 > 待处理 > 阻塞 > 已完成
        groups = {
            TaskStatus.IN_PROGRESS: [],
            TaskStatus.PENDING: [],
            TaskStatus.BLOCKED: [],
            TaskStatus.COMPLETED: []
        }
        
        for task in self._tasks.values():
            if not include_completed and task.status == TaskStatus.COMPLETED:
                continue
            # 只显示顶级任务
            if task.parent_id is None:
                groups[task.status].append(task)
        
        for status, tasks in groups.items():
            if tasks:
                for task in tasks:
                    icon = icons[task.status]
                    badge = priority_badge[task.priority]
                    lines.append(f"{icon} {badge} [{task.id}] {task.description}")
                    # 显示子任务
                    for subtask in self._get_subtasks(task.id):
                        sub_icon = icons[subtask.status]
                        lines.append(f"  {sub_icon} [{subtask.id}] {subtask.description}")
        
        return "\n".join(lines)
    
    def _get_subtasks(self, parent_id: str) -> List[Task]:
        return [t for t in self._tasks.values() if t.parent_id == parent_id]
    
    def _persist(self):
        if self._persist_path:
            import json
            data = {tid: asdict(t) for tid, t in self._tasks.items()}
            with open(self._persist_path, 'w') as f:
                json.dump(data, f, default=str, ensure_ascii=False)
    
    def _load_if_exists(self):
        if self._persist_path and Path(self._persist_path).exists():
            import json
            with open(self._persist_path) as f:
                data = json.load(f)
            for tid, tdata in data.items():
                self._tasks[tid] = Task(**tdata)
```

### 3.4 工具函数

```python
# 全局管理器实例
_manager = TaskManager()

@tool
def task(
    action: Literal["add", "update", "list", "delete"] = "list",
    description: str = "",
    task_id: str = "",
    status: str = "",
    priority: str = "medium",
    parent_id: str = ""
) -> str:
    """
    管理任务列表，类似 Claude Code 的 TodoWrite。
    
    使用场景：
    - 复杂任务分解为多个步骤
    - 跟踪任务进度
    - 创建子任务
    
    Args:
        action: 操作类型
            - "add": 添加任务
            - "update": 更新任务状态
            - "list": 列出所有任务
            - "delete": 删除任务
        description: 任务描述（add 时必填）
        task_id: 任务 ID（update/delete 时必填）
        status: 新状态（update 时必填）: pending/in_progress/completed/blocked
        priority: 优先级: low/medium/high/critical
        parent_id: 父任务 ID（创建子任务时使用）
    
    Returns:
        当前任务列表的 Markdown 格式字符串
    """
    if action == "add":
        if not description:
            return "Error: description is required for 'add' action"
        t = _manager.add(description, priority, parent_id or None)
        result = f"✅ 添加任务: [{t.id}] {description}\n\n"
    
    elif action == "update":
        if not task_id or not status:
            return "Error: task_id and status are required for 'update' action"
        t = _manager.update_status(task_id, status)
        result = f"✅ 更新任务: [{t.id}] → {status}\n\n"
    
    elif action == "delete":
        if not task_id:
            return "Error: task_id is required for 'delete' action"
        _manager.delete(task_id)
        result = f"✅ 删除任务: [{task_id}]\n\n"
    
    else:  # list
        result = ""
    
    return result + _manager.list_formatted()
```

---

## 4. 使用模式

### 模式 1：复杂任务分解

```
User: 帮我重构这个模块

Agent 内部调用:
1. task(action="add", description="分析现有代码结构", priority="high")
2. task(action="add", description="设计新的架构")
3. task(action="add", description="实现核心功能")
4. task(action="add", description="编写测试")
5. task(action="add", description="更新文档")

执行过程中：
6. task(action="update", task_id="abc123", status="in_progress")
7. ... 执行分析 ...
8. task(action="update", task_id="abc123", status="completed")
```

### 模式 2：带子任务的层级结构

```
1. task(action="add", description="实现用户系统")  # 返回 id: "main1"
2. task(action="add", description="设计数据模型", parent_id="main1")
3. task(action="add", description="实现 API", parent_id="main1")
4. task(action="add", description="编写测试", parent_id="main1")
```

输出：
```
## 任务列表

🔄 🟠 [main1] 实现用户系统
  ⬜ [sub1] 设计数据模型
  ⬜ [sub2] 实现 API
  ⬜ [sub3] 编写测试
```

---

## 5. 与 Sakura 现有架构的集成

### 集成点

```python
# sakura/tools/builtin/__init__.py
from .task import task, TaskManager, Task
```

### Agent 初始化示例

```python
from sakura import Agent
from sakura.tools.builtin import task, read_file, write_file

agent = Agent(
    model="qwen-plus",
    tools=[task, read_file, write_file],  # task 作为普通工具
    system_prompt="你是一个编程助手。对于复杂任务，请先使用 task 工具制定计划。"
)
```

### 系统提示增强（可选）

```markdown
## 任务管理指南

对于复杂任务（预计需要 3 步以上），请：
1. 先使用 `task(action="add")` 分解任务
2. 执行每步前，用 `task(action="update", status="in_progress")` 标记
3. 完成后用 `task(action="update", status="completed")` 更新
4. 遇到阻塞用 `task(action="update", status="blocked")` 标记

这有助于保持进度可见，避免遗漏步骤。
```

---

## 6. 性能考量

| 方面 | 建议 |
|------|------|
| **存储** | 默认内存存储，可选 JSON 持久化 |
| **查询** | O(1) 查询单个任务，O(n) 列出所有 |
| **序列化** | 使用 dataclass + asdict，避免 Pydantic 开销 |
| **并发** | 单 Agent 无需锁；多 Agent 共享时考虑文件锁 |

---

## 7. 与其他工具的区别

| 特性 | Task Tool | SubAgent Tool |
|------|-----------|---------------|
| 职责 | 任务管理 | 任务执行 |
| 创建 Agent | ❌ 不创建 | ✅ 创建子 Agent |
| 状态管理 | ✅ 有状态 | 无状态 |
| 依赖关系 | 无 | 无 |

**重要**：两者完全独立，可以组合使用，但没有直接依赖。
