"""
Tests for State Management Issues

针对状态管理隐患的测试用例，按 TDD 流程：
1. 先写测试（预期失败）
2. 修复代码
3. 验证测试通过
"""

import pytest
import threading
import concurrent.futures
from unittest.mock import MagicMock

from sakura.agent import Agent
from sakura.tools.decorator import tool
from sakura.messages.message import Message
from sakura.memory.compressor import SmartCompressor, CompressionMetrics


# ============================================
# P0-1: 缓存失效问题 (#3)
# ============================================

class TestToolSchemaCacheInvalidation:
    """测试 add_tool/remove_tool 后缓存是否正确失效"""
    
    def test_add_tool_invalidates_cache(self, mock_model):
        """
        add_tool 后缓存应该失效或更新
        
        Before fix: 缓存不更新，新工具的 Schema 不会发送给模型
        After fix: 缓存被清空或更新，_get_tool_dicts() 返回新工具
        """
        agent = Agent(model=mock_model)
        
        # 初始状态：无工具
        initial_schemas = agent._get_tool_dicts()
        assert len(initial_schemas) == 0
        
        # 动态添加工具
        @tool
        def new_tool(x: int) -> int:
            """A new tool"""
            return x * 2
        
        agent.add_tool(new_tool)
        
        # 关键断言：缓存应该反映新工具
        updated_schemas = agent._get_tool_dicts()
        assert len(updated_schemas) == 1, "Cache should include the new tool"
        assert updated_schemas[0]["name"] == "new_tool"
    
    def test_remove_tool_invalidates_cache(self, mock_model):
        """
        remove_tool 后缓存应该失效或更新
        """
        @tool
        def tool_to_remove(x: int) -> int:
            """Tool to remove"""
            return x
        
        agent = Agent(model=mock_model, tools=[tool_to_remove])
        
        # 初始状态：有一个工具
        initial_schemas = agent._get_tool_dicts()
        assert len(initial_schemas) == 1
        
        # 移除工具
        agent.remove_tool("tool_to_remove")
        
        # 关键断言：缓存应该反映工具已移除
        updated_schemas = agent._get_tool_dicts()
        assert len(updated_schemas) == 0, "Cache should be empty after removal"
    
    def test_multiple_add_remove_operations(self, mock_model):
        """
        连续多次 add/remove 操作后缓存应正确
        """
        agent = Agent(model=mock_model)
        
        @tool
        def tool_a(x: int) -> int:
            """Tool A"""
            return x
        
        @tool
        def tool_b(y: str) -> str:
            """Tool B"""
            return y
        
        # 添加两个工具
        agent.add_tool(tool_a)
        agent.add_tool(tool_b)
        assert len(agent._get_tool_dicts()) == 2
        
        # 移除一个
        agent.remove_tool("tool_a")
        schemas = agent._get_tool_dicts()
        assert len(schemas) == 1
        assert schemas[0]["name"] == "tool_b"


# ============================================
# P0-2: 全局状态污染 (#1)
# ============================================

