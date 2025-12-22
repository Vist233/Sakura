"""Builtin tools"""

from .shell import ShellTools
from .python import PythonTools
from .search import DuckDuckGoTools
from .file import FileTools
from .task import task, TaskManager, Task, TaskStatus, TaskPriority, get_task_manager, set_task_manager

# Lazy import for optional dependencies
def __getattr__(name):
    if name == "BaiduSearchTools":
        from .baidu_search import BaiduSearchTools
        return BaiduSearchTools
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "ShellTools", 
    "PythonTools", 
    "DuckDuckGoTools",
    "BaiduSearchTools",
    "FileTools",
    "task",
    "TaskManager",
    "Task",
    "TaskStatus",
    "TaskPriority",
    "get_task_manager",
    "set_task_manager",
]
