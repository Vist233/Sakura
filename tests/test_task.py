"""
Task Tool 单元测试

测试覆盖：
- 任务 CRUD 操作
- 优先级管理
- 子任务关系
- 状态转换（强制单一 in_progress）
- 持久化功能
- 错误处理
"""

import json
import sys
import tempfile
from pathlib import Path

import pytest

# 添加项目父目录到 path（与 conftest.py 保持一致）
_project_root = Path(__file__).parent.parent
_parent_dir = _project_root.parent
if str(_parent_dir) not in sys.path:
    sys.path.insert(0, str(_parent_dir))

from sakura.tools.builtin.task import (
    Task,
    TaskManager,
    TaskPriority,
    TaskStatus,
    task,
    get_task_manager,
    set_task_manager,
)


class TestTaskDataClass:
    """测试 Task 数据类"""

    def test_task_creation_with_defaults(self):
        """测试默认值创建任务"""
        t = Task()
        assert t.id is not None
        assert len(t.id) == 8
        assert t.description == ""
        assert t.status == TaskStatus.PENDING
        assert t.priority == TaskPriority.MEDIUM
        assert t.parent_id is None
        assert t.completed_at is None
        assert t.metadata == {}

    def test_task_creation_with_values(self):
        """测试指定值创建任务"""
        t = Task(
            id="test123",
            description="测试任务",
            status=TaskStatus.IN_PROGRESS,
            priority=TaskPriority.HIGH,
            parent_id="parent1",
            metadata={"key": "value"}
        )
        assert t.id == "test123"
        assert t.description == "测试任务"
        assert t.status == TaskStatus.IN_PROGRESS
        assert t.priority == TaskPriority.HIGH
        assert t.parent_id == "parent1"
        assert t.metadata == {"key": "value"}

    def test_task_string_to_enum_conversion(self):
        """测试字符串自动转换为枚举"""
        t = Task(status="completed", priority="critical")
        assert t.status == TaskStatus.COMPLETED
        assert t.priority == TaskPriority.CRITICAL


class TestTaskManager:
    """测试 TaskManager 管理器"""

    def setup_method(self):
        """每个测试前创建新的管理器"""
        self.manager = TaskManager()

    def teardown_method(self):
        """每个测试后清理"""
        self.manager.clear()

    def test_add_task(self):
        """测试添加任务"""
        t = self.manager.add("新任务", priority="high")
        assert t.description == "新任务"
        assert t.priority == TaskPriority.HIGH
        assert t.status == TaskStatus.PENDING
        assert t.id in [task.id for task in self.manager.list_all()]

    def test_add_subtask(self):
        """测试添加子任务"""
        parent = self.manager.add("父任务")
        child = self.manager.add("子任务", parent_id=parent.id)
        assert child.parent_id == parent.id

    def test_update_status(self):
        """测试更新状态"""
        t = self.manager.add("任务")
        updated = self.manager.update_status(t.id, "in_progress")
        assert updated.status == TaskStatus.IN_PROGRESS

    def test_update_status_completed_sets_timestamp(self):
        """测试完成任务时设置时间戳"""
        t = self.manager.add("任务")
        updated = self.manager.update_status(t.id, "completed")
        assert updated.completed_at is not None

    def test_single_in_progress_enforcement(self):
        """测试强制单一 in_progress"""
        t1 = self.manager.add("任务1")
        t2 = self.manager.add("任务2")
        
        # 设置第一个为进行中
        self.manager.update_status(t1.id, "in_progress")
        assert self.manager.get(t1.id).status == TaskStatus.IN_PROGRESS
        
        # 设置第二个为进行中，第一个应该变回 pending
        self.manager.update_status(t2.id, "in_progress")
        assert self.manager.get(t1.id).status == TaskStatus.PENDING
        assert self.manager.get(t2.id).status == TaskStatus.IN_PROGRESS

    def test_delete_task(self):
        """测试删除任务"""
        t = self.manager.add("任务")
        assert self.manager.delete(t.id) is True
        assert self.manager.get(t.id) is None

    def test_delete_task_with_subtasks(self):
        """测试删除任务同时删除子任务"""
        parent = self.manager.add("父任务")
        child = self.manager.add("子任务", parent_id=parent.id)
        
        self.manager.delete(parent.id)
        assert self.manager.get(parent.id) is None
        assert self.manager.get(child.id) is None

    def test_delete_nonexistent_task(self):
        """测试删除不存在的任务"""
        assert self.manager.delete("nonexistent") is False

    def test_update_nonexistent_task(self):
        """测试更新不存在的任务"""
        with pytest.raises(ValueError, match="任务不存在"):
            self.manager.update_status("nonexistent", "completed")

    def test_list_formatted_empty(self):
        """测试空列表格式化"""
        output = self.manager.list_formatted()
        assert "暂无任务" in output

    def test_list_formatted_with_tasks(self):
        """测试任务列表格式化"""
        self.manager.add("任务1", priority="high")
        self.manager.add("任务2", priority="low")
        
        output = self.manager.list_formatted()
        assert "任务1" in output
        assert "任务2" in output
        assert "🟠" in output  # high priority
        assert "🟢" in output  # low priority

    def test_list_formatted_with_subtasks(self):
        """测试子任务格式化"""
        parent = self.manager.add("父任务")
        self.manager.add("子任务", parent_id=parent.id)
        
        output = self.manager.list_formatted()
        assert "父任务" in output
        assert "子任务" in output


