"""
Tests for Function and FunctionCall classes

测试 Function 和 FunctionCall 核心类的功能
"""

import pytest
import asyncio
from typing import List, Optional

from sakura.tools.function import Function, FunctionCall, FunctionExecutionResult, UserInputField


class TestFunction:
    """Function 类测试"""
    
    def test_function_from_callable_basic(self):
        """测试从普通函数创建 Function"""
        def greet(name: str) -> str:
            """Say hello to someone"""
            return f"Hello, {name}!"
        
        func = Function.from_callable(greet)
        
        assert func.name == "greet"
        assert func.description == "Say hello to someone"
        assert "name" in func.parameters.get("properties", {})
        assert func.entrypoint is not None
    
    def test_function_from_callable_with_defaults(self):
        """测试带默认参数的函数"""
        def search(query: str, limit: int = 10) -> str:
            """Search for something"""
            return f"Searching: {query}"
        
        func = Function.from_callable(search)
        
        props = func.parameters.get("properties", {})
        assert "query" in props
        assert "limit" in props
        # query 应该是必需的
        assert "query" in func.parameters.get("required", [])
    
    def test_function_from_callable_with_custom_name(self):
        """测试使用自定义名称"""
        def my_func(x: int) -> int:
            """A function"""
            return x * 2
        
        func = Function.from_callable(my_func, name="custom_name")
        
        assert func.name == "custom_name"
    
    def test_function_from_async_callable(self):
        """测试从异步函数创建 Function"""
        async def async_greet(name: str) -> str:
            """Async greeting"""
            return f"Hello, {name}!"
        
        func = Function.from_callable(async_greet)
        
        assert func.name == "async_greet"
        assert func.description == "Async greeting"
    
    def test_function_parameters_extraction(self):
        """测试参数提取"""
        def complex_func(
            name: str,
            age: int,
            active: bool = True,
            tags: Optional[List[str]] = None
        ) -> str:
            """A complex function"""
            return "done"
        
        func = Function.from_callable(complex_func)
        
        props = func.parameters.get("properties", {})
        assert "name" in props
        assert "age" in props
        assert "active" in props
        assert "tags" in props
    
    def test_function_to_dict(self, sample_function):
        """测试 Function 序列化为字典"""
        result = sample_function.to_dict()
        
        assert "name" in result
        assert "description" in result
        assert "parameters" in result
        assert result["name"] == "sample_sync_function"
    
    def test_function_model_copy(self, sample_function):
        """测试 Function 复制"""
        copied = sample_function.model_copy()
        
        assert copied.name == sample_function.name
        assert copied.description == sample_function.description
        assert copied is not sample_function


class TestFunctionCall:
    """FunctionCall 类测试"""
    
    def test_function_call_creation(self, sample_function):
        """测试 FunctionCall 创建"""
        call = FunctionCall(
            function=sample_function,
            arguments={"query": "test", "limit": 5},
            call_id="call_123"
        )
        
        assert call.function.name == "sample_sync_function"
        assert call.arguments == {"query": "test", "limit": 5}
        assert call.call_id == "call_123"
    
    def test_function_call_get_call_str(self, sample_function):
        """测试获取调用字符串表示"""
        call = FunctionCall(
            function=sample_function,
            arguments={"query": "hello"},
            call_id="call_456"
        )
        
        call_str = call.get_call_str()
        
        assert "sample_sync_function" in call_str
        assert "query" in call_str
    
    def test_function_call_execute_sync(self, sample_function):
        """测试同步执行 FunctionCall"""
        call = FunctionCall(
            function=sample_function,
            arguments={"query": "test", "limit": 5},
            call_id="call_789"
        )
        
        result = call.execute()
        
        assert result is not None
        assert isinstance(result, FunctionExecutionResult)
        assert result.status == "success"
        assert "test" in result.result
    
    @pytest.mark.asyncio
    async def test_function_call_execute_async(self, sample_async_func):
        """测试异步执行 FunctionCall"""
        call = FunctionCall(
            function=sample_async_func,
            arguments={"message": "hello"},
            call_id="call_async_123"
        )
        
        result = await call.aexecute()
        
        assert result is not None
        assert isinstance(result, FunctionExecutionResult)
        assert result.status == "success"
        assert "hello" in result.result


class TestUserInputField:
    """UserInputField 类测试"""
    
    def test_user_input_field_creation(self):
        """测试 UserInputField 创建"""
        field = UserInputField(
            name="username",
            field_type=str,
            description="The user's name"
        )
        
        assert field.name == "username"
        assert field.field_type == str
        assert field.description == "The user's name"
    
    def test_user_input_field_to_dict(self):
        """测试 UserInputField 转字典"""
        field = UserInputField(
            name="count",
            field_type=int,
            description="A count",
            value=42
        )
        
        result = field.to_dict()
        
        assert result["name"] == "count"
        assert result["value"] == 42
    
    def test_user_input_field_from_dict(self):
        """测试从字典创建 UserInputField"""
        data = {
            "name": "email",
            "field_type": "str",
            "description": "User email",
            "value": "test@example.com"
        }
        
        field = UserInputField.from_dict(data)
        
        assert field.name == "email"
        assert field.value == "test@example.com"
