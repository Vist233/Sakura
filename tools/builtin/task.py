"""
Task Tool - 轻量级任务管理工具

借鉴 Claude Code TodoWrite、LangGraph Checkpoints、AutoGen TaskManager 的设计理念：
- Harrison Chase (LangChain): 模块化设计、链式思维
- Chi Wang (AutoGen): 事件驱动、可扩展持久化
- João Moura (CrewAI): 任务编排、可视化输出

核心特性：
- 强制单一聚焦：同一时间只有一个 in_progress 任务
- 层级子任务：支持 parent_id 创建子任务
- 可视化输出：Emoji 图标 + Markdown 格式
- 轻量优先：dataclass + 内存存储
- 可选持久化：YAML 文件存储（可读性更强）
"""

import yaml
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Dict, List, Literal, Optional

from ..decorator import tool


class TaskStatus(str, Enum):
    """任务状态枚举"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"


class TaskPriority(str, Enum):
    """任务优先级枚举"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class Task:
    """任务数据类"""
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    priority: TaskPriority = TaskPriority.MEDIUM
    parent_id: Optional[str] = None  # 支持子任务
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None
    metadata: Dict = field(default_factory=dict)
    
    def __post_init__(self):
        # 确保 status 和 priority 是枚举类型
        if isinstance(self.status, str):
            self.status = TaskStatus(self.status)
        if isinstance(self.priority, str):
            self.priority = TaskPriority(self.priority)


class TaskManager:
    """
    轻量级任务管理器
    
    设计原则：
    - 内存中管理，可选持久化
    - 强制单一聚焦（同一时间只有一个 in_progress 任务）
    - 支持子任务层级
    """
    
    def __init__(self, persist_path: Optional[str] = None):
        self._tasks: Dict[str, Task] = {}
        self._persist_path = persist_path
        self._load_if_exists()
    
    def add(
        self, 
        description: str, 
        priority: str = "medium", 
        parent_id: Optional[str] = None,
        metadata: Optional[Dict] = None
    ) -> Task:
        """添加新任务"""
        task = Task(
            description=description,
            priority=TaskPriority(priority),
            parent_id=parent_id,
            metadata=metadata or {}
        )
        self._tasks[task.id] = task
        self._persist()
        return task
    
    def update_status(self, task_id: str, status: str) -> Task:
        """
        更新任务状态
        
        强制单一 in_progress：当设置新任务为 in_progress 时，
        其他正在进行的任务会被重置为 pending
        """
        if task_id not in self._tasks:
            raise ValueError(f"任务不存在: {task_id}")
        
        task = self._tasks[task_id]
        new_status = TaskStatus(status)
        
        # 强制单一 in_progress
        if new_status == TaskStatus.IN_PROGRESS:
            for t in self._tasks.values():
                if t.status == TaskStatus.IN_PROGRESS and t.id != task_id:
                    t.status = TaskStatus.PENDING
        
        task.status = new_status
        if new_status == TaskStatus.COMPLETED:
            task.completed_at = datetime.now().isoformat()
        
        self._persist()
        return task
    
    def delete(self, task_id: str) -> bool:
        """删除任务（同时删除子任务）"""
        if task_id not in self._tasks:
            return False
        
        # 删除子任务
        subtask_ids = [t.id for t in self._tasks.values() if t.parent_id == task_id]
        for sid in subtask_ids:
            del self._tasks[sid]
        
        # 删除主任务
        del self._tasks[task_id]
        self._persist()
        return True
    
    def get(self, task_id: str) -> Optional[Task]:
        """获取单个任务"""
        return self._tasks.get(task_id)
    
    def list_all(self) -> List[Task]:
        """获取所有任务"""
        return list(self._tasks.values())
    
    def list_formatted(self, include_completed: bool = True) -> str:
        """
        生成 Markdown 格式的任务列表
        
        格式示例：
        ## 任务列表
        🔄 🟠 [abc123] 正在进行的任务
          ⬜ [sub1] 子任务 1
        ⬜ 🟡 [def456] 待处理任务
        """
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
        
        lines = ["## 📋 任务列表\n"]
        
        if not self._tasks:
            lines.append("*暂无任务*")
            return "\n".join(lines)
        
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
                        lines.append(f"   {sub_icon} [{subtask.id}] {subtask.description}")
        
        return "\n".join(lines)
    
    def _get_subtasks(self, parent_id: str) -> List[Task]:
        """获取子任务列表"""
        return [t for t in self._tasks.values() if t.parent_id == parent_id]
    
    def _persist(self):
        """持久化到 YAML 文件（更可读，支持注释）"""
        if self._persist_path:
            data = {}
            for tid, t in self._tasks.items():
                task_dict = asdict(t)
                # 将枚举转为字符串
                task_dict['status'] = t.status.value
                task_dict['priority'] = t.priority.value
                data[tid] = task_dict
            
            Path(self._persist_path).parent.mkdir(parents=True, exist_ok=True)
            with open(self._persist_path, 'w', encoding='utf-8') as f:
                # YAML 文件头部注释
                f.write("# Sakura Task Tool - 任务持久化文件\n")
                f.write("# 由 TaskManager 自动生成，请勿手动修改\n\n")
                yaml.dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
    
    def _load_if_exists(self):
        """从 YAML 文件加载"""
        if self._persist_path and Path(self._persist_path).exists():
            with open(self._persist_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
            if data:  # YAML 可能返回 None
                for tid, tdata in data.items():
                    self._tasks[tid] = Task(**tdata)
    
    def clear(self):
        """清空所有任务"""
        self._tasks.clear()
        self._persist()


# 全局管理器实例
_manager = TaskManager()


def get_task_manager() -> TaskManager:
    """获取全局任务管理器"""
    return _manager


def set_task_manager(manager: TaskManager):
    """设置全局任务管理器（用于持久化场景）"""
    global _manager
    _manager = manager


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
    
    Examples:
        # 添加任务
        task(action="add", description="分析代码结构", priority="high")
        
        # 开始任务
        task(action="update", task_id="abc123", status="in_progress")
        
        # 完成任务
        task(action="update", task_id="abc123", status="completed")
        
        # 查看任务列表
        task(action="list")
    """
    result = ""
    
    if action == "add":
        if not description:
            return "❌ 错误: 添加任务需要 description 参数"
        t = _manager.add(
            description=description, 
            priority=priority, 
            parent_id=parent_id if parent_id else None
        )
        result = f"✅ 添加任务: [{t.id}] {description}\n\n"
    
    elif action == "update":
        if not task_id:
            return "❌ 错误: 更新任务需要 task_id 参数"
        if not status:
            return "❌ 错误: 更新任务需要 status 参数"
        try:
            t = _manager.update_status(task_id, status)
            result = f"✅ 更新任务: [{t.id}] → {status}\n\n"
        except ValueError as e:
            return f"❌ 错误: {e}"
    
    elif action == "delete":
        if not task_id:
            return "❌ 错误: 删除任务需要 task_id 参数"
        if _manager.delete(task_id):
            result = f"✅ 删除任务: [{task_id}]\n\n"
        else:
            return f"❌ 错误: 任务不存在: {task_id}"
    
    # list 或其他情况，显示任务列表
    return result + _manager.list_formatted()


__all__ = [
    "task",
    "Task",
    "TaskStatus",
    "TaskPriority",
    "TaskManager",
    "get_task_manager",
    "set_task_manager",
]