class TestFileStateIsolation:
    """测试 ClaudeCodeAgent 的文件状态隔离"""
    
    def test_multiple_agents_isolated_file_state(self):
        """
        多个 ClaudeCodeAgent 实例应该有独立的 file_state
        
        Before fix: 后创建的 agent 会覆盖全局状态
        After fix: 每个 agent 的 file_state 互不影响
        """
        # 延迟导入，避免在不需要时加载
        try:
            from sakura.claude_code import ClaudeCodeAgent
            from sakura.claude_code.file_state import FileStateTracker
        except ImportError:
            pytest.skip("claude_code module not available")
        
        # 创建两个独立的 agent
        agent1 = ClaudeCodeAgent()
        agent2 = ClaudeCodeAgent()
        
        # 模拟 agent1 读取文件
        agent1.file_state.record_read("/path/to/file1.py", "content1")
        
        # 模拟 agent2 读取不同文件
        agent2.file_state.record_read("/path/to/file2.py", "content2")
        
        # 关键断言：两个 agent 的状态应该独立
        assert agent1.file_state.has_read("/path/to/file1.py")
        assert not agent1.file_state.has_read("/path/to/file2.py")
        
        assert agent2.file_state.has_read("/path/to/file2.py")
        assert not agent2.file_state.has_read("/path/to/file1.py")
    
    def test_concurrent_agents_no_race_condition(self):
        """
        并发使用多个 agent 时不应有竞态条件
        """
        try:
            from sakura.claude_code import ClaudeCodeAgent
        except ImportError:
            pytest.skip("claude_code module not available")
        
        results = {}
        errors = []
        
        def run_agent(agent_id: int):
            try:
                agent = ClaudeCodeAgent()
                file_path = f"/path/to/file_{agent_id}.py"
                agent.file_state.record_read(file_path, f"content_{agent_id}")
                
                # 验证只包含自己的文件
                if agent.file_state.has_read(file_path):
                    results[agent_id] = True
                else:
                    results[agent_id] = False
            except Exception as e:
                errors.append((agent_id, str(e)))
        
        # 并发运行多个 agent
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(run_agent, i) for i in range(5)]
            concurrent.futures.wait(futures)
        
        # 不应有错误
        assert len(errors) == 0, f"Errors: {errors}"
        # 所有 agent 应该正常工作
        assert all(results.values()), f"Some agents failed: {results}"
    
    def test_concurrent_tool_access_via_registry(self):
        """
        测试并发时通过全局 registry 访问 file_state 的隔离性
        
        Before fix: 全局 dict 被覆盖，后设置的 tracker 覆盖前面的
        After fix: 使用 contextvars，每个线程有独立的 tracker
        """
        try:
            from sakura.claude_code import ClaudeCodeAgent
            from sakura.claude_code.tools.read import get_file_state, set_file_state
            from sakura.claude_code.file_state import FileStateTracker
        except ImportError:
            pytest.skip("claude_code module not available")
        
        results = {}
        errors = []
        
        def worker(worker_id: int):
            """每个 worker 设置自己的 tracker 并验证获取到的是自己的"""
            try:
                # 创建独立的 tracker
                my_tracker = FileStateTracker()
                my_tracker.record_read(f"/file_{worker_id}.py", f"content_{worker_id}")
                
                # 设置到 registry
                set_file_state(my_tracker)
                
                # 模拟一些工作
                import time
                time.sleep(0.01)
                
                # 获取并验证是否是自己的 tracker
                retrieved = get_file_state()
                
                if retrieved is my_tracker:
                    results[worker_id] = True
                else:
                    results[worker_id] = False
                    errors.append((worker_id, "Retrieved wrong tracker"))
                    
            except Exception as e:
                errors.append((worker_id, str(e)))
        
        # 并发运行
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(worker, i) for i in range(5)]
            concurrent.futures.wait(futures)
        
        # 关键断言：每个 worker 应该获取到自己的 tracker
        assert len(errors) == 0, f"Errors: {errors}"
        assert all(results.values()), f"Some workers got wrong tracker: {results}"


# ============================================
# P2: SmartCompressor.metrics 累积状态 (#4)
# ============================================

class TestCompressorMetricsIsolation:
    """测试压缩器 metrics 的独立性"""
    
    def test_compress_returns_current_metrics(self):
        """
        compress() 应该在 metadata 中返回本次压缩的 metrics
        """
        compressor = SmartCompressor(
            threshold=0.1,
            min_messages=1,
            strategy="sliding"
        )
        
        messages = [
            Message(role="user", content="Test " * 50)
            for _ in range(5)
        ]
        
        _, metadata = compressor.compress(messages, "gpt-4")
        
        # metadata 应包含本次压缩的信息
        assert "input_tokens" in metadata
        assert "output_tokens" in metadata
        assert "compression_ratio" in metadata
    
    def test_metrics_accumulate_correctly(self):
        """
        多次压缩后 metrics 应正确累积
        """
        compressor = SmartCompressor(
            threshold=0.1,
            min_messages=1,
            strategy="sliding"
        )
        
        messages = [
            Message(role="user", content="Test " * 50)
            for _ in range(5)
        ]
        
        # 第一次压缩
        compressor.compress(messages, "gpt-4")
        first_count = compressor.metrics.compressions
        
        # 第二次压缩
        compressor.compress(messages, "gpt-4")
        second_count = compressor.metrics.compressions
        
        assert second_count == first_count + 1
    
    def test_reset_metrics_works(self):
        """
        reset_metrics() 应该清空累积的 metrics
        """
        compressor = SmartCompressor(
            threshold=0.1,
            min_messages=1,
            strategy="sliding"
        )
        
        messages = [Message(role="user", content="Test " * 50) for _ in range(5)]
        compressor.compress(messages, "gpt-4")
        
        assert compressor.metrics.compressions > 0
        
        compressor.reset_metrics()
        
        assert compressor.metrics.compressions == 0


# ============================================
# P3: 未使用变量测试（可选，静态检查）
# ============================================

class TestCodeCleanup:
    """测试代码清理相关"""
    
    def test_model_response_no_unused_fields(self):
        """
        ModelResponse 不应有未使用的字段
        (此测试作为提醒，实际需要静态分析)
        """
        from sakura.messages.response import ModelResponse
        
        response = ModelResponse(content="Test")
        
        # updated_session_state 字段存在但应该被标记为 deprecated
        # 这个测试主要是文档性质的
        assert hasattr(response, "updated_session_state")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
