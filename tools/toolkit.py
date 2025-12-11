"""
Sakura Toolkit - 工具包基类

提供工具包的基础功能
"""

from typing import Any, Callable, Dict, List, Optional
from ..tools.function import Function


class Toolkit:
    """
    工具包基类
    
    用于组织相关工具的集合
    """
    
    def __init__(self, name: str = "", tools: Optional[List[Callable]] = None, **kwargs):
        self.name = name or self.__class__.__name__
        self._functions: Dict[str, Function] = {}
        
        # 注册传入的工具
        if tools:
            for tool_func in tools:
                if callable(tool_func):
                    func = Function.from_callable(tool_func)
                    self._functions[func.name] = func
    
    def register(
        self, 
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Callable:
        """
        装饰器：注册工具函数到工具包
        
        Usage:
            toolkit = Toolkit()
            
            @toolkit.register()
            def my_tool(arg: str) -> str:
                return f"Result: {arg}"
        """
        def decorator(func: Callable) -> Function:
            tool_name = name or func.__name__
            tool = Function.from_callable(func, name=tool_name)
            if description:
                tool.description = description
            self._functions[tool_name] = tool
            return tool
        return decorator
    
    def add_function(self, func: Function) -> None:
        """添加函数到工具包"""
        self._functions[func.name] = func
    
    def get_function(self, name: str) -> Optional[Function]:
        """获取函数"""
        return self._functions.get(name)
    
    def get_functions(self) -> List[Function]:
        """获取所有函数"""
        return list(self._functions.values())
    
    @property
    def functions(self) -> List[Function]:
        """获取所有函数"""
        return self.get_functions()
