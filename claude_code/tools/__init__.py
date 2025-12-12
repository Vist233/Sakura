# Claude Code 工具集

"""
Claude Code 专用工具，按官方设计实现：
- read: 读取文件并记录状态
- write: 写入文件（强制读取验证）
- edit: 基于 diff 的文件编辑（支持 replace_all）
- todo: 任务管理（TodoWrite）
- bash: 命令执行（带安全限制）
- glob: 文件模式搜索
- grep: 内容搜索
"""

from .read import read, set_file_state, get_file_state
from .write import write
from .edit import edit
from .todo import todo, get_todos, clear_todos
from .bash import bash
from .glob import glob
from .grep import grep

__all__ = [
    "read", "write", "edit", "todo", "bash", "glob", "grep",
    "set_file_state", "get_file_state", "get_todos", "clear_todos"
]
