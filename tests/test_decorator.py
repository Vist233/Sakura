"""
Tests for @tool decorator

测试 @tool 装饰器的各种使用场景
"""

import pytest
import asyncio
import inspect

from sakura.tools.decorator import tool
from sakura.tools.function import Function


class TestToolDecorator:
    """@tool 装饰器测试"""
    
    def test_tool_decorator_basic(self):
        """测试基础装饰器使用"""
        @tool
        def simple_tool(x: int) -> int:
            """A simple tool"""
            return x * 2
        
        # 装饰后应该是 Function 类型
        assert isinstance(simple_tool, Function)
        assert simple_tool.name == "simple_tool"
        assert simple_tool.description == "A simple tool"
    
    def test_tool_decorator_with_name(self):
        """测试带自定义名称的装饰器"""
        @tool(name="custom_tool_name")
        def my_func(x: int) -> int:
            """My function"""
            return x
        
        assert isinstance(my_func, Function)
        assert my_func.name == "custom_tool_name"
    
    def test_tool_decorator_with_description(self):
        """测试带自定义描述的装饰器"""
        @tool(description="Custom description for the tool")
        def another_func(x: str) -> str:
            """Original docstring"""
            return x
        
        assert another_func.description == "Custom description for the tool"
    
    def test_tool_decorator_with_all_params(self):
        """测试带所有参数的装饰器"""
        @tool(
            name="full_config_tool",
            description="A fully configured tool",
            instructions="Use this tool carefully",
            show_result=True,
        )
        def config_func(query: str) -> str:
            """Search query"""
            return f"Result: {query}"
        
        assert config_func.name == "full_config_tool"
        assert config_func.description == "A fully configured tool"
    
    def test_tool_decorator_async_function(self):
        """测试异步函数装饰"""
        @tool
        async def async_tool(message: str) -> str:
            """Async tool"""
            return f"Processed: {message}"
        
        assert isinstance(async_tool, Function)
        assert async_tool.name == "async_tool"
        # 检查入口点是否正确设置
        assert async_tool.entrypoint is not None
    
    def test_tool_preserves_function_signature(self):
        """测试装饰器保留函数签名"""
        @tool
        def typed_tool(
            name: str,
            age: int,
            active: bool = True
        ) -> str:
            """A typed tool"""
            return f"{name}, {age}"
        
        params = typed_tool.parameters.get("properties", {})
        assert "name" in params
        assert "age" in params
        assert "active" in params
        
        required = typed_tool.parameters.get("required", [])
        assert "name" in required
        assert "age" in required
        # active 有默认值，不应该在 required 中
        assert "active" not in required
    
    def test_tool_decorator_with_strict(self):
        """测试 strict 模式"""
        @tool(strict=True)
        def strict_tool(x: int, y: int) -> int:
            """Strict mode tool"""
            return x + y
        
        assert isinstance(strict_tool, Function)
    
    def test_tool_decorator_callable_after_decoration(self):
        """测试装饰后函数仍可调用"""
        @tool
        def callable_tool(a: int, b: int) -> int:
            """Add two numbers"""
            return a + b
        
        # Function 对象应该有 entrypoint 可以调用
        assert callable_tool.entrypoint is not None
        result = callable_tool.entrypoint(a=1, b=2)
        assert result == 3
    
    @pytest.mark.asyncio
    async def test_tool_decorator_async_callable(self):
        """测试异步装饰后函数仍可调用"""
        @tool
        async def async_callable(value: int) -> int:
            """Async double"""
            return value * 2
        
        # 异步函数应该能正常调用
        assert async_callable.entrypoint is not None
        result = await async_callable.entrypoint(value=5)
        assert result == 10
    
    def test_tool_with_complex_types(self):
        """测试复杂类型参数"""
        from typing import List, Optional, Dict
        
        @tool
        def complex_tool(
            items: List[str],
            metadata: Optional[Dict[str, str]] = None
        ) -> str:
            """Tool with complex types"""
            return str(items)
        
        assert isinstance(complex_tool, Function)
        params = complex_tool.parameters.get("properties", {})
        assert "items" in params
        assert "metadata" in params


class TestToolDecoratorEdgeCases:
    """@tool 装饰器边界情况测试"""
    
    def test_tool_no_docstring(self):
        """测试没有 docstring 的函数"""
        @tool
        def no_doc(x: int) -> int:
            return x
        
        assert isinstance(no_doc, Function)
        # 应该有默认的或空的描述
    
    def test_tool_no_return_type(self):
        """测试没有返回类型注解的函数"""
        @tool
        def no_return(x: int):
            """No return type"""
            return x * 2
        
        assert isinstance(no_return, Function)
    
    def test_tool_no_params(self):
        """测试无参数的函数"""
        @tool
        def no_params() -> str:
            """No parameters"""
            return "Hello"
        
        assert isinstance(no_params, Function)
        assert no_params.parameters.get("properties", {}) == {} or not no_params.parameters.get("required")
    
    def test_multiple_tools_independent(self):
        """测试多个工具互相独立"""
        @tool
        def tool_a(x: int) -> int:
            """Tool A"""
            return x
        
        @tool
        def tool_b(y: str) -> str:
            """Tool B"""
            return y
        
        assert tool_a.name == "tool_a"
        assert tool_b.name == "tool_b"
        assert tool_a.name != tool_b.name
