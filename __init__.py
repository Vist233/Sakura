"""
Sakura - 自研 Agent 框架

提供：
- 统一的 Agent 类
- 多厂商模型支持（OpenAI、Qwen、Kimi、Claude、OpenRouter）
- 装饰器监控（@timer, @monitor）
- 多数据库支持（SQLite、PostgreSQL、MySQL）

Usage:
    from sakura import Agent
    from sakura.models import Qwen, Kimi, Claude
    from sakura.tools import tool
    
    @tool
    def search(query: str) -> str:
        '''搜索网络'''
        pass
    
    agent = Agent(
        model=Qwen(id="qwen-plus"),
        tools=[search],
        system_prompt="你是一个助手"
    )
    
    response = agent.run("你好")
"""

from .agent import Agent
from .models import Qwen, Kimi, Claude, OpenRouter, OpenAI
from .tools.decorator import tool
from .claude_code import ClaudeCodeAgent
from .memory import SmartCompressor

__all__ = [
    "Agent",
    "Qwen",
    "Kimi", 
    "Claude",
    "OpenRouter",
    "OpenAI",
    "tool",
    "ClaudeCodeAgent",
    "SmartCompressor",
]

__version__ = "0.2.0"
