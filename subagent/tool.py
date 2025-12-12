"""
Sakura SubAgent Tools - 子 Agent 工具

提供 SubAgent 调用工具函数
"""

import asyncio
from typing import Any, Dict, List, Optional, Union

from .config import SubAgentConfig, get_config_loader
from ..tools.decorator import tool


def _get_model_instance(model_id: str):
    """根据模型 ID 获取模型实例"""
    # 尝试识别模型类型并创建对应实例
    model_id_lower = model_id.lower()
    
    if "qwen" in model_id_lower or "dashscope" in model_id_lower:
        from ..models.qwen import DashScope
        return DashScope(id=model_id)
    elif "kimi" in model_id_lower or "moonshot" in model_id_lower:
        from ..models.kimi import Kimi
        return Kimi(id=model_id)
    elif "gpt" in model_id_lower or "openai" in model_id_lower:
        from ..models.openai import OpenAIChat
        return OpenAIChat(id=model_id)
    elif "claude" in model_id_lower or "anthropic" in model_id_lower:
        try:
            from ..models.claude import Claude
            return Claude(id=model_id)
        except ImportError:
            pass
    
    # 默认使用 DashScope（Qwen）
    from ..models.qwen import DashScope
    return DashScope(id=model_id)


def _resolve_tools(tool_names: List[str]) -> List:
    """
    解析工具名称列表为工具实例
    
    Args:
        tool_names: 工具名称列表
    
    Returns:
        工具实例列表
    """
    resolved = []
    
    # 内置工具映射
    builtin_tools = {}
    
    # 尝试加载内置工具
    try:
        from ..tools.builtin.file import read_file, write_file
        builtin_tools["read_file"] = read_file
        builtin_tools["write_file"] = write_file
    except ImportError:
        pass
    
    try:
        from ..tools.builtin.python import python_exec
        builtin_tools["python_exec"] = python_exec
        builtin_tools["python"] = python_exec
    except ImportError:
        pass
    
    try:
        from ..tools.builtin.shell import shell
        builtin_tools["shell"] = shell
        builtin_tools["shell_exec"] = shell
    except ImportError:
        pass
    
    try:
        from ..tools.builtin.search import search_web
        builtin_tools["search_web"] = search_web
        builtin_tools["search"] = search_web
    except ImportError:
        pass
    
    try:
        from ..tools.builtin.task import task
        builtin_tools["task"] = task
    except ImportError:
        pass
    
    # 解析每个工具名称
    for name in tool_names:
        name = name.strip().lower()
        if name in builtin_tools:
            resolved.append(builtin_tools[name])
    
    return resolved


@tool
def subagent(
    prompt: str,
    config: str = "general_purpose",
    context: str = ""
) -> str:
    """
    创建子 Agent 执行专门任务。
    
    SubAgent 是具有特定专业能力的独立 Agent，拥有自己的系统提示、工具集和消息历史。
    适用于需要专业知识的独立子任务。
    
    可用配置：
    - researcher: 信息研究和分析专家
    - coder: 代码编写和调试专家
    - reviewer: 代码审查和优化建议专家
    - general_purpose: 通用助手
    
    Args:
        prompt: 交给 SubAgent 的任务描述，应该清晰具体
        config: SubAgent 配置名称（不含 .md 后缀）
        context: 额外上下文信息，会在 prompt 前提供给 SubAgent
    
    Returns:
        SubAgent 的执行结果
    
    Examples:
        # 研究任务
        subagent("研究 Python asyncio 的最佳实践", config="researcher")
        
        # 编码任务
        subagent("实现一个线程安全的 LRU 缓存类", config="coder")
        
        # 代码审查
        subagent("审查这段代码的安全性和性能", config="reviewer", context=code_content)
    """
    from ..agent import Agent
    
    # 加载配置
    loader = get_config_loader()
    cfg = loader.load(config)
    
    if not cfg:
        available = loader.list_available()
        available_str = ", ".join(available) if available else "无可用配置"
        return f"错误: SubAgent 配置 '{config}' 未找到。\n可用配置: {available_str}"
    
    # 解析工具
    tools = _resolve_tools(cfg.tools)
    
    # 构建完整提示
    if context:
        full_prompt = f"背景信息:\n{context}\n\n任务:\n{prompt}"
    else:
        full_prompt = prompt
    
    # 获取模型实例
    model = _get_model_instance(cfg.model)
    
    # 创建 SubAgent
    sub = Agent(
        model=model,
        tools=tools,
        system_prompt=cfg.system_prompt,
        max_tool_calls=cfg.max_tool_calls
    )
    
    try:
        # 执行
        result = sub.run(full_prompt)
        content = result.content if hasattr(result, 'content') else str(result)
        return f"[{cfg.name}] 完成\n\n{content or '(无输出)'}"
    except Exception as e:
        return f"[{cfg.name}] 执行错误: {str(e)}"


