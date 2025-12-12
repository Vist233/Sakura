"""
ClaudeCodeAgent - Claude Code 风格的增强版 Agent

特性：
1. 文件状态追踪 (强制读后写)
2. 工具自动注入状态追踪器
3. Claude Code 风格系统提示词
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from sakura.agent import Agent
from sakura.models.base import Model
from sakura.tools.function import Function
from .file_state import FileStateTracker


# 默认系统提示词
DEFAULT_SYSTEM_PROMPT = """You are an expert software engineer with access to file system tools.

## CRITICAL RULES

1. **ALWAYS read before write**: You MUST read a file before writing to it.
2. **Verify changes**: After writing, read the file again to verify.
3. **Use task tool**: For complex tasks, break them into steps with the task tool.

## WORKFLOW

1. Understand the request
2. Create task list for complex work  
3. Read relevant files
4. Make changes
5. Verify changes
6. Update task status
"""


@dataclass
class ClaudeCodeAgent(Agent):
    """
    Claude Code 风格的 Agent。
    
    继承自 Sakura Agent，增加：
    - FileStateTracker 文件状态追踪
    - 强制读后写验证
    - Claude Code 风格的默认提示词
    
    Examples:
        from sakura.claude_code import ClaudeCodeAgent
        from sakura.claude_code.tools import read, write, edit
        
        agent = ClaudeCodeAgent(
            model="qwen-plus",
            tools=[read, write, edit]
        )
        
        result = agent.run("帮我重构 utils.py")
    """
    
    # 新增：文件状态追踪器
    file_state: FileStateTracker = field(default_factory=FileStateTracker)
    
    # 新增：是否强制读后写
    strict_read_before_write: bool = True
    
    # 覆盖默认系统提示词
    system_prompt: Optional[str] = DEFAULT_SYSTEM_PROMPT
    
    def __post_init__(self):
        """初始化后处理"""
        # 调用父类初始化
        super().__post_init__()
        
        # 注入 file_state 到支持的工具
        self._inject_file_state()
    
    def _inject_file_state(self) -> None:
        """将 file_state 注入到工具的全局注册表"""
        # 使用工具模块的 set_file_state 函数
        try:
            from .tools.read import set_file_state
            set_file_state(self.file_state)
        except ImportError:
            pass
    
    def add_tool(self, tool: Union[Function, callable]) -> None:
        """添加工具并注入 file_state"""
        super().add_tool(tool)
        # 重新注入
        self._inject_file_state()
    
    def get_file_state(self) -> FileStateTracker:
        """获取文件状态追踪器"""
        return self.file_state
    
    def clear_file_state(self) -> None:
        """清除文件状态"""
        self.file_state.clear()
