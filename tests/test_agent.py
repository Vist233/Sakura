"""
Tests for Agent class

测试 Agent 核心类（使用模拟的 Model）
"""

import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from typing import List

from sakura.agent import Agent
from sakura.tools.function import Function
from sakura.tools.decorator import tool
from sakura.messages.message import Message


class TestAgentCreation:
    """Agent 创建测试"""
    
    def test_agent_creation_with_mock_model(self, mock_model):
        """测试使用模拟模型创建 Agent"""
        agent = Agent(model=mock_model)
        
        assert agent.model is not None
        assert agent.tools == []
    
    def test_agent_creation_with_system_prompt(self, mock_model):
        """测试带系统提示创建"""
        agent = Agent(
            model=mock_model,
            system_prompt="You are a helpful assistant."
        )
        
        assert agent.system_prompt == "You are a helpful assistant."
    
    def test_agent_creation_with_instructions(self, mock_model):
        """测试带指令创建"""
        agent = Agent(
            model=mock_model,
            instructions=["Be concise", "Be helpful"]
        )
        
        assert agent.instructions == ["Be concise", "Be helpful"]
    
    def test_agent_creation_with_tools(self, mock_model, sample_function):
        """测试带工具创建"""
        agent = Agent(
            model=mock_model,
            tools=[sample_function]
        )
        
        # 工具存储在 _functions 中
        assert len(agent._functions) == 1
    
    def test_agent_creation_with_callable_tools(self, mock_model):
        """测试使用普通函数作为工具"""
        def my_tool(x: int) -> int:
            """A simple tool"""
            return x * 2
        
        agent = Agent(
            model=mock_model,
            tools=[my_tool]
        )
        
        # 函数应该被转换为 Function 并存储在 _functions 中
        assert len(agent._functions) == 1
        assert "my_tool" in agent._functions


class TestAgentTools:
    """Agent 工具管理测试"""
    
    def test_agent_add_tool(self, mock_model):
        """测试添加工具"""
        agent = Agent(model=mock_model)
        
        @tool
        def new_tool(x: int) -> int:
            """New tool"""
            return x
        
        agent.add_tool(new_tool)
        
        # 工具应该添加到 _functions 中
        assert len(agent._functions) == 1
        assert "new_tool" in agent._functions
    
    def test_agent_add_callable_tool(self, mock_model):
        """测试添加普通函数作为工具"""
        agent = Agent(model=mock_model)
        
        def callable_tool(x: str) -> str:
            """A callable"""
            return x
        
        agent.add_tool(callable_tool)
        
        assert len(agent._functions) == 1
        assert "callable_tool" in agent._functions
    
    def test_agent_remove_tool(self, mock_model, sample_function):
        """测试移除工具"""
        agent = Agent(
            model=mock_model,
            tools=[sample_function]
        )
        
        # 确认工具已添加
        assert len(agent._functions) == 1
        
        result = agent.remove_tool("sample_sync_function")
        
        assert result == True
        assert len(agent._functions) == 0
    
    def test_agent_remove_nonexistent_tool(self, mock_model):
        """测试移除不存在的工具"""
        agent = Agent(model=mock_model)
        
        result = agent.remove_tool("nonexistent")
        
        assert result == False
    
    def test_agent_tool_names(self, mock_model):
        """测试获取工具名称"""
        @tool
        def tool_a(x: int) -> int:
            """Tool A"""
            return x
        
        @tool
        def tool_b(y: str) -> str:
            """Tool B"""
            return y
        
        agent = Agent(
            model=mock_model,
            tools=[tool_a, tool_b]
        )
        
        names = agent.tool_names
        
        assert "tool_a" in names
        assert "tool_b" in names


