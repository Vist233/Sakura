"""
Models Integration Tests

测试真实模型调用（需要 API Key）

运行方式:
    # 全部模型测试
    pytest tests/api/test_models_integration.py -v -s
    
    # 只测试 Qwen
    pytest tests/api/test_models_integration.py -v -s -k "qwen"
"""

import os
import pytest

from .conftest import (
    skip_if_no_dashscope,
    skip_if_no_openai,
    skip_if_no_anthropic,
    has_dashscope_key,
    has_openai_key,
    has_anthropic_key,
)


class TestQwenModel:
    """Qwen 模型测试"""
    
    @skip_if_no_dashscope
    def test_qwen_simple_chat(self):
        """测试简单对话"""
        from sakura import Agent
        from sakura.models import Qwen
        
        agent = Agent(
            model=Qwen(id="qwen-plus"),
            system_prompt="你是一个助手，请用简短的话回答。"
        )
        
        result = agent.run("1+1等于几？")
        
        assert result is not None
        assert result.content is not None
        assert "2" in result.content
        print(f"\n✅ Qwen 回复: {result.content}")
    
    @skip_if_no_dashscope
    def test_qwen_with_tool(self):
        """测试工具调用"""
        from sakura import Agent, tool
        from sakura.models import Qwen
        
        @tool
        def add(a: int, b: int) -> int:
            """计算两数之和"""
            return a + b
        
        agent = Agent(
            model=Qwen(id="qwen-plus"),
            tools=[add],
            max_tool_calls=2
        )
        
        result = agent.run("请计算 15 加 27")
        
        assert result is not None
        assert result.content is not None
        assert "42" in result.content
        print(f"\n✅ Qwen 工具调用: {result.content}")
    
    @skip_if_no_dashscope
    @pytest.mark.asyncio
    async def test_qwen_async(self):
        """测试异步调用"""
        from sakura import Agent
        from sakura.models import Qwen
        
        agent = Agent(
            model=Qwen(id="qwen-turbo"),
        )
        
        result = await agent.arun("说 'Hello'")
        
        assert result is not None
        assert result.content is not None
        print(f"\n✅ Qwen 异步: {result.content}")


class TestOpenAIModel:
    """OpenAI 模型测试"""
    
    @skip_if_no_openai
    def test_openai_simple_chat(self):
        """测试简单对话"""
        from sakura import Agent
        from sakura.models import OpenAI
        
        agent = Agent(
            model=OpenAI(id="gpt-4o-mini"),
            system_prompt="You are a helpful assistant. Be very brief."
        )
        
        result = agent.run("What is 2+2?")
        
        assert result is not None
        assert result.content is not None
        assert "4" in result.content
        print(f"\n✅ OpenAI 回复: {result.content}")
    
    @skip_if_no_openai
    def test_openai_with_tool(self):
        """测试工具调用"""
        from sakura import Agent, tool
        from sakura.models import OpenAI
        
        @tool
        def multiply(a: int, b: int) -> int:
            """Multiply two numbers"""
            return a * b
        
        agent = Agent(
            model=OpenAI(id="gpt-4o-mini"),
            tools=[multiply],
            max_tool_calls=2
        )
        
        result = agent.run("Calculate 7 times 8")
        
        assert result is not None
        assert result.content is not None
        assert "56" in result.content
        print(f"\n✅ OpenAI 工具调用: {result.content}")


class TestClaudeModel:
    """Claude 模型测试"""
    
    @skip_if_no_anthropic
    def test_claude_simple_chat(self):
        """测试简单对话"""
        from sakura import Agent
        from sakura.models import Claude
        
        agent = Agent(
            model=Claude(id="claude-sonnet-4-20250514"),
            system_prompt="You are a helpful assistant. Be very brief."
        )
        
        result = agent.run("What is 3+3?")
        
        assert result is not None
        assert result.content is not None
        assert "6" in result.content
        print(f"\n✅ Claude 回复: {result.content}")
    
    @skip_if_no_anthropic
    def test_claude_with_tool(self):
        """测试工具调用"""
        from sakura import Agent, tool
        from sakura.models import Claude
        
        @tool
        def subtract(a: int, b: int) -> int:
            """Subtract b from a"""
            return a - b
        
        agent = Agent(
            model=Claude(id="claude-sonnet-4-20250514"),
            tools=[subtract],
            max_tool_calls=2
        )
        
        result = agent.run("Calculate 100 minus 37")
        
        assert result is not None
        assert result.content is not None
        assert "63" in result.content
        print(f"\n✅ Claude 工具调用: {result.content}")


class TestModelSwitching:
    """模型切换测试"""
    
    @pytest.mark.skipif(
        not (has_dashscope_key() or has_openai_key()),
        reason="No API key available"
    )
    def test_switch_model(self):
        """测试切换模型"""
        from sakura import Agent
        
        # 根据可用的 API Key 选择模型
        if has_dashscope_key():
            from sakura.models import Qwen
            model = Qwen(id="qwen-turbo")
            model_name = "Qwen"
        elif has_openai_key():
            from sakura.models import OpenAI
            model = OpenAI(id="gpt-4o-mini")
            model_name = "OpenAI"
        else:
            pytest.skip("No API key available")
        
        agent = Agent(model=model)
        result = agent.run("Say 'test'")
        
        assert result is not None
        print(f"\n✅ {model_name} 切换测试通过")


class TestAgentWithMonitor:
    """Agent + Monitor 集成测试"""
    
    @skip_if_no_dashscope
    def test_agent_with_monitor(self, tmp_path):
        """测试 Agent 配合 Monitor 使用"""
        from sakura import Agent
        from sakura.models import Qwen
        from sakura.monitor import Monitor
        
        db_path = tmp_path / "agent_logs.db"
        monitor = Monitor(str(db_path))
        
        agent = Agent(
            model=Qwen(id="qwen-turbo"),
        )
        
        # 使用 monitor 记录
        import time
        start = time.perf_counter()
        result = agent.run("说 'OK'")
        elapsed = time.perf_counter() - start
        
        monitor.log(
            function_name="agent_run",
            input_args=("说 'OK'",),
            output=result.content,
            exec_time=elapsed
        )
        
        logs = monitor.get_logs()
        assert len(logs) >= 1
        print(f"\n✅ Monitor 记录成功: {logs[0]['function_name']}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
