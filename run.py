"""
Sakura Run Context - 运行时上下文

定义 Agent 运行时使用的上下文和输出类型
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Type, Union
from pydantic import BaseModel


class RunState(str, Enum):
    """运行状态"""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class RunContext:
    """
    Agent 运行上下文
    
    提供运行时信息和状态存储
    """
    
    # 运行 ID
    run_id: Optional[str] = None
    # 会话 ID
    session_id: Optional[str] = None
    # 用户 ID
    user_id: Optional[str] = None
    # 运行状态
    state: RunState = RunState.PENDING
    # 会话状态（持久化数据）
    session_state: Dict[str, Any] = field(default_factory=dict)
    # 运行时数据（临时数据）
    run_data: Dict[str, Any] = field(default_factory=dict)
    # 依赖注入
    dependencies: Dict[str, Any] = field(default_factory=dict)
    # 元数据
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def get(self, key: str, default: Any = None) -> Any:
        """从会话状态获取值"""
        return self.session_state.get(key, default)
    
    def set(self, key: str, value: Any) -> None:
        """设置会话状态值"""
        self.session_state[key] = value
    
    def update(self, data: Dict[str, Any]) -> None:
        """更新会话状态"""
        self.session_state.update(data)


@dataclass
class RunOutput:
    """
    运行输出
    """
    # 输出内容
    content: Optional[str] = None
    # 结构化输出
    structured_output: Optional[Any] = None
    # 运行状态
    state: RunState = RunState.COMPLETED
    # 错误信息
    error: Optional[str] = None
    # 元数据
    metadata: Dict[str, Any] = field(default_factory=dict)


class RunContentEvent(str, Enum):
    """内容事件类型"""
    CONTENT = "content"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    ERROR = "error"


@dataclass
class RunOutputEvent:
    """运行输出事件"""
    event_type: RunContentEvent
    content: Optional[str] = None
    tool_name: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    tool_result: Optional[Any] = None
    error: Optional[str] = None


@dataclass
class CustomEvent:
    """自定义事件"""
    event_type: str
    data: Any = None


@dataclass
class RunRequirement:
    """运行需求"""
    name: str
    description: Optional[str] = None
    required: bool = True
    default: Any = None


@dataclass
class TeamRunOutput:
    """团队运行输出"""
    outputs: List[RunOutput] = field(default_factory=list)
    combined_content: Optional[str] = None


class TeamRunOutputEvent:
    """团队运行输出事件"""
    pass


class WorkflowRunOutputEvent:
    """工作流运行输出事件"""
    pass


class WorkflowCompletedEvent:
    """工作流完成事件"""
    pass


@dataclass
class ToolResult:
    """工具执行结果"""
    success: bool
    result: Any = None
    error: Optional[str] = None
