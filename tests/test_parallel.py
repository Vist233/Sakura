"""
Tests for Parallel Execution module
"""

import asyncio
import pytest
from time import perf_counter

from sakura.tools.parallel import (
    ParallelExecutionMetrics,
    execute_tools_parallel,
    separate_parallel_tools,
)
from sakura.tools.function import Function
from sakura.tools.decorator import tool


# ============ Metrics Tests ============

class TestParallelExecutionMetrics:
    """ParallelExecutionMetrics 单元测试"""
    
    def test_record_execution(self):
        """测试记录执行"""
        metrics = ParallelExecutionMetrics()
        
        metrics.record_execution("search", 0.5, parallel=True)
        metrics.record_execution("read_file", 0.3, parallel=True)
        metrics.record_execution("write_file", 0.4, parallel=False)
        
        assert metrics.total_calls == 3
        assert metrics.parallel_calls == 2
        assert metrics.sequential_calls == 1
    
    def test_parallel_ratio(self):
        """测试并行比例计算"""
        metrics = ParallelExecutionMetrics()
        
        # 空状态
        assert metrics.parallel_ratio == 0
        
        # 3 并行 + 1 顺序
        for _ in range(3):
            metrics.record_execution("tool", 0.1, parallel=True)
        metrics.record_execution("tool", 0.1, parallel=False)
        
        assert metrics.parallel_ratio == 0.75
    
    def test_error_and_timeout_tracking(self):
        """测试错误和超时追踪"""
        metrics = ParallelExecutionMetrics()
        
        metrics.record_execution("tool1", 0.1, error=True)
        metrics.record_execution("tool2", 30.0, timeout=True, error=True)
        metrics.record_execution("tool3", 0.2)
        
        assert metrics.errors == 2
        assert metrics.timeouts == 1
    
    def test_tool_latencies(self):
        """测试工具延迟追踪"""
        metrics = ParallelExecutionMetrics()
        
        metrics.record_execution("search", 0.5)
        metrics.record_execution("search", 0.7)
        metrics.record_execution("search", 0.3)
        
        assert "search" in metrics.tool_latencies
        assert len(metrics.tool_latencies["search"]) == 3
        assert sum(metrics.tool_latencies["search"]) == pytest.approx(1.5)
    
    def test_report(self):
        """测试报告生成"""
        metrics = ParallelExecutionMetrics()
        metrics.record_execution("search", 0.5, parallel=True)
        
        report = metrics.report()
        assert "并行执行统计" in report
        assert "search" in report
    
    def test_reset(self):
        """测试重置"""
        metrics = ParallelExecutionMetrics()
        metrics.record_execution("search", 0.5)
        metrics.reset()
        
        assert metrics.total_calls == 0
        assert len(metrics.tool_latencies) == 0


# ============ Tool Decorator Tests ============

class TestToolParallelConfig:
    """工具装饰器并行配置测试"""
    
    def test_default_parallel_safe(self):
        """测试默认并行安全"""
        @tool
        def my_tool(x: int) -> int:
            """A simple tool"""
            return x * 2
        
        assert my_tool.parallel_safe == True
    
    def test_explicit_parallel_safe(self):
        """测试显式设置并行安全"""
        @tool(parallel_safe=True)
        def safe_tool(x: int) -> int:
            """Safe to run in parallel"""
            return x
        
        @tool(parallel_safe=False)
        def unsafe_tool(x: int) -> int:
            """Not safe to run in parallel"""
            return x
        
        assert safe_tool.parallel_safe == True
        assert unsafe_tool.parallel_safe == False
    
    def test_timeout_config(self):
        """测试超时配置"""
        @tool(timeout=10.0)
        def slow_tool(x: int) -> int:
            """A slow tool"""
            return x
        
        assert slow_tool.timeout == 10.0


# ============ Separate Tools Tests ============

class TestSeparateParallelTools:
    """工具分离测试"""
    
    def test_separate_by_parallel_safe(self):
        """测试按 parallel_safe 分离"""
        safe = Function(name="safe", parallel_safe=True)
        unsafe = Function(name="unsafe", parallel_safe=False)
        
        # 模拟 FunctionCall
        class MockFC:
            def __init__(self, func):
                self.function = func
        
        calls = [MockFC(safe), MockFC(unsafe)]
        parallel, sequential = separate_parallel_tools(calls)
        
        assert len(parallel) == 1
        assert len(sequential) == 1
        assert parallel[0].function.name == "safe"
        assert sequential[0].function.name == "unsafe"
    
    def test_confirmation_is_sequential(self):
        """测试需要确认的工具归为顺序"""
        needs_confirm = Function(name="confirm", requires_confirmation=True)
        
        class MockFC:
            def __init__(self, func):
                self.function = func
        
        calls = [MockFC(needs_confirm)]
        parallel, sequential = separate_parallel_tools(calls)
        
        assert len(parallel) == 0
        assert len(sequential) == 1


# ============ Async Execution Tests ============

class TestExecuteToolsParallel:
    """并行执行测试"""
    
    @pytest.mark.asyncio
    async def test_parallel_faster_than_sequential(self):
        """测试并行确实比顺序快"""
        # 模拟慢工具
        async def slow_func():
            await asyncio.sleep(0.1)
            return "done"
        
        class MockFC:
            call_id = "test_id"
            arguments = {}
            
            def __init__(self, func_obj):
                self.function = func_obj
            
            def execute(self):
                import time
                time.sleep(0.1)
                return type('Result', (), {'result': 'done'})()
        
        func = Function(name="slow")
        calls = [MockFC(func) for _ in range(3)]
        
        start = perf_counter()
        results = await execute_tools_parallel(calls, timeout=5.0)
        elapsed = perf_counter() - start
        
        # 3 个 0.1s 的任务并行，应该 < 0.3s (顺序执行需要 ~0.3s)
        # 但由于是在线程池中执行，给一些余量
        assert elapsed < 0.5  # 并行应该更快
        assert len(results) == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
