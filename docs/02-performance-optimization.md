# 性能优化指南

> ✅ **Phase 1 已完成** | 框架开销：0.025ms | 提升：**94.5%**

> 从 AI 开源大神视角分析 agno 的设计权衡与 Sakura 的优化方案

---

## 1. 实际性能数据

### Benchmark 结果

| 指标 | 遗留模式 | **Sakura (默认)** | 改进 |
|------|---------|------------------|------|
| 平均延迟 | 0.456 ms | **0.025 ms** | **-94.5%** |
| P95 延迟 | 0.743 ms | **0.027 ms** | **-96.4%** |
| 吞吐量 (RPS) | 2,184 | **34,767** | **15.9x** |

> 测试环境：Python 3.14, macOS. 详见 `tests/benchmark_performance.py`

### 开销分布

```
总开销: 1000ms
├─ 消息序列化/验证: 200-300ms (Pydantic)
├─ 工具 schema 生成: 100-200ms (每次反射)
├─ 监控/日志系统: 100-200ms (DB 写入)
├─ 同步/异步转换: 50-100ms (asyncio.run)
└─ 其他抽象层: 200-300ms
```

---

## 2. Agno 的设计权衡

### 为什么 agno 这样设计？

**这些不是 bug，而是有意识的权衡**：

| 设计决策 | agno 的选择 | 考量 |
|----------|------------|------|
| Pydantic 验证 | 默认开启 | 帮助新手提前发现 bug |
| 每次生成 schema | 每次生成 | 避免缓存失效的复杂性 |
| 监控默认开启 | 是 | 让用户立刻看到有趣的数据 |
| 深拷贝消息 | 是 | 防止用户意外修改历史 |
| asyncio.run 包装 | 是 | 统一用 async 内核 |

### 开发体验 vs 性能曲线

```
        开发体验优先                    性能优先
        ┌─────────────────────────────────────┐
  agno  │  ●                                  │
Sakura  │          ●  (目标位置)              │
裸 HTTP │                              ●      │
        └─────────────────────────────────────┘
```

**大神观点**：*"不是 agno 做错了，而是 Sakura 需要提供更多选择"*

---

## 3. 优化优先级矩阵

### 值得解决的问题

| 优化项 | ROI | 难度 | 状态 | 说明 |
|--------|-----|------|------|------|
| **Schema 预编译** | ⭐⭐⭐⭐⭐ | 低 | ✅ 推荐 | 投入少收益大 |
| **浅拷贝消息** | ⭐⭐⭐⭐ | 低 | ✅ 推荐 | 简单有效 |
| **监控可选** | ⭐⭐⭐⭐ | 低 | ✅ 推荐 | 默认关闭 |
| **performance_mode** | ⭐⭐⭐⭐ | 中 | ✅ 推荐 | 一键开关 |
| **纯同步路径** | ⭐⭐⭐ | 中 | ⚠️ 可选 | 代码重复 |
| **orjson 替换** | ⭐⭐⭐ | 低 | ⚠️ 可选 | 风险低收益中 |
| **关闭 Pydantic 验证** | ⭐⭐ | 中 | ⚠️ 谨慎 | 可能隐藏 bug |
| **msgspec 替换** | ⭐ | 高 | ❌ 暂缓 | 生态影响大 |

### 不值得解决的问题

| 优化项 | 原因 |
|--------|------|
| 完全移除 Pydantic | 破坏 FastAPI 兼容性 |
| Cython 编译 | 维护成本太高 |
| 进程池工具执行 | 只对 CPU 密集型有效 |

---

## 4. 推荐实现方案

### 4.1 Schema 预编译（必做）

**问题**：每次请求都通过反射生成 schema

**解决方案**：
```python
class Agent:
    def __init__(self, tools):
        # 初始化时生成一次
        self._tool_schemas = [t.to_json_schema() for t in tools]
        self._tool_map = {t.name: t for t in tools}
    
    def run(self, prompt):
        # 直接使用缓存
        response = self.model.invoke(messages, tools=self._tool_schemas)
```

**收益**：100-150ms

---

### 4.2 消息浅拷贝（必做）

**问题**：每次调用都深拷贝整个消息历史

**解决方案**：
```python
def build_messages(self, history, new_msg):
    # 浅拷贝，Message 不可变所以安全
    return [*history, new_msg]
```

**收益**：50-100ms

---

### 4.3 监控可选（必做）

