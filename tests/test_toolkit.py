"""
Tests for Toolkit class

测试 Toolkit 工具包类
"""

import pytest

from sakura.tools.toolkit import Toolkit
from sakura.tools.function import Function


class TestToolkit:
    """Toolkit 类测试"""
    
    def test_toolkit_creation_default(self):
        """测试默认创建"""
        toolkit = Toolkit()
        
        assert toolkit.name == "Toolkit"
        assert toolkit.get_functions() == []
    
    def test_toolkit_creation_with_name(self):
        """测试带名称创建"""
        toolkit = Toolkit(name="MyToolkit")
        
        assert toolkit.name == "MyToolkit"
    
    def test_toolkit_creation_with_tools(self):
        """测试带工具列表创建"""
        def tool_a(x: int) -> int:
            """Tool A"""
            return x
        
        def tool_b(y: str) -> str:
            """Tool B"""
            return y
        
        toolkit = Toolkit(name="TestKit", tools=[tool_a, tool_b])
        
        assert len(toolkit.get_functions()) == 2
    
    def test_toolkit_register_decorator(self):
        """测试注册装饰器"""
        toolkit = Toolkit()
        
        @toolkit.register()
        def my_tool(x: int) -> int:
            """My tool"""
            return x * 2
        
        funcs = toolkit.get_functions()
        assert len(funcs) == 1
        assert funcs[0].name == "my_tool"
    
    def test_toolkit_register_with_custom_name(self):
        """测试自定义名称注册"""
        toolkit = Toolkit()
        
        @toolkit.register(name="custom_name")
        def original_name(x: int) -> int:
            """A tool"""
            return x
        
        func = toolkit.get_function("custom_name")
        assert func is not None
        assert func.name == "custom_name"
    
    def test_toolkit_register_with_description(self):
        """测试自定义描述注册"""
        toolkit = Toolkit()
        
        @toolkit.register(description="Custom description")
        def described_tool(x: str) -> str:
            """Original docstring"""
            return x
        
        func = toolkit.get_function("described_tool")
        assert func.description == "Custom description"
    
    def test_toolkit_add_function(self):
        """测试添加函数"""
        toolkit = Toolkit()
        
        def standalone_tool(x: int) -> int:
            """Standalone tool"""
            return x
        
        func = Function.from_callable(standalone_tool)
        toolkit.add_function(func)
        
        assert toolkit.get_function("standalone_tool") is not None
    
    def test_toolkit_get_function_exists(self, sample_toolkit):
        """测试获取存在的函数"""
        func = sample_toolkit.get_function("add")
        
        assert func is not None
        assert func.name == "add"
    
    def test_toolkit_get_function_not_exists(self, sample_toolkit):
        """测试获取不存在的函数"""
        func = sample_toolkit.get_function("nonexistent")
        
        assert func is None
    
    def test_toolkit_get_functions(self, sample_toolkit):
        """测试获取所有函数"""
        funcs = sample_toolkit.get_functions()
        
        assert len(funcs) == 2
        names = [f.name for f in funcs]
        assert "add" in names
        assert "multiply" in names
    
    def test_toolkit_functions_property(self, sample_toolkit):
        """测试 functions 属性"""
        funcs = sample_toolkit.functions
        
        assert len(funcs) == 2
        assert isinstance(funcs, list)
        assert all(isinstance(f, Function) for f in funcs)
    
    def test_toolkit_multiple_registrations(self):
        """测试多次注册"""
        toolkit = Toolkit()
        
        @toolkit.register()
        def func1(a: int) -> int:
            """Function 1"""
            return a
        
        @toolkit.register()
        def func2(b: str) -> str:
            """Function 2"""
            return b
        
        @toolkit.register()
        def func3(c: float) -> float:
            """Function 3"""
            return c
        
        assert len(toolkit.get_functions()) == 3
    
    def test_toolkit_overwrite_function(self):
        """测试覆盖函数"""
        toolkit = Toolkit()
        
        @toolkit.register()
        def my_func(x: int) -> int:
            """First version"""
            return x
        
        # 再次注册同名函数
        @toolkit.register(name="my_func")
        def another_func(x: int) -> int:
            """Second version"""
            return x * 2
        
        # 应该只有一个函数
        assert len([f for f in toolkit.get_functions() if f.name == "my_func"]) == 1


class TestToolkitIntegration:
    """Toolkit 集成测试"""
    
    def test_toolkit_function_execution(self):
        """测试工具包函数执行"""
        toolkit = Toolkit()
        
        @toolkit.register()
        def calculate(a: int, b: int) -> int:
            """Calculate sum"""
            return a + b
        
        func = toolkit.get_function("calculate")
        result = func.entrypoint(a=5, b=3)
        
        assert result == 8
    
    def test_toolkit_with_async_function(self):
        """测试异步函数"""
        toolkit = Toolkit()
        
        @toolkit.register()
        async def async_process(data: str) -> str:
            """Async processing"""
            return f"Processed: {data}"
        
        func = toolkit.get_function("async_process")
        assert func is not None
    
    def test_toolkit_inheritance_pattern(self):
        """测试工具包继承模式"""
        class MathToolkit(Toolkit):
            def __init__(self):
                super().__init__(name="MathToolkit")
                
                # 在初始化时注册工具
                @self.register()
                def add(a: int, b: int) -> int:
                    """Add two numbers"""
                    return a + b
                
                @self.register()
                def subtract(a: int, b: int) -> int:
                    """Subtract two numbers"""
                    return a - b
        
        math_kit = MathToolkit()
        
        assert math_kit.name == "MathToolkit"
        assert len(math_kit.get_functions()) == 2