class TestAgentMessages:
    """Agent 消息处理测试"""
    
    def test_agent_build_messages_basic(self, mock_model):
        """测试基础消息构建"""
        agent = Agent(
            model=mock_model,
            system_prompt="System prompt"
        )
        
        messages = agent._build_messages("Hello")
        
        # 应该包含系统消息和用户消息
        assert len(messages) >= 2
        roles = [m.role for m in messages]
        assert "system" in roles
        assert "user" in roles
    
    def test_agent_build_messages_with_history(self, mock_model, sample_message, assistant_message):
        """测试带历史消息构建"""
        agent = Agent(model=mock_model)
        
        history = [sample_message, assistant_message]
        messages = agent._build_messages("New message", messages=history)
        
        # 应该包含历史消息和新消息
        assert len(messages) >= len(history) + 1
    
    def test_agent_build_system_message(self, mock_model):
        """测试系统消息构建"""
        agent = Agent(
            model=mock_model,
            system_prompt="Base prompt",
            instructions=["Instruction 1", "Instruction 2"]
        )
        
        system_content = agent._build_system_message()
        
        assert "Base prompt" in system_content
        assert "Instruction 1" in system_content
        assert "Instruction 2" in system_content


class TestAgentToolDicts:
    """Agent 工具定义测试"""
    
    def test_agent_get_tool_dicts(self, mock_model):
        """测试获取工具定义"""
        @tool
        def search(query: str) -> str:
            """Search for information"""
            return f"Results for: {query}"
        
        agent = Agent(
            model=mock_model,
            tools=[search]
        )
        
        tool_dicts = agent._get_tool_dicts()
        
        assert len(tool_dicts) == 1
        # 工具字典包含 name, description, parameters
        assert tool_dicts[0]["name"] == "search"
    
    def test_agent_get_tool_dicts_empty(self, mock_model):
        """测试无工具时获取定义"""
        agent = Agent(model=mock_model)
        
        tool_dicts = agent._get_tool_dicts()
        
        assert tool_dicts == []


class TestAgentConfiguration:
    """Agent 配置测试"""
    
    def test_agent_with_output_schema(self, mock_model):
        """测试结构化输出配置"""
        from pydantic import BaseModel
        
        class OutputModel(BaseModel):
            result: str
        
        agent = Agent(
            model=mock_model,
            output_schema=OutputModel
        )
        
        assert agent.output_schema == OutputModel
    
    def test_agent_with_tool_schema_cache(self, mock_model):
        """测试工具 Schema 缓存始终被初始化"""
        @tool
        def my_func(x: int) -> int:
            """A function"""
            return x
        
        agent = Agent(
            model=mock_model,
            tools=[my_func]
        )
        
        # Schema 缓存应该始终被初始化
        assert agent._tool_schemas_cache is not None
        assert len(agent._tool_schemas_cache) == 1
    
    def test_agent_with_max_tool_calls(self, mock_model):
        """测试最大工具调用配置"""
        agent = Agent(
            model=mock_model,
            max_tool_calls=5
        )
        
        assert agent.max_tool_calls == 5
    
    def test_agent_with_tool_choice(self, mock_model):
        """测试工具选择策略"""
        agent = Agent(
            model=mock_model,
            tool_choice="auto"
        )
        
        assert agent.tool_choice == "auto"


class TestAgentToolExecution:
    """Agent 工具执行测试"""
    
    def test_execute_tool_call(self, mock_model):
        """测试工具调用执行"""
        @tool
        def add(a: int, b: int) -> int:
            """Add two numbers"""
            return a + b
        
        agent = Agent(
            model=mock_model,
            tools=[add]
        )
        
        result = agent._execute_tool_call(
            tool_name="add",
            tool_args={"a": 5, "b": 3},
            tool_call_id="call_123"
        )
        
        assert result is not None
        assert result.role == "tool"
        assert "8" in result.content
    
    def test_execute_tool_call_not_found(self, mock_model):
        """测试执行不存在的工具"""
        agent = Agent(model=mock_model)
        
        result = agent._execute_tool_call(
            tool_name="nonexistent",
            tool_args={},
            tool_call_id="call_456"
        )
        
        # 应该返回错误信息
        assert result is not None
        assert result.role == "tool"
        assert "Error" in result.content or "Unknown" in result.content
