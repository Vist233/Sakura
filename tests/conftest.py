"""
Pytest fixtures for Sakura Agent Framework tests

提供测试所需的公共 fixtures 和辅助函数
"""

import sys
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, AsyncMock

import pytest

# 添加项目父目录到 path（确保在其他导入之前）
_project_root = Path(__file__).parent.parent
_parent_dir = _project_root.parent
if str(_parent_dir) not in sys.path:
    sys.path.insert(0, str(_parent_dir))

# 设置环境变量避免某些模块初始化问题
os.environ.setdefault("SAKURA_TEST_MODE", "1")

# 现在可以安全地导入项目模块（使用 sakura 包前缀）
from sakura.tools.function import Function, FunctionCall
from sakura.tools.decorator import tool
from sakura.tools.toolkit import Toolkit
from sakura.messages.message import Message
from sakura.messages.response import ModelResponse
from sakura.media import Image, Audio, Video, File
from sakura.run import RunContext, RunState, RunOutput, ToolResult
from sakura.exceptions import (
    AgentRunException,
    RetryAgentRun,
    StopAgentRun,
    ModelProviderError,
    ModelAuthenticationError,
)


# ============================================
# Sample Functions for Testing
# ============================================

def sample_sync_function(query: str, limit: int = 10) -> str:
    """
    搜索函数示例
    
    Args:
        query: 搜索关键词
        limit: 返回结果数量限制
    
    Returns:
        搜索结果
    """
    return f"Results for '{query}' (limit: {limit})"


async def sample_async_function(message: str) -> str:
    """
    异步消息处理函数
    
    Args:
        message: 输入消息
    
    Returns:
        处理后的消息
    """
    return f"Processed: {message}"


def simple_tool(x: int, y: int) -> int:
    """计算两数之和"""
    return x + y


# ============================================
# Fixtures
# ============================================

@pytest.fixture
def sample_function() -> Function:
    """创建一个示例 Function 对象"""
    return Function.from_callable(sample_sync_function)


@pytest.fixture
def sample_async_func() -> Function:
    """创建一个异步 Function 对象"""
    return Function.from_callable(sample_async_function)


@pytest.fixture
def mock_model():
    """创建一个模拟的 Model 对象"""
    model = MagicMock()
    model.id = "mock-model"
    model.name = "MockModel"
    
    # Mock invoke method
    mock_response = ModelResponse(
        content="Hello, I'm a mock response",
        role="assistant",
    )
    model.invoke = MagicMock(return_value=mock_response)
    model.ainvoke = AsyncMock(return_value=mock_response)
    
    return model


@pytest.fixture
def sample_message() -> Message:
    """创建一个示例 Message 对象"""
    return Message(
        role="user",
        content="Hello, this is a test message"
    )


@pytest.fixture
def assistant_message() -> Message:
    """创建一个助手消息"""
    return Message(
        role="assistant",
        content="Hello! How can I help you?"
    )


@pytest.fixture
def system_message() -> Message:
    """创建一个系统消息"""
    return Message(
        role="system",
        content="You are a helpful assistant."
    )


@pytest.fixture
def tool_call_message() -> Message:
    """创建一个包含工具调用的消息"""
    return Message(
        role="assistant",
        content=None,
        tool_calls=[{
            "id": "call_123",
            "type": "function",
            "function": {
                "name": "search",
                "arguments": '{"query": "test"}'
            }
        }]
    )


@pytest.fixture
def sample_run_context() -> RunContext:
    """创建一个示例 RunContext"""
    return RunContext(
        run_id="test-run-123",
        session_id="session-456",
        user_id="user-789",
        state=RunState.RUNNING,
        session_state={"key": "value"},
    )


@pytest.fixture
def sample_toolkit() -> Toolkit:
    """创建一个示例 Toolkit"""
    toolkit = Toolkit(name="TestToolkit")
    
    @toolkit.register()
    def add(a: int, b: int) -> int:
        """Add two numbers"""
        return a + b
    
    @toolkit.register(name="multiply")
    def mul(a: int, b: int) -> int:
        """Multiply two numbers"""
        return a * b
    
    return toolkit


@pytest.fixture
def temp_file(tmp_path):
    """创建一个临时文件用于测试"""
    file_path = tmp_path / "test_file.txt"
    file_path.write_text("Hello, World!")
    return str(file_path)


@pytest.fixture
def temp_image(tmp_path):
    """创建一个临时图片文件用于测试"""
    # 创建一个简单的 1x1 PNG 文件
    import base64
    png_data = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    )
    file_path = tmp_path / "test_image.png"
    file_path.write_bytes(png_data)
    return str(file_path)


# ============================================
# Helper Functions
# ============================================

def create_function_call(
    function: Function,
    arguments: Optional[Dict[str, Any]] = None,
    call_id: str = "call_test_123"
) -> FunctionCall:
    """创建一个 FunctionCall 对象"""
    return FunctionCall(
        function=function,
        arguments=arguments or {},
        call_id=call_id,
    )
