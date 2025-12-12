# Claude Code 模式

"""
Sakura Claude Code 模式 - 复刻 Claude Code 的核心能力。

核心特性：
1. FileStateTracker - 强制读后写机制
2. ClaudeCodeAgent - 增强版 Agent
3. 专用工具集 (read/write/edit/bash)

使用示例:
    from sakura.claude_code import ClaudeCodeAgent
    from sakura.claude_code.tools import read, write, edit
    
    agent = ClaudeCodeAgent(
        model="qwen-plus",
        tools=[read, write, edit]
    )
    
    result = agent.run("重构 utils.py")
"""

from .file_state import FileStateTracker
from .agent import ClaudeCodeAgent

__all__ = [
    "FileStateTracker",
    "ClaudeCodeAgent",
]
