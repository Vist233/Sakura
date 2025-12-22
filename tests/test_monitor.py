"""
Tests for Monitor Storage module

测试 SQLiteStorage, Monitor, @monitor 装饰器
这些测试不需要 API，使用本地 SQLite
"""

import pytest
import tempfile
import time
import os
from pathlib import Path

from sakura.monitor import (
    timer,
    monitor,
    Monitor,
    SQLiteStorage,
)


class TestTimerDecorator:
    """@timer 装饰器测试"""
    
    def test_timer_sync_function(self, capsys):
        """测试同步函数计时"""
        @timer
        def slow_func():
            time.sleep(0.1)
            return "done"
        
        result = slow_func()
        
        assert result == "done"
        captured = capsys.readouterr()
        assert "⏱" in captured.out
        assert "slow_func" in captured.out
    
    def test_timer_with_custom_name(self, capsys):
        """测试自定义名称"""
        @timer(name="自定义名称")
        def my_func():
            return 42
        
        result = my_func()
        
        assert result == 42
        captured = capsys.readouterr()
        assert "自定义名称" in captured.out
    
    def test_timer_verbose_false(self, capsys):
        """测试静默模式"""
        @timer(verbose=False)
        def quiet_func():
            return "quiet"
        
        result = quiet_func()
        
        assert result == "quiet"
        captured = capsys.readouterr()
        assert captured.out == ""
    
    @pytest.mark.asyncio
    async def test_timer_async_function(self, capsys):
        """测试异步函数计时"""
        @timer
        async def async_func():
            import asyncio
            await asyncio.sleep(0.05)
            return "async_done"
        
        result = await async_func()
        
        assert result == "async_done"
        captured = capsys.readouterr()
        assert "⏱" in captured.out


class TestSQLiteStorage:
    """SQLiteStorage 测试"""
    
    def test_storage_creation(self, tmp_path):
        """测试创建存储"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        assert db_path.exists()
    
    def test_storage_log(self, tmp_path):
        """测试记录日志"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        storage.log(
            function_name="test_func",
            input_args=("arg1",),
            input_kwargs={"key": "value"},
            output="result",
            exec_time=0.5
        )
        
        logs = storage.get_logs(limit=10)
        assert len(logs) == 1
        assert logs[0]["function_name"] == "test_func"
    
    def test_storage_log_error(self, tmp_path):
        """测试记录错误"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        storage.log(
            function_name="error_func",
            error="Something went wrong",
            exec_time=0.1
        )
        
        logs = storage.get_logs()
        assert logs[0]["error"] == "Something went wrong"
    
    def test_storage_get_stats(self, tmp_path):
        """测试获取统计"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        # 添加一些日志
        storage.log(function_name="func1", exec_time=1.0)
        storage.log(function_name="func2", exec_time=2.0)
        storage.log(function_name="func3", error="error", exec_time=0.5)
        
        stats = storage.get_stats()
        
        assert stats["total_calls"] == 3
        assert stats["total_time"] == 3.5
        assert stats["error_count"] == 1
    
    def test_storage_multiple_logs(self, tmp_path):
        """测试多条日志"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        for i in range(20):
            storage.log(function_name=f"func_{i}", exec_time=0.1 * i)
        
        logs = storage.get_logs(limit=5)
        assert len(logs) == 5
        
        all_logs = storage.get_logs(limit=100)
        assert len(all_logs) == 20


class TestMonitor:
    """Monitor 管理器测试"""
    
    def test_monitor_sqlite_default(self, tmp_path):
        """测试默认 SQLite 后端"""
        db_path = tmp_path / "monitor.db"
        mon = Monitor(str(db_path))
        
        mon.log(function_name="test", exec_time=1.0)
        
        logs = mon.get_logs()
        assert len(logs) == 1
    
    def test_monitor_log_conversation(self, tmp_path):
        """测试记录对话"""
        db_path = tmp_path / "monitor.db"
        mon = Monitor(str(db_path))
        
        mon.log_conversation(
            model="qwen-plus",
            input_prompt="Hello",
            output_content="Hi there!",
            input_tokens=10,
            output_tokens=20,
            exec_time=0.5
        )
        
        logs = mon.get_logs()
        assert len(logs) == 1
        assert logs[0]["function_name"] == "agent_run"
    
    def test_monitor_get_stats(self, tmp_path):
        """测试获取统计"""
        db_path = tmp_path / "monitor.db"
        mon = Monitor(str(db_path))
        
        mon.log(function_name="func1", exec_time=1.0)
        mon.log(function_name="func2", exec_time=2.0)
        
        stats = mon.get_stats()
        
        assert stats["total_calls"] == 2
        assert stats["avg_time"] == 1.5


class TestMonitorDecorator:
    """@monitor 装饰器测试"""
    
    def test_monitor_decorator_sync(self, tmp_path):
        """测试同步函数监控"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        @monitor(storage=storage)
        def my_func(x, y):
            return x + y
        
        result = my_func(1, 2)
        
        assert result == 3
        
        logs = storage.get_logs()
        assert len(logs) == 1
        assert logs[0]["function_name"] == "my_func"
    
    def test_monitor_decorator_with_error(self, tmp_path):
        """测试错误记录"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        @monitor(storage=storage)
        def error_func():
            raise ValueError("Test error")
        
        with pytest.raises(ValueError):
            error_func()
        
        logs = storage.get_logs()
        assert len(logs) == 1
        assert logs[0]["error"] == "Test error"
    
    def test_monitor_decorator_log_options(self, tmp_path):
        """测试日志选项"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        @monitor(storage=storage, log_input=False, log_output=False)
        def secret_func(password):
            return f"secret_{password}"
        
        result = secret_func("12345")
        
        logs = storage.get_logs()
        assert logs[0]["input_args"] is None
        assert logs[0]["output"] is None
    
    @pytest.mark.asyncio
    async def test_monitor_decorator_async(self, tmp_path):
        """测试异步函数监控"""
        import asyncio
        
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        @monitor(storage=storage)
        async def async_func(msg):
            await asyncio.sleep(0.01)
            return f"processed: {msg}"
        
        result = await async_func("hello")
        
        assert result == "processed: hello"
        
        logs = storage.get_logs()
        assert len(logs) == 1


class TestStorageExtraFields:
    """测试存储额外字段"""
    
    def test_log_with_extra(self, tmp_path):
        """测试记录额外字段"""
        db_path = tmp_path / "test.db"
        storage = SQLiteStorage(str(db_path))
        
        storage.log(
            function_name="test",
            exec_time=1.0,
            model="qwen-plus",
            tokens=100
        )
        
        logs = storage.get_logs()
        # 额外字段应该在 extra JSON 中
        assert logs[0]["extra"] is not None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