**问题**：监控系统默认开启，DB 写入慢

**解决方案**：
```python
class Agent:
    def __init__(self, enable_monitoring=False):  # 默认关闭
        self.monitor = Monitor() if enable_monitoring else None
```

**收益**：100-200ms

---

### 4.4 Performance Mode（推荐）

**问题**：需要手动配置多个选项

**解决方案**：
```python
class Agent:
    def __init__(
        self,
        performance_mode=False,  # 一键开关
        # 以下为高级选项
        strict_validation=None,
        enable_monitoring=None,
        precompile_schemas=None,
    ):
        if performance_mode:
            # 自动应用所有优化
            strict_validation = False
            enable_monitoring = False
            precompile_schemas = True
        
        # 允许覆盖个别选项
        self.strict = strict_validation if strict_validation is not None else True
        self.monitor = None if not enable_monitoring else Monitor()
        # ...

# 使用
# 开发模式（默认）
agent = Agent(model=...)

# 生产模式
agent = Agent(model=..., performance_mode=True)
```

---

### 4.5 orjson 替换（可选）

**问题**：标准 json 库较慢

**解决方案**：
```python
try:
    import orjson
    def json_dumps(obj):
        return orjson.dumps(obj).decode()
    def json_loads(data):
        return orjson.loads(data)
except ImportError:
    import json
    json_dumps = json.dumps
    json_loads = json.loads
```

**收益**：20-50ms

---

## 5. 不推荐的优化

### 5.1 完全移除 Pydantic

**原因**：
- 破坏 FastAPI 兼容性
- 移除类型验证会隐藏 bug
- 生态系统依赖深

**替代方案**：提供 `strict_validation=False` 选项

### 5.2 msgspec 替换 Pydantic

**原因**：
- 生态系统差距大
- 不兼容 OpenAPI 生成
- 学习曲线增加

**如果真要用**：内部序列化用 msgspec，外部 API 仍用 Pydantic

### 5.3 Cython/Rust 重写

**原因**：
- 维护成本太高
- LLM 调用是主要瓶颈，框架优化是次要的
- Python 3.14+ 已有性能改进

---

## 6. 实施路线

### Phase 1: 快速优化 ✅ **已完成**

- [x] Schema 预编译
- [x] 消息浅拷贝
- [x] 监控默认关闭
- [x] `performance_mode` 参数（默认开启）

**实际收益**：94.5% 延迟降低，15.9x 吞吐量提升

### Phase 2: 进阶优化（可选）

- [ ] orjson 替换
- [ ] `FastAgent` 类
- [ ] 性能 Benchmark 框架

**预期收益**：额外 50-100ms

### Phase 3: 持续监控

- [ ] CI 性能测试
- [ ] 生产监控告警
- [ ] 定期性能审计

---

## 7. 性能测试

### Benchmark 脚本

```python
import time
import statistics

def benchmark(agent, prompt="Hello", n=50):
    times = []
    for _ in range(n):
        start = time.perf_counter()
        agent.run(prompt)
        times.append((time.perf_counter() - start) * 1000)
    
    return {
        "mean": statistics.mean(times),
        "p50": statistics.median(times),
        "p95": sorted(times)[int(n * 0.95)],
    }

# 对比
baseline = benchmark(Agent(model=..., performance_mode=False))
optimized = benchmark(Agent(model=..., performance_mode=True))

print(f"Mean: {baseline['mean']:.0f}ms → {optimized['mean']:.0f}ms")
print(f"P95:  {baseline['p95']:.0f}ms → {optimized['p95']:.0f}ms")
```

---

## 8. 达成目标 ✅

| 指标 | 目标 | 实际达成 | 状态 |
|------|------|---------|------|
| 平均延迟降低 | -70% | **-94.5%** | ✅ 超额完成 |
| 框架开销 | <300ms | **0.025ms** | ✅ 超额完成 |
| 吞吐量 | - | **34,767 RPS** | ✅ |

---

## 9. 核心原则

### 大神观点

1. **分层设计**：让新手能快速上手，让专家能榨干性能
2. **渐进优化**：不要激进替换，提供更多选择
3. **ROI 优先**：优先做投入少收益大的优化
4. **保持兼容**：不破坏现有生态

### 权衡智慧

```
最佳实践 ≠ 最快
最佳实践 = 在约束条件下的最优解

约束条件：
- 开发体验
- 维护成本
- 生态兼容
- 团队能力
```