class TestTaskManagerPersistence:
    """测试 TaskManager 持久化"""

    def test_persist_and_load(self):
        """测试持久化和加载"""
        # 使用临时目录创建新文件路径（不预先创建文件）
        with tempfile.TemporaryDirectory() as tmpdir:
            persist_path = Path(tmpdir) / "tasks.json"
            
            # 创建并保存任务
            manager1 = TaskManager(persist_path=str(persist_path))
            t = manager1.add("持久化任务", priority="critical")
            task_id = t.id
            
            # 创建新管理器，应该加载之前的任务
            manager2 = TaskManager(persist_path=str(persist_path))
            loaded = manager2.get(task_id)
            
            assert loaded is not None
            assert loaded.description == "持久化任务"
            assert loaded.priority == TaskPriority.CRITICAL


class TestTaskToolFunction:
    """测试 task() 工具函数
    
    注意：@tool 装饰器返回 Function 对象，需要通过 entrypoint 属性调用
    """

    def setup_method(self):
        """每个测试前重置全局管理器"""
        get_task_manager().clear()

    def test_task_add(self):
        """测试添加任务"""
        result = task.entrypoint(action="add", description="新任务", priority="high")
        assert "✅ 添加任务" in result
        assert "新任务" in result

    def test_task_add_missing_description(self):
        """测试添加任务缺少描述"""
        result = task.entrypoint(action="add")
        assert "❌ 错误" in result

    def test_task_update(self):
        """测试更新任务"""
        # 先添加任务
        add_result = task.entrypoint(action="add", description="任务")
        # 从结果中提取任务 ID
        task_id = add_result.split("[")[1].split("]")[0]
        
        # 更新任务
        result = task.entrypoint(action="update", task_id=task_id, status="in_progress")
        assert "✅ 更新任务" in result
        assert "in_progress" in result

    def test_task_update_missing_params(self):
        """测试更新任务缺少参数"""
        result = task.entrypoint(action="update")
        assert "❌ 错误" in result

    def test_task_delete(self):
        """测试删除任务"""
        add_result = task.entrypoint(action="add", description="待删除")
        task_id = add_result.split("[")[1].split("]")[0]
        
        result = task.entrypoint(action="delete", task_id=task_id)
        assert "✅ 删除任务" in result

    def test_task_delete_missing_id(self):
        """测试删除任务缺少 ID"""
        result = task.entrypoint(action="delete")
        assert "❌ 错误" in result

    def test_task_list(self):
        """测试列出任务"""
        task.entrypoint(action="add", description="任务1")
        task.entrypoint(action="add", description="任务2")
        
        result = task.entrypoint(action="list")
        assert "任务1" in result
        assert "任务2" in result

    def test_task_subtask(self):
        """测试创建子任务"""
        add_result = task.entrypoint(action="add", description="父任务")
        parent_id = add_result.split("[")[1].split("]")[0]
        
        result = task.entrypoint(action="add", description="子任务", parent_id=parent_id)
        assert "✅ 添加任务" in result
        assert "子任务" in result


