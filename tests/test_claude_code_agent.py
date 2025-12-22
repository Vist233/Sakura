"""
ClaudeCodeAgent 单元测试（无需 API）
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from sakura.claude_code import ClaudeCodeAgent
from sakura.claude_code.file_state import FileStateTracker


class TestClaudeCodeAgentCreation:
    """测试 ClaudeCodeAgent 创建"""
    
    def test_zero_config_creation(self):
        """测试零配置创建"""
        agent = ClaudeCodeAgent()
        
        assert agent.model == "qwen-plus"
        assert len(agent._functions) == 7
        assert agent.strict_read_before_write is True
        assert agent.file_state is not None
    
    def test_custom_model(self):
        """测试自定义模型"""
        agent = ClaudeCodeAgent(model="gpt-4")
        
        assert agent.model == "gpt-4"
        assert len(agent._functions) == 7
    
    def test_extra_tools(self):
        """测试额外工具"""
        from sakura.tools import tool
        
        @tool
        def my_custom_tool(x: int) -> int:
            """自定义工具"""
            return x * 2
        
        agent = ClaudeCodeAgent(extra_tools=[my_custom_tool])
        
        assert len(agent._functions) == 8
        assert "my_custom_tool" in agent._functions
    
    def test_core_tools_present(self):
        """测试 7 个核心工具都存在"""
        agent = ClaudeCodeAgent()
        
        expected_tools = ["read", "write", "edit", "todo", "bash", "glob", "grep"]
        for tool_name in expected_tools:
            assert tool_name in agent._functions, f"Missing tool: {tool_name}"
    
    def test_system_prompt_loaded(self):
        """测试系统提示词加载"""
        agent = ClaudeCodeAgent()
        
        assert agent.system_prompt is not None
        assert len(agent.system_prompt) > 100
        assert "read before write" in agent.system_prompt.lower()
    
    def test_custom_system_prompt(self):
        """测试自定义系统提示词"""
        custom_prompt = "You are a helpful assistant."
        agent = ClaudeCodeAgent(system_prompt=custom_prompt)
        
        assert agent.system_prompt == custom_prompt
    
    def test_debug_mode(self):
        """测试调试模式"""
        agent = ClaudeCodeAgent(debug=True)
        
        assert agent.debug is True


class TestFileStateTracker:
    """测试 FileStateTracker"""
    
    def test_tracker_creation(self):
        """测试追踪器创建"""
        tracker = FileStateTracker()
        
        assert tracker is not None
    
    def test_record_read(self):
        """测试记录读取"""
        tracker = FileStateTracker()
        
        tracker.record_read("/tmp/test.txt", "hello world")
        
        assert tracker.has_read("/tmp/test.txt")
        assert not tracker.has_read("/tmp/other.txt")
    
    def test_validate_for_write_after_read(self):
        """测试读后验证写入"""
        tracker = FileStateTracker()
        
        # 读取后可以写
        tracker.record_read("/tmp/nonexistent_test.txt", "hello")
        # 对于不存在的文件，总是可以写入
        valid, error = tracker.validate_for_write("/tmp/nonexistent_test.txt")
        assert valid
    
    def test_clear(self):
        """测试清除状态"""
        tracker = FileStateTracker()
        tracker.record_read("/tmp/test.txt", "hello")
        
        tracker.clear()
        
        assert not tracker.has_read("/tmp/test.txt")
    
    def test_get_content(self):
        """测试获取内容"""
        tracker = FileStateTracker()
        tracker.record_read("/tmp/test.txt", "hello world")
        
        content = tracker.get_content("/tmp/test.txt")
        assert content == "hello world"
    
    def test_len(self):
        """测试长度"""
        tracker = FileStateTracker()
        assert len(tracker) == 0
        
        tracker.record_read("/tmp/a.txt", "a")
        tracker.record_read("/tmp/b.txt", "b")
        
        assert len(tracker) == 2


class TestAgentWithFileState:
    """测试 Agent 与 FileState 集成"""
    
    def test_file_state_injection(self):
        """测试 file_state 注入"""
        agent = ClaudeCodeAgent()
        
        assert agent.file_state is not None
        assert isinstance(agent.file_state, FileStateTracker)
    
    def test_get_file_state(self):
        """测试获取 file_state"""
        agent = ClaudeCodeAgent()
        
        fs = agent.get_file_state()
        assert fs is agent.file_state
    
    def test_clear_file_state(self):
        """测试清除 file_state"""
        agent = ClaudeCodeAgent()
        agent.file_state.record_read("/tmp/test.txt", "hello")
        
        agent.clear_file_state()
        
        assert not agent.file_state.has_read("/tmp/test.txt")


class TestTopLevelExports:
    """测试顶层导出"""
    
    def test_import_from_sakura(self):
        """测试从 sakura 导入"""
        from sakura import ClaudeCodeAgent, SmartCompressor
        
        assert ClaudeCodeAgent is not None
        assert SmartCompressor is not None
    
    def test_create_from_top_level(self):
        """测试从顶层创建"""
        from sakura import ClaudeCodeAgent
        
        agent = ClaudeCodeAgent()
        assert agent.model == "qwen-plus"