@tool
async def parallel_subagents(
    tasks: List[Dict[str, str]]
) -> str:
    """
    并行执行多个 SubAgent 任务。
    
    当有多个独立任务需要同时处理时使用此工具，可显著提高效率。
    所有任务会并行执行，然后汇总结果。
    
    Args:
        tasks: 任务列表，每个任务是一个字典，包含:
            - prompt: (必需) 任务描述
            - config: (可选) SubAgent 配置名称，默认 "general_purpose"
            - context: (可选) 额外上下文信息
    
    Returns:
        所有 SubAgent 的执行结果汇总
    
    Example:
        parallel_subagents([
            {"prompt": "研究 Redis 缓存策略", "config": "researcher"},
            {"prompt": "研究 Memcached 特点", "config": "researcher"},
            {"prompt": "实现缓存抽象层", "config": "coder"}
        ])
    """
    from ..agent import Agent
    
    loader = get_config_loader()
    
    async def run_one(task: Dict[str, str], index: int) -> str:
        """执行单个任务"""
        config_name = task.get("config", "general_purpose")
        cfg = loader.load(config_name)
        
        if not cfg:
            return f"### 任务 {index + 1} 错误\n\n配置 '{config_name}' 未找到"
        
        # 解析工具
        tools = _resolve_tools(cfg.tools)
        
        # 构建提示
        prompt = task.get("prompt", "")
        if task.get("context"):
            prompt = f"背景:\n{task['context']}\n\n任务:\n{prompt}"
        
        # 获取模型
        model = _get_model_instance(cfg.model)
        
        # 创建 Agent
        sub = Agent(
            model=model,
            tools=tools,
            system_prompt=cfg.system_prompt,
            max_tool_calls=cfg.max_tool_calls
        )
        
        try:
            result = await sub.arun(prompt)
            content = result.content if hasattr(result, 'content') else str(result)
            task_desc = task.get("prompt", "")[:50]
            return f"### [{cfg.name}] {task_desc}...\n\n{content}"
        except Exception as e:
            return f"### [{cfg.name}] 错误\n\n{str(e)}"
    
    # 并行执行所有任务
    results = await asyncio.gather(
        *[run_one(t, i) for i, t in enumerate(tasks)],
        return_exceptions=True
    )
    
    # 格式化输出
    output_parts = ["# 并行 SubAgent 执行结果\n"]
    
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            output_parts.append(f"### 任务 {i + 1} 异常\n\n{str(result)}")
        else:
            output_parts.append(str(result))
    
    return "\n\n---\n\n".join(output_parts)


def create_subagent(
    config: Union[str, SubAgentConfig],
    **overrides
):
    """
    创建 SubAgent 实例（高级用法）
    
    允许直接获取 Agent 实例而不是通过工具调用。
    适用于需要更精细控制的场景。
    
    Args:
        config: 配置名称或 SubAgentConfig 实例
        **overrides: 覆盖配置的参数（model, tools, system_prompt 等）
    
    Returns:
        Agent 实例
    
    Example:
        # 使用配置名创建
        agent = create_subagent("researcher")
        result = agent.run("研究 Python GIL")
        
        # 覆盖部分配置
        agent = create_subagent("coder", model="gpt-4")
    """
    from ..agent import Agent
    
    # 加载配置
    if isinstance(config, str):
        loader = get_config_loader()
        cfg = loader.load(config)
        if not cfg:
            raise ValueError(f"配置 '{config}' 未找到")
    else:
        cfg = config
    
    # 应用覆盖
    model_id = overrides.get("model", cfg.model)
    tool_names = overrides.get("tools", cfg.tools)
    system_prompt = overrides.get("system_prompt", cfg.system_prompt)
    max_tool_calls = overrides.get("max_tool_calls", cfg.max_tool_calls)
    
    # 解析工具
    if isinstance(tool_names, list) and all(isinstance(t, str) for t in tool_names):
        tools = _resolve_tools(tool_names)
    else:
        tools = tool_names  # 假设已经是工具实例
    
    # 获取模型
    model = _get_model_instance(model_id)
    
    # 创建 Agent
    return Agent(
        model=model,
        tools=tools,
        system_prompt=system_prompt,
        max_tool_calls=max_tool_calls
    )
