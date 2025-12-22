"""
ClaudeCodeAgent - Claude Code 风格的零配置 Agent

特性：
1. 零配置：默认 qwen-plus 模型 + 7 个核心工具
2. 文件状态追踪 (强制读后写)
3. Claude Code 风格系统提示词
4. 可通过 extra_tools 添加自定义工具
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from sakura.agent import Agent
from sakura.models.base import Model
from sakura.tools.function import Function
from .file_state import FileStateTracker


def _load_system_prompt() -> str:
    """从 MD 文件加载系统提示"""
    prompt_path = Path(__file__).parent / "prompts" / "system.md"
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8")
    # 后备默认提示
    return """You are an expert software engineer with access to file system tools.

## CRITICAL RULES
1. **ALWAYS read before write**: You MUST read a file before writing to it.
2. **Use todo for complex tasks**: Break down multi-step tasks into a todo list.
3. **Prefer edit over write**: Use edit() for targeted changes.
"""


def _get_core_tools() -> list:
    """获取 7 个核心工具"""
    from .tools import read, write, edit, todo, bash, glob, grep
    return [read, write, edit, todo, bash, glob, grep]


@dataclass
class ClaudeCodeAgent(Agent):
    """
    Claude Code 风格的零配置 Agent。
    
    继承自 Sakura Agent，增加：
    - 默认 qwen-plus 模型（可覆盖）
    - 内置 7 个核心工具（read/write/edit/todo/bash/glob/grep）
    - 可通过 extra_tools 添加自定义工具
    - FileStateTracker 文件状态追踪
    - Claude Code 风格的默认提示词
    
    Examples:
        # 零配置，开箱即用
        from sakura.claude_code import ClaudeCodeAgent
        
        agent = ClaudeCodeAgent()
        result = agent.run("帮我重构 utils.py")
        
        # 自定义模型
        agent = ClaudeCodeAgent(model="gpt-4")
        
        # 添加额外工具
        agent = ClaudeCodeAgent(extra_tools=[my_custom_tool])
    """
    
    # 默认模型（用户可覆盖）
    model: Union[str, Model] = "qwen-plus"
    
    # 额外自定义工具（核心工具始终包含）
    extra_tools: List[Callable] = field(default_factory=list)
    
    # 文件状态追踪器
    file_state: FileStateTracker = field(default_factory=FileStateTracker)
    
    # 是否强制读后写
    strict_read_before_write: bool = True
    
    # 调试模式
    debug: bool = False
    
    def __post_init__(self):
        """初始化后处理"""
        # 1. 合并核心工具 + 额外工具
        core_tools = _get_core_tools()
        all_tools = core_tools + list(self.extra_tools)
        
        # 2. 设置工具（覆盖父类的空列表）
        self.tools = all_tools
        
        # 3. 设置系统提示（如果用户没有自定义）
        if self.system_prompt is None:
            self.system_prompt = _load_system_prompt()
        
        # 4. 调用父类初始化
        super().__post_init__()
        
        # 5. 注入 file_state 到支持的工具
        self._inject_file_state()
    
    def _inject_file_state(self) -> None:
        """将 file_state 注入到工具的全局注册表"""
        try:
            from .tools.read import set_file_state
            set_file_state(self.file_state)
        except ImportError:
            pass
    
    def add_tool(self, tool: Union[Function, Callable]) -> None:
        """添加工具并注入 file_state"""
        super().add_tool(tool)
        self._inject_file_state()
    
    def get_file_state(self) -> FileStateTracker:
        """获取文件状态追踪器"""
        return self.file_state
    
    def clear_file_state(self) -> None:
        """清除文件状态"""
        self.file_state.clear()

