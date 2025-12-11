"""
Tests for Message class

测试 Message 消息处理类
"""

import pytest
import json
from uuid import UUID

from sakura.messages.message import Message, MessageReferences, Citations, UrlCitation


class TestMessage:
    """Message 类测试"""
    
    def test_message_creation_basic(self):
        """测试基础消息创建"""
        msg = Message(
            role="user",
            content="Hello, world!"
        )
        
        assert msg.role == "user"
        assert msg.content == "Hello, world!"
        assert msg.id is not None
        # ID 应该是有效的 UUID
        UUID(msg.id)
    
    def test_message_creation_with_id(self):
        """测试带自定义 ID 的消息创建"""
        msg = Message(
            id="custom-id-123",
            role="assistant",
            content="Hi there!"
        )
        
        assert msg.id == "custom-id-123"
    
    def test_message_roles(self):
        """测试不同角色的消息"""
        user_msg = Message(role="user", content="User message")
        assistant_msg = Message(role="assistant", content="Assistant message")
        system_msg = Message(role="system", content="System message")
        tool_msg = Message(role="tool", content="Tool result")
        
        assert user_msg.role == "user"
        assert assistant_msg.role == "assistant"
        assert system_msg.role == "system"
        assert tool_msg.role == "tool"
    
    def test_message_get_content_string(self, sample_message):
        """测试获取内容字符串"""
        content = sample_message.get_content_string()
        
        assert content == "Hello, this is a test message"
    
    def test_message_get_content_string_with_list(self):
        """测试列表内容获取字符串"""
        msg = Message(
            role="user",
            content=[
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": " World"}
            ]
        )
        
        # 应该能处理列表内容
        content = msg.get_content_string()
        assert content is not None
    
    def test_message_to_dict(self, sample_message):
        """测试消息序列化为字典"""
        result = sample_message.to_dict()
        
        assert "role" in result
        assert "content" in result
        assert result["role"] == "user"
        assert result["content"] == "Hello, this is a test message"
    
    def test_message_from_dict_basic(self):
        """测试从字典创建消息"""
        data = {
            "role": "user",
            "content": "Test message from dict"
        }
        
        msg = Message.from_dict(data)
        
        assert msg.role == "user"
        assert msg.content == "Test message from dict"
    
    def test_message_from_dict_with_tool_calls(self):
        """测试从字典创建带工具调用的消息"""
        data = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_abc123",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": '{"query": "test"}'
                    }
                }
            ]
        }
        
        msg = Message.from_dict(data)
        
        assert msg.role == "assistant"
        assert msg.tool_calls is not None
        assert len(msg.tool_calls) == 1
    
    def test_message_content_is_valid(self):
        """测试内容有效性检查"""
        valid_msg = Message(role="user", content="Valid content")
        empty_msg = Message(role="user", content="")
        none_msg = Message(role="user", content=None)
        
        assert valid_msg.content_is_valid() == True
        # 空字符串和 None 的有效性取决于实现
    
    def test_message_with_name(self):
        """测试带名称的消息"""
        msg = Message(
            role="user",
            content="Hello",
            name="TestUser"
        )
        
        assert msg.name == "TestUser"
    
    def test_message_with_tool_call_id(self):
        """测试工具调用结果消息"""
        msg = Message(
            role="tool",
            content="Tool result content",
            tool_call_id="call_123"
        )
        
        assert msg.role == "tool"
        assert msg.tool_call_id == "call_123"


class TestMessageReferences:
    """MessageReferences 类测试"""
    
    def test_message_references_creation(self):
        """测试引用创建"""
        refs = MessageReferences(
            query="test query",
            references=[{"title": "Ref 1"}, {"title": "Ref 2"}]
        )
        
        assert refs.query == "test query"
        assert len(refs.references) == 2
    
    def test_message_references_empty(self):
        """测试空引用"""
        refs = MessageReferences(query="query")
        
        assert refs.query == "query"
        assert refs.references is None


class TestCitations:
    """Citations 类测试"""
    
    def test_citations_with_urls(self):
        """测试带 URL 的引用"""
        citations = Citations(
            urls=[
                UrlCitation(url="https://example.com", title="Example"),
                UrlCitation(url="https://test.com", title="Test")
            ]
        )
        
        assert len(citations.urls) == 2
        assert citations.urls[0].url == "https://example.com"
    
    def test_url_citation_creation(self):
        """测试 UrlCitation 创建"""
        citation = UrlCitation(
            url="https://example.com/page",
            title="Example Page"
        )
        
        assert citation.url == "https://example.com/page"
        assert citation.title == "Example Page"


class TestMessageWithToolCalls:
    """工具调用消息测试"""
    
    def test_tool_call_message_creation(self, tool_call_message):
        """测试工具调用消息"""
        assert tool_call_message.role == "assistant"
        assert tool_call_message.tool_calls is not None
        assert len(tool_call_message.tool_calls) == 1
    
    def test_tool_call_message_to_function_call_dict(self, tool_call_message):
        """测试转换为函数调用字典"""
        result = tool_call_message.to_function_call_dict()
        
        # 应该能正确转换工具调用
        assert result is not None
    
    def test_multiple_tool_calls(self):
        """测试多个工具调用"""
        msg = Message(
            role="assistant",
            content=None,
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "search", "arguments": '{}'}
                },
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {"name": "calculate", "arguments": '{}'}
                }
            ]
        )
        
        assert len(msg.tool_calls) == 2
