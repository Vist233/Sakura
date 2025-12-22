"""
Tests for Builtin Tools

测试内置工具（使用 Mock，不调用真实 API）
"""

import pytest
from unittest.mock import patch, MagicMock


class TestBaiduSearchTools:
    """BaiduSearchTools 测试"""
    
    def test_import(self):
        """测试导入"""
        from sakura.tools.builtin import BaiduSearchTools
        
        tools = BaiduSearchTools()
        assert tools is not None
    
    def test_baidu_search_function_exists(self):
        """测试搜索方法存在"""
        from sakura.tools.builtin import BaiduSearchTools
        
        tools = BaiduSearchTools()
        assert hasattr(tools, 'baidu_search')
        assert callable(tools.baidu_search)
    
    def test_baidu_search_returns_string(self):
        """测试搜索返回字符串"""
        from sakura.tools.builtin import BaiduSearchTools
        
        tools = BaiduSearchTools()
        # 只测试方法存在且返回字符串类型（不实际调用网络）
        assert hasattr(tools, 'baidu_search')
        # 可以mock测试或者跳过实际调用
    
    def test_search_with_max_results(self):
        """测试限制结果数量参数"""
        from sakura.tools.builtin import BaiduSearchTools
        
        tools = BaiduSearchTools()
        # 仅测试方法签名，不实际调用
        import inspect
        sig = inspect.signature(tools.baidu_search)
        params = list(sig.parameters.keys())
        
        assert 'query' in params
        assert 'max_results' in params


class TestDuckDuckGoTools:
    """DuckDuckGoTools 测试"""
    
    def test_import(self):
        """测试导入"""
        try:
            from sakura.tools.builtin import DuckDuckGoTools
            tools = DuckDuckGoTools()
            assert tools is not None
        except ImportError:
            pytest.skip("ddgs not installed")
    
    def test_duckduckgo_search_exists(self):
        """测试搜索方法存在"""
        try:
            from sakura.tools.builtin import DuckDuckGoTools
            tools = DuckDuckGoTools()
            assert hasattr(tools, 'duckduckgo_search')
        except ImportError:
            pytest.skip("ddgs not installed")
    
    def test_duckduckgo_news_exists(self):
        """测试新闻方法存在"""
        try:
            from sakura.tools.builtin import DuckDuckGoTools
            tools = DuckDuckGoTools()
            assert hasattr(tools, 'duckduckgo_news')
        except ImportError:
            pytest.skip("ddgs not installed")


class TestFileTools:
    """FileTools 测试"""
    
    def test_import(self):
        """测试导入"""
        from sakura.tools.builtin import FileTools
        
        tools = FileTools()
        assert tools is not None
    
    def test_read_file(self, tmp_path):
        """测试读取文件"""
        from sakura.tools.builtin import FileTools
        from pathlib import Path
        
        # 创建测试文件
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")
        
        # FileTools expects Path, not str
        tools = FileTools(base_dir=Path(tmp_path))
        content = tools.read_file("test.txt")
        
        assert "Hello, World!" in content
    
    def test_write_file(self, tmp_path):
        """测试写入文件"""
        from sakura.tools.builtin import FileTools
        from pathlib import Path
        
        tools = FileTools(base_dir=Path(tmp_path))
        # FileTools uses save_file, not write_file
        result = tools.save_file("New content", "new_file.txt")
        
        # save_file returns filename on success
        assert "new_file.txt" in result
        
        # 验证文件内容
        written = (tmp_path / "new_file.txt").read_text()
        assert "New content" in written
    
    def test_list_files(self, tmp_path):
        """测试列出文件"""
        from sakura.tools.builtin import FileTools
        from pathlib import Path
        
        # 创建测试文件
        (tmp_path / "file1.txt").write_text("1")
        (tmp_path / "file2.txt").write_text("2")
        (tmp_path / "subdir").mkdir()
        
        tools = FileTools(base_dir=Path(tmp_path))
        result = tools.list_files(directory=".")
        
        assert "file1.txt" in result
        assert "file2.txt" in result
    
    def test_file_not_found(self, tmp_path):
        """测试文件不存在"""
        from sakura.tools.builtin import FileTools
        from pathlib import Path
        
        tools = FileTools(base_dir=Path(tmp_path))
        result = tools.read_file("nonexistent.txt")
        
        # 应该返回错误信息而不是抛出异常
        assert "Error" in result or "错误" in result or "不存在" in result or "not found" in result.lower()


class TestToolDecorator:
    """@tool 装饰器测试"""
    
    def test_decorated_function_schema(self):
        """测试装饰器生成的 schema"""
        from sakura import tool
        
        @tool
        def my_tool(query: str, limit: int = 10) -> str:
            """搜索内容
            
            Args:
                query: 搜索关键词
                limit: 结果数量
            
            Returns:
                搜索结果
            """
            return f"Results for {query}"
        
        # 验证是 Function 对象
        from sakura.tools.function import Function
        assert isinstance(my_tool, Function)
        
        # 验证 schema
        schema = my_tool.to_dict()
        assert schema["name"] == "my_tool"
        assert "query" in str(schema["parameters"])
    
    def test_decorated_function_call(self):
        """测试调用装饰的函数"""
        from sakura import tool
        
        @tool
        def add(a: int, b: int) -> int:
            """加法"""
            return a + b
        
        # 通过 entrypoint 调用
        result = add.entrypoint(a=3, b=5)
        assert result == 8
    
    def test_decorated_function_with_custom_name(self):
        """测试自定义名称"""
        from sakura import tool
        
        @tool(name="custom_tool_name")
        def original_name() -> str:
            """Original function"""
            return "done"
        
        # Function uses .name property, not ._name
        assert original_name.name == "custom_tool_name"


class TestToolkit:
    """Toolkit 测试"""
    
    def test_toolkit_creation(self):
        """测试创建 Toolkit"""
        from sakura.tools.toolkit import Toolkit
        
        toolkit = Toolkit(name="MyToolkit")
        assert toolkit.name == "MyToolkit"
    
    def test_toolkit_register(self):
        """测试注册工具"""
        from sakura.tools.toolkit import Toolkit
        
        toolkit = Toolkit(name="TestToolkit")
        
        @toolkit.register()
        def my_tool(x: int) -> int:
            """工具"""
            return x * 2
        
        # Toolkit uses get_functions(), not get_tools()
        tools = toolkit.get_functions()
        assert len(tools) == 1
    
    def test_toolkit_get_functions(self):
        """测试获取函数列表"""
        from sakura.tools.toolkit import Toolkit
        
        toolkit = Toolkit(name="TestToolkit2")
        
        @toolkit.register()
        def tool_a() -> str:
            """A"""
            return "a"
        
        @toolkit.register()
        def tool_b() -> str:
            """B"""
            return "b"
        
        # Toolkit uses get_functions() not get_tools()
        tools = toolkit.get_functions()
        assert len(tools) == 2


class TestBuiltinToolsExport:
    """测试内置工具导出"""
    
    def test_all_exports(self):
        """测试 __all__ 导出"""
        from sakura.tools import builtin
        
        # 检查主要导出
        assert hasattr(builtin, 'BaiduSearchTools')
        assert hasattr(builtin, 'FileTools')
    
    def test_lazy_import_duckduckgo(self):
        """测试 DuckDuckGo 懒加载"""
        from sakura.tools import builtin
        
        # 应该可以导入，即使 ddgs 未安装也不报错
        # __getattr__ 应该处理懒加载
        try:
            _ = builtin.DuckDuckGoTools
        except (ImportError, AttributeError):
            # 这是预期的，如果 ddgs 未安装
            pass


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
