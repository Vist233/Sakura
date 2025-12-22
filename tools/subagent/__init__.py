"""
Sakura SubAgent - 子 Agent 编排模块

提供 SubAgent 配置、创建和调用功能，支持：
- 单 SubAgent 调用
- 并行多 SubAgent 执行
- Markdown 配置文件驱动

Usage:
    from sakura.tools.subagent import subagent, parallel_subagents, SubAgentConfig
    
    # 单个调用
    result = subagent("研究 Python 异步编程", config="researcher")
    
    # 并行调用
    results = await parallel_subagents([
        {"prompt": "研究 Redis", "config": "researcher"},
        {"prompt": "实现缓存", "config": "coder"}
    ])
"""

from .config import (
    SubAgentConfig,
    SubAgentConfigLoader,
    get_config_loader,
)
from .tool import (
    subagent,
    parallel_subagents,
    create_subagent,
)

__all__ = [
    # 配置类
    "SubAgentConfig",
    "SubAgentConfigLoader",
    "get_config_loader",
    # 工具函数
    "subagent",
    "parallel_subagents",
    "create_subagent",
]
