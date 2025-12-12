"""
FileStateTracker - Claude Code 的核心安全机制

追踪已读文件状态，实现"强制读后写"验证：
1. Read 工具更新 state (使用逻辑时间)
2. Write/Edit 工具验证 state，写入后用文件系统时间更新
3. 未读文件不允许写入
4. 文件被外部修改后需要重新读取
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional, Tuple
import os
import time


@dataclass
class FileState:
    """单个文件的状态"""
    content: str           # 文件内容
    timestamp: float       # 读取时的时间戳


@dataclass
class FileStateTracker:
    """
    文件状态追踪器 - Claude Code 的安全核心。
    
    这是 Claude Code 能够安全编辑文件的关键：
    - 防止写入未读取的文件（避免盲写）
    - 检测文件被外部修改（避免覆盖用户/linter 修改）
    - 维护文件内容缓存（支持 diff-based 编辑）
    
    Examples:
        tracker = FileStateTracker()
        
        # 读取时记录
        tracker.record_read("/path/to/file.py", content)
        
        # 写入前验证
        valid, error = tracker.validate_for_write("/path/to/file.py")
        if not valid:
            print(f"Cannot write: {error}")
        
        # 写入后更新
        tracker.record_write("/path/to/file.py", new_content)
    """
    
    _state: Dict[str, FileState] = field(default_factory=dict)
    
    def record_read(self, path: str, content: str) -> None:
        """
        记录文件读取。
        
        Args:
            path: 文件路径（将被规范化为绝对路径）
            content: 文件内容
        """
        abs_path = str(Path(path).resolve())
        self._state[abs_path] = FileState(
            content=content,
            timestamp=time.time()  # 使用逻辑时间
        )
    
    def record_write(self, path: str, content: str) -> None:
        """
        记录文件写入。
        
        写入后使用文件系统的 mtime 而非逻辑时间，
        这样可以检测到后续的外部修改。
        
        Args:
            path: 文件路径
            content: 写入的内容
        """
        abs_path = str(Path(path).resolve())
        try:
            mtime = os.path.getmtime(abs_path)
        except OSError:
            mtime = time.time()
        
        self._state[abs_path] = FileState(
            content=content,
            timestamp=mtime
        )
    
    def validate_for_write(self, path: str) -> Tuple[bool, str]:
        """
        验证文件是否可以写入。
        
        这是 Claude Code "强制读后写" 机制的核心：
        1. 文件必须先被读取过
        2. 文件自读取后不能被外部修改
        
        Args:
            path: 要写入的文件路径
        
        Returns:
            (is_valid, error_message)
            - is_valid: True 如果可以写入
            - error_message: 如果不可写入，描述原因
        """
        abs_path = str(Path(path).resolve())
        
        # 新文件可以直接写入
        if not Path(abs_path).exists():
            return True, ""
        
        # 检查 1: 文件是否被读取过
        if abs_path not in self._state:
            return False, "File has not been read yet. Read it first before writing to it."
        
        # 检查 2: 文件是否被外部修改
        current_mtime = os.path.getmtime(abs_path)
        if current_mtime > self._state[abs_path].timestamp:
            return False, (
                "File has been modified since read, either by the user or by a linter. "
                "Read it again before attempting to write it."
            )
        
        return True, ""
    
    def get_content(self, path: str) -> Optional[str]:
        """
        获取已读取的文件内容。
        
        用于 diff-based 编辑（edit 工具）。
        
        Args:
            path: 文件路径
        
        Returns:
            文件内容，如果未读取过则返回 None
        """
        abs_path = str(Path(path).resolve())
        state = self._state.get(abs_path)
        return state.content if state else None
    
    def has_read(self, path: str) -> bool:
        """检查文件是否已被读取"""
        abs_path = str(Path(path).resolve())
        return abs_path in self._state
    
    def clear(self) -> None:
        """清除所有状态"""
        self._state.clear()
    
    def __len__(self) -> int:
        """返回已追踪的文件数量"""
        return len(self._state)
