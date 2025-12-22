"""
Tests for Builtin Tools

测试内置工具（需要安装 baidusearch、ddgs 等依赖）
这些测试只在全量测试时运行
"""

import pytest
from unittest.mock import patch, MagicMock


class TestBaiduSearchTools:
    """BaiduSearchTools 测试"""
    
    def test_import(self):
        """测试导入"""
        try:
            from sakura.tools.builtin import BaiduSearchTools
            tools = BaiduSearchTools()
            assert tools is not None
        except ImportError:
            pytest.skip("baidusearch not installed")
    
    def test_baidu_search_function_exists(self):
        """测试搜索方法存在"""
        try:
            from sakura.tools.builtin import BaiduSearchTools
            tools = BaiduSearchTools()
            assert hasattr(tools, 'baidu_search')
            assert callable(tools.baidu_search)
        except ImportError:
            pytest.skip("baidusearch not installed")


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
        
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")
        
        tools = FileTools(base_dir=Path(tmp_path))
        content = tools.read_file("test.txt")
        
        assert "Hello, World!" in content
    
    def test_save_file(self, tmp_path):
        """测试保存文件"""
        from sakura.tools.builtin import FileTools
        from pathlib import Path
        
        tools = FileTools(base_dir=Path(tmp_path))
        result = tools.save_file("New content", "new_file.txt")
        
        assert "new_file.txt" in result
        written = (tmp_path / "new_file.txt").read_text()
        assert "New content" in written
    
    def test_list_files(self, tmp_path):
        """测试列出文件"""
        from sakura.tools.builtin import FileTools
        from pathlib import Path
        
        (tmp_path / "file1.txt").write_text("1")
        (tmp_path / "file2.txt").write_text("2")
        
        tools = FileTools(base_dir=Path(tmp_path))
        result = tools.list_files(directory=".")
        
        assert "file1.txt" in result
        assert "file2.txt" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