class TestTaskEnums:
    """测试枚举类型"""

    def test_task_status_values(self):
        """测试 TaskStatus 枚举值"""
        assert TaskStatus.PENDING.value == "pending"
        assert TaskStatus.IN_PROGRESS.value == "in_progress"
        assert TaskStatus.COMPLETED.value == "completed"
        assert TaskStatus.BLOCKED.value == "blocked"

    def test_task_priority_values(self):
        """测试 TaskPriority 枚举值"""
        assert TaskPriority.LOW.value == "low"
        assert TaskPriority.MEDIUM.value == "medium"
        assert TaskPriority.HIGH.value == "high"
        assert TaskPriority.CRITICAL.value == "critical"

    def test_enum_string_comparison(self):
        """测试枚举可以用字符串比较"""
        assert TaskStatus.PENDING == "pending"
        assert TaskPriority.HIGH == "high"


# ============================================
# 行业最佳实践测试 - 参数化测试
# ============================================

class TestParametrizedPriorities:
    """参数化测试 - 覆盖所有优先级组合"""
    
    @pytest.mark.parametrize("priority,expected_badge", [
        ("low", "🟢"),
        ("medium", "🟡"),
        ("high", "🟠"),
        ("critical", "🔴"),
    ])
    def test_priority_badges(self, priority, expected_badge):
        """测试不同优先级的徽章图标"""
        # Arrange
        manager = TaskManager()
        
        # Act
        manager.add(f"任务-{priority}", priority=priority)
        output = manager.list_formatted()
        
        # Assert
        assert expected_badge in output
        
        # Cleanup
        manager.clear()

    @pytest.mark.parametrize("status,expected_icon", [
        (TaskStatus.PENDING, "⬜"),
        (TaskStatus.IN_PROGRESS, "🔄"),
        (TaskStatus.COMPLETED, "✅"),
        (TaskStatus.BLOCKED, "🚫"),
    ])
    def test_status_icons(self, status, expected_icon):
        """测试不同状态的图标"""
        # Arrange
        manager = TaskManager()
        t = manager.add("测试任务")
        
        # Act
        manager.update_status(t.id, status.value)
        output = manager.list_formatted()
        
        # Assert
        assert expected_icon in output
        
        # Cleanup
        manager.clear()


class TestParametrizedActions:
    """参数化测试 - 覆盖所有操作类型"""
    
    def setup_method(self):
        get_task_manager().clear()
    
    @pytest.mark.parametrize("action,expected_result", [
        ("list", "📋 任务列表"),
        ("add", "❌ 错误"),  # 缺少 description
        ("update", "❌ 错误"),  # 缺少 task_id
        ("delete", "❌ 错误"),  # 缺少 task_id
    ])
    def test_action_without_required_params(self, action, expected_result):
        """测试缺少必要参数时的错误处理"""
        result = task.entrypoint(action=action)
        assert expected_result in result


# ============================================
# 行业最佳实践测试 - 边界条件测试
# ============================================

