"""
Agent - 统一的 Agent 核心类

这是 Sakura 的核心类，整合了：
- 模型调用
- 工具管理
- 消息处理

Usage:
    from sakura import Agent
    from sakura.models import Qwen
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

import json
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Type, Union
from pydantic import BaseModel

from .models.base import Model
from .messages.message import Message
from .messages.response import ModelResponse
from .tools.function import Function


@dataclass
class Agent:
    """
    统一的 Agent 类 - 整合模型调用、工具管理和消息处理
    
    Args:
        model: 模型实例或模型名称字符串
        tools: 工具列表，可以是 Function 对象或普通函数
        system_prompt: 系统提示词
        instructions: 额外的指令列表
        output_schema: 输出结构化模型（Pydantic BaseModel）
        enable_monitoring: 是否启用监控
        db_path: 监控数据库路径
        max_tool_calls: 最大工具调用次数
        tool_choice: 工具选择策略 ("auto", "none", 或指定工具)
    """
    
    # 模型配置
    model: Union[str, Model] = None  # type: ignore
    
    # 工具配置
    tools: List[Union[Function, Callable]] = field(default_factory=list)
    
    # 提示词配置
    system_prompt: Optional[str] = None
    instructions: Optional[List[str]] = None
    
    # 输出配置
    output_schema: Optional[Type[BaseModel]] = None
    
    # 运行配置
    max_tool_calls: int = 10
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
    
    # 并行执行配置
    parallel_tools: bool = True           # 是否启用并行工具执行
    max_parallel_workers: int = 5         # 最大并行数
    parallel_timeout: float = 30.0        # 单个工具超时时间（秒）
    
    # 内部状态
    _model: Optional[Model] = field(default=None, repr=False, init=False)
    _functions: Dict[str, Function] = field(default_factory=dict, repr=False, init=False)
    _tool_schemas_cache: Optional[List[Dict[str, Any]]] = field(default=None, repr=False, init=False)
    
    def __post_init__(self):
        """初始化后处理"""
        # 解析模型
        self._model = self._resolve_model(self.model)
        
        # 解析工具
        self._functions = self._parse_tools(self.tools)
        
        # 预编译工具 Schema（始终缓存，避免重复序列化）
        self._tool_schemas_cache = [func.to_dict() for func in self._functions.values()]
    
    def _resolve_model(self, model: Union[str, Model]) -> Model:
        """
        解析模型配置
        
        支持:
        - Model 对象直接使用
        - 字符串映射到默认模型
        """
        # Check if it's already a Model instance (has id and invoke method)
        if hasattr(model, 'id') and hasattr(model, 'invoke'):
            return model  # type: ignore
        
        if isinstance(model, str):
            # 根据字符串创建模型
            model_lower = model.lower()
            
            # Qwen 模型
            if "qwen" in model_lower or "dashscope" in model_lower:
                from .models.qwen import DashScope
                return DashScope(id=model)
            
            # Kimi 模型
            if "kimi" in model_lower or "moonshot" in model_lower:
                from .models.kimi import Kimi
                return Kimi(id=model)
            
            # Claude 模型
            if "claude" in model_lower:
                from .models.claude import Claude
                return Claude(id=model)
            
            # OpenRouter 模型
            if "openrouter" in model_lower or "/" in model:
                from .models.openrouter import OpenRouter
                return OpenRouter(id=model)
            
            # 默认使用 OpenAI
            from .models.openai import OpenAIChat
            return OpenAIChat(id=model)
        
        raise ValueError(f"无法解析模型配置: {model}")
    
    def _parse_tools(self, tools: List[Union[Function, Callable]]) -> Dict[str, Function]:
        """
        解析工具列表，将普通函数转换为 Function 对象
        """
        functions = {}
        
        for tool in tools:
            if isinstance(tool, Function):
                functions[tool.name] = tool
            elif callable(tool):
                # 检查是否已经被 @tool 装饰器处理过
                if hasattr(tool, 'name') and hasattr(tool, 'to_dict'):
                    # 这是一个 Function 对象
                    functions[tool.name] = tool
                else:
                    # 普通函数，需要转换
                    func = Function.from_callable(tool)
                    functions[func.name] = func
            else:
                raise ValueError(f"无效的工具类型: {type(tool)}")
        
        return functions
    
    def _build_messages(
        self, 
        prompt: str,
        messages: Optional[List[Message]] = None,
    ) -> List[Message]:
        """
        构建消息列表
        
        包含:
        - 系统消息（system_prompt + instructions）
        - 历史消息
        - 当前用户消息
        """
        result = []
        
        # 构建系统消息
        system_content = self._build_system_message()
        if system_content:
            result.append(Message(role="system", content=system_content))
        
        # 添加历史消息
        if messages:
            # 浅拷贝：直接 extend 列表，Message 对象本身不可变（约定）
            result.extend(messages)
        
        # 添加当前用户消息
        result.append(Message(role="user", content=prompt))
        
        return result
    
    def _build_system_message(self) -> Optional[str]:
        """构建系统消息内容"""
        parts = []
        
        if self.system_prompt:
            parts.append(self.system_prompt)
        
        if self.instructions:
            parts.append("\n".join(f"- {i}" for i in self.instructions))
        
        return "\n\n".join(parts) if parts else None
    
    def _get_tool_dicts(self) -> List[Dict[str, Any]]:
        """获取工具定义列表（OpenAI 格式）"""
        # 如果有缓存，直接返回
        if self._tool_schemas_cache is not None:
            return self._tool_schemas_cache
            
        return [func.to_dict() for func in self._functions.values()]
    
    def _execute_tool_call(
        self, 
        tool_name: str, 
        tool_args: Dict[str, Any],
        tool_call_id: str,
    ) -> Message:
        """
        执行单个工具调用
        
        工具执行失败时，返回错误信息给模型（不抛出异常）
        """
        if tool_name not in self._functions:
            return Message(
                role="tool",
                content=f"Error: Unknown tool '{tool_name}'",
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_call_error=True,
            )
        
        func = self._functions[tool_name]
        
        try:
            # 执行工具
            result = func.entrypoint(**tool_args)
            
            # 格式化结果
            if isinstance(result, str):
                content = result
            elif isinstance(result, (dict, list)):
                content = json.dumps(result, ensure_ascii=False, indent=2)
            else:
                content = str(result)
            
            return Message(
                role="tool",
                content=content,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_args=tool_args,
            )
            
        except Exception as e:
            # 工具执行失败，返回错误信息给模型
            return Message(
                role="tool",
                content=f"Error executing {tool_name}: {str(e)}",
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_args=tool_args,
                tool_call_error=True,
            )
    
    async def _aexecute_tool_call(
        self, 
        tool_name: str, 
        tool_args: Dict[str, Any],
        tool_call_id: str,
    ) -> Message:
        """
        异步执行单个工具调用
        """
        import asyncio
        
        if tool_name not in self._functions:
            return Message(
                role="tool",
                content=f"Error: Unknown tool '{tool_name}'",
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_call_error=True,
            )
        
        func = self._functions[tool_name]
        
        try:
            # 执行工具（支持异步）
            if asyncio.iscoroutinefunction(func.entrypoint):
                result = await func.entrypoint(**tool_args)
            else:
                result = func.entrypoint(**tool_args)
            
            # 格式化结果
            if isinstance(result, str):
                content = result
            elif isinstance(result, (dict, list)):
                content = json.dumps(result, ensure_ascii=False, indent=2)
            else:
                content = str(result)
            
            return Message(
                role="tool",
                content=content,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_args=tool_args,
            )
            
        except Exception as e:
            return Message(
                role="tool",
                content=f"Error executing {tool_name}: {str(e)}",
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                tool_args=tool_args,
                tool_call_error=True,
            )
    
    def run(
        self, 
        prompt: str,
        messages: Optional[List[Message]] = None,
        **kwargs,
    ) -> ModelResponse:
        """
        同步运行 Agent
        
        Args:
            prompt: 用户输入
            messages: 历史消息
            **kwargs: 传递给模型的额外参数
        
        Returns:
            ModelResponse: 模型响应
        """
        start_time = perf_counter()
        
        # 构建消息
        all_messages = self._build_messages(prompt, messages)
        
        # 获取工具列表
        tools = list(self._functions.values()) if self._functions else None
        
        # 使用模型的 response 方法（包含完整的工具调用循环）
        response = self._model.response(
            messages=all_messages,
            tools=tools,
            tool_choice=self.tool_choice,
            tool_call_limit=self.max_tool_calls,
            response_format=self.output_schema,
            **kwargs,
        )
        
        return response
    
    async def arun(
        self, 
        prompt: str,
        messages: Optional[List[Message]] = None,
        **kwargs,
    ) -> ModelResponse:
        """
        异步运行 Agent
        
        Args:
            prompt: 用户输入
            messages: 历史消息
            **kwargs: 传递给模型的额外参数
        
        Returns:
            ModelResponse: 模型响应
        """
        start_time = perf_counter()
        
        # 构建消息
        all_messages = self._build_messages(prompt, messages)
        
        # 获取工具列表
        tools = list(self._functions.values()) if self._functions else None
        
        # 使用模型的 aresponse 方法
        response = await self._model.aresponse(
            messages=all_messages,
            tools=tools,
            tool_choice=self.tool_choice,
            tool_call_limit=self.max_tool_calls,
            response_format=self.output_schema,
            **kwargs,
        )
        
        return response
    
    async def stream(
        self, 
        prompt: str,
        messages: Optional[List[Message]] = None,
        **kwargs,
    ) -> AsyncIterator[ModelResponse]:
        """
        流式运行 Agent
        
        Args:
            prompt: 用户输入
            messages: 历史消息
            **kwargs: 传递给模型的额外参数
        
        Yields:
            ModelResponse: 流式响应块
        """
        # 构建消息
        all_messages = self._build_messages(prompt, messages)
        
        # 获取工具列表
        tools = list(self._functions.values()) if self._functions else None
        
        # 使用模型的 response_stream 方法
        async for chunk in self._model.response_stream(
            messages=all_messages,
            tools=tools,
            tool_choice=self.tool_choice,
            tool_call_limit=self.max_tool_calls,
            response_format=self.output_schema,
            **kwargs,
        ):
            yield chunk
    
    def chat(
        self,
        prompt: str,
        messages: Optional[List[Message]] = None,
    ) -> str:
        """
        简化的同步聊天接口
        
        Args:
            prompt: 用户输入
            messages: 历史消息
        
        Returns:
            str: 模型回复内容
        """
        response = self.run(prompt, messages)
        return response.content if response.content else ""
    
    async def achat(
        self,
        prompt: str,
        messages: Optional[List[Message]] = None,
    ) -> str:
        """
        简化的异步聊天接口
        
        Args:
            prompt: 用户输入
            messages: 历史消息
        
        Returns:
            str: 模型回复内容
        """
        response = await self.arun(prompt, messages)
        return response.content if response.content else ""
    
    def add_tool(self, tool: Union[Function, Callable]) -> None:
        """动态添加工具"""
        if isinstance(tool, Function):
            self._functions[tool.name] = tool
        elif callable(tool):
            if hasattr(tool, 'name') and hasattr(tool, 'to_dict'):
                self._functions[tool.name] = tool
            else:
                func = Function.from_callable(tool)
                self._functions[func.name] = func
        else:
            raise ValueError(f"无效的工具类型: {type(tool)}")
    
    def remove_tool(self, name: str) -> bool:
        """移除工具，返回是否成功"""
        if name in self._functions:
            del self._functions[name]
            return True
        return False
    
    @property
    def tool_names(self) -> List[str]:
        """获取所有工具名称"""
        return list(self._functions.keys())