class TestEdgeCases:
    """边界条件测试"""
    
    def setup_method(self):
        self.manager = TaskManager()
    
    def teardown_method(self):
        self.manager.clear()
    
    def test_empty_description(self):
        """测试空描述"""
        result = task.entrypoint(action="add", description="")
        assert "❌ 错误" in result
    
    def test_whitespace_description(self):
        """测试空白描述仍然可以添加"""
        t = self.manager.add("   ")
        assert t.description == "   "
    
    def test_very_long_description(self):
        """测试超长描述"""
        long_desc = "这是一个非常长的任务描述" * 100
        t = self.manager.add(long_desc)
        assert t.description == long_desc
    
    def test_special_characters_in_description(self):
        """测试特殊字符"""
        special_desc = "任务 [测试] <html> & \"引号\" '单引号' \n换行 \t制表符"
        t = self.manager.add(special_desc)
        assert t.description == special_desc
    
    def test_unicode_emoji_in_description(self):
        """测试 Unicode 和 Emoji"""
        emoji_desc = "🚀 发布新版本 ✨ 日本語 中文 한국어"
        t = self.manager.add(emoji_desc)
        assert t.description == emoji_desc
    
    def test_invalid_status_value(self):
        """测试无效状态值"""
        t = self.manager.add("任务")
        with pytest.raises(ValueError):
            self.manager.update_status(t.id, "invalid_status")
    
    def test_invalid_priority_value(self):
        """测试无效优先级值"""
        with pytest.raises(ValueError):
            self.manager.add("任务", priority="invalid_priority")
    
    def test_update_already_completed_task(self):
        """测试更新已完成任务"""
        t = self.manager.add("任务")
        self.manager.update_status(t.id, "completed")
        # 可以再次更新
        updated = self.manager.update_status(t.id, "in_progress")
        assert updated.status == TaskStatus.IN_PROGRESS
    
    def test_deep_nested_subtasks(self):
        """测试深层嵌套子任务"""
        parent = self.manager.add("层级1")
        for i in range(2, 6):
            child = self.manager.add(f"层级{i}", parent_id=parent.id)
            parent = child
        
        # 确保所有任务都被添加
        assert len(self.manager.list_all()) == 5
    
    def test_multiple_subtasks_same_parent(self):
        """测试同一父任务的多个子任务"""
        parent = self.manager.add("父任务")
        for i in range(5):
            self.manager.add(f"子任务{i}", parent_id=parent.id)
        
        subtasks = self.manager._get_subtasks(parent.id)
        assert len(subtasks) == 5


# ============================================
# 行业最佳实践测试 - 行为验证测试
# ============================================

class TestBehaviorValidation:
    """行为验证测试 - 验证意图而非精确输出"""
    
    def setup_method(self):
        self.manager = TaskManager()
    
    def teardown_method(self):
        self.manager.clear()
    
    def test_task_lifecycle(self):
        """测试任务完整生命周期"""
        # 创建
        t = self.manager.add("生命周期测试")
        assert t.status == TaskStatus.PENDING
        assert t.completed_at is None
        
        # 开始
        t = self.manager.update_status(t.id, "in_progress")
        assert t.status == TaskStatus.IN_PROGRESS
        
        # 阻塞
        t = self.manager.update_status(t.id, "blocked")
        assert t.status == TaskStatus.BLOCKED
        
        # 恢复
        t = self.manager.update_status(t.id, "in_progress")
        assert t.status == TaskStatus.IN_PROGRESS
        
        # 完成
        t = self.manager.update_status(t.id, "completed")
        assert t.status == TaskStatus.COMPLETED
        assert t.completed_at is not None
    
    def test_focus_enforcement_behavior(self):
        """测试聚焦行为：确保同时只有一个任务进行中"""
        # 创建三个任务
        t1 = self.manager.add("任务1")
        t2 = self.manager.add("任务2")
        t3 = self.manager.add("任务3")
        
        # 开始任务1
        self.manager.update_status(t1.id, "in_progress")
        
        # 检查只有一个 in_progress
        in_progress_count = sum(
            1 for t in self.manager.list_all() 
            if t.status == TaskStatus.IN_PROGRESS
        )
        assert in_progress_count == 1
        
        # 开始任务2，任务1 应该变回 pending
        self.manager.update_status(t2.id, "in_progress")
        
        assert self.manager.get(t1.id).status == TaskStatus.PENDING
        assert self.manager.get(t2.id).status == TaskStatus.IN_PROGRESS
        
        in_progress_count = sum(
            1 for t in self.manager.list_all() 
            if t.status == TaskStatus.IN_PROGRESS
        )
        assert in_progress_count == 1
    
    def test_formatted_output_structure(self):
        """测试格式化输出的结构（验证行为而非精确文本）"""
        self.manager.add("任务1", priority="high")
        self.manager.add("任务2", priority="low")
        
        output = self.manager.list_formatted()
        
        # 验证输出结构
        assert "📋 任务列表" in output
        assert "任务1" in output
        assert "任务2" in output
        # 验证优先级徽章存在
        assert "🟠" in output  # high
        assert "🟢" in output  # low


# ============================================
# 行业最佳实践测试 - YAML 持久化测试
# ============================================

class TestYAMLPersistence:
    """YAML 持久化测试"""
    
    def test_yaml_file_format(self):
        """测试 YAML 文件格式正确"""
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "tasks.yaml"
            
            # 创建并保存任务
            manager = TaskManager(persist_path=str(yaml_path))
            manager.add("YAML测试任务", priority="high")
            
            # 读取文件内容
            content = yaml_path.read_text(encoding='utf-8')
            
            # 验证 YAML 格式
            assert "# Sakura Task Tool" in content  # 头部注释
            assert "description: YAML测试任务" in content
            assert "priority: high" in content
    
    def test_yaml_unicode_support(self):
        """测试 YAML 对 Unicode 的支持"""
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "tasks.yaml"
            
            manager1 = TaskManager(persist_path=str(yaml_path))
            manager1.add("中文任务 🚀 日本語", priority="critical")
            
            # 重新加载
            manager2 = TaskManager(persist_path=str(yaml_path))
            tasks = manager2.list_all()
            
            assert len(tasks) == 1
            assert "中文任务 🚀 日本語" in tasks[0].description
    
    def test_yaml_empty_file_handling(self):
        """测试空 YAML 文件处理"""
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "tasks.yaml"
            
            # 创建空文件
            yaml_path.write_text("")
            
            # 应该正常加载，不抛出异常
            manager = TaskManager(persist_path=str(yaml_path))
            assert len(manager.list_all()) == 0
    
    def test_yaml_persistence_multiple_tasks(self):
        """测试多任务 YAML 持久化"""
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "tasks.yaml"
            
            manager1 = TaskManager(persist_path=str(yaml_path))
            manager1.add("任务1", priority="low")
            manager1.add("任务2", priority="medium")
            parent = manager1.add("父任务", priority="high")
            manager1.add("子任务", parent_id=parent.id, priority="critical")
            
            # 重新加载
            manager2 = TaskManager(persist_path=str(yaml_path))
            tasks = manager2.list_all()
            
            assert len(tasks) == 4


# ============================================
# 行业最佳实践测试 - Fixtures 测试
# ============================================

@pytest.fixture
def fresh_task_manager():
    """提供一个干净的 TaskManager 实例"""
    manager = TaskManager()
    yield manager
    manager.clear()


@pytest.fixture
def populated_task_manager():
    """提供一个预填充任务的 TaskManager 实例"""
    manager = TaskManager()
    manager.add("高优先级任务", priority="high")
    manager.add("低优先级任务", priority="low")
    t = manager.add("进行中任务", priority="medium")
    manager.update_status(t.id, "in_progress")
    yield manager
    manager.clear()


class TestWithFixtures:
    """使用 Fixtures 的测试"""
    
    def test_fresh_manager_is_empty(self, fresh_task_manager):
        """测试新管理器为空"""
        assert len(fresh_task_manager.list_all()) == 0
    
    def test_populated_manager_has_tasks(self, populated_task_manager):
        """测试预填充管理器有任务"""
        assert len(populated_task_manager.list_all()) == 3
    
    def test_populated_manager_has_in_progress(self, populated_task_manager):
        """测试预填充管理器有进行中任务"""
        in_progress = [
            t for t in populated_task_manager.list_all() 
            if t.status == TaskStatus.IN_PROGRESS
        ]
        assert len(in_progress) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

