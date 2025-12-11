"""
Sakura Media Types - 媒体类型定义

用于处理多媒体内容（图片、音频、视频、文件）
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Union
import base64
import mimetypes


@dataclass
class Image:
    """图片媒体类型"""
    
    # 图片 URL
    url: Optional[str] = None
    # 图片数据（bytes）
    data: Optional[bytes] = None
    # Base64 编码数据
    base64_data: Optional[str] = None
    # 图片路径
    filepath: Optional[str] = None
    # MIME 类型
    mime_type: str = "image/png"
    # 可选描述
    alt_text: Optional[str] = None
    # 额外元数据
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        # 自动检测 MIME 类型
        if self.filepath and self.mime_type == "image/png":
            detected = mimetypes.guess_type(self.filepath)[0]
            if detected:
                self.mime_type = detected
    
    def to_base64(self) -> Optional[str]:
        """转换为 base64 编码"""
        if self.base64_data:
            return self.base64_data
        if self.data:
            return base64.b64encode(self.data).decode("utf-8")
        if self.filepath:
            with open(self.filepath, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")
        return None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "base64": self.to_base64(),
            "mime_type": self.mime_type,
            "alt_text": self.alt_text,
        }


@dataclass
class Audio:
    """音频媒体类型"""
    
    # 音频 URL
    url: Optional[str] = None
    # 音频数据（bytes）
    data: Optional[bytes] = None
    # Base64 编码数据
    base64_data: Optional[str] = None
    # 音频路径
    filepath: Optional[str] = None
    # MIME 类型
    mime_type: str = "audio/mp3"
    # 时长（秒）
    duration: Optional[float] = None
    # 额外元数据
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_base64(self) -> Optional[str]:
        """转换为 base64 编码"""
        if self.base64_data:
            return self.base64_data
        if self.data:
            return base64.b64encode(self.data).decode("utf-8")
        if self.filepath:
            with open(self.filepath, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")
        return None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "base64": self.to_base64(),
            "mime_type": self.mime_type,
            "duration": self.duration,
        }


@dataclass
class Video:
    """视频媒体类型"""
    
    # 视频 URL
    url: Optional[str] = None
    # 视频数据（bytes）
    data: Optional[bytes] = None
    # Base64 编码数据
    base64_data: Optional[str] = None
    # 视频路径
    filepath: Optional[str] = None
    # MIME 类型
    mime_type: str = "video/mp4"
    # 时长（秒）
    duration: Optional[float] = None
    # 缩略图
    thumbnail: Optional[Image] = None
    # 额外元数据
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "mime_type": self.mime_type,
            "duration": self.duration,
        }


@dataclass
class File:
    """文件媒体类型"""
    
    # 文件名
    name: Optional[str] = None
    # 文件 URL
    url: Optional[str] = None
    # 文件数据（bytes）
    data: Optional[bytes] = None
    # Base64 编码数据
    base64_data: Optional[str] = None
    # 文件路径
    filepath: Optional[str] = None
    # MIME 类型
    mime_type: str = "application/octet-stream"
    # 文件大小（字节）
    size: Optional[int] = None
    # 额外元数据
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        # 自动检测 MIME 类型和文件名
        if self.filepath:
            path = Path(self.filepath)
            if not self.name:
                self.name = path.name
            if self.mime_type == "application/octet-stream":
                detected = mimetypes.guess_type(self.filepath)[0]
                if detected:
                    self.mime_type = detected
    
    def to_base64(self) -> Optional[str]:
        """转换为 base64 编码"""
        if self.base64_data:
            return self.base64_data
        if self.data:
            return base64.b64encode(self.data).decode("utf-8")
        if self.filepath:
            with open(self.filepath, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")
        return None
    
    def read_text(self, encoding: str = "utf-8") -> Optional[str]:
        """读取文本内容"""
        if self.data:
            return self.data.decode(encoding)
        if self.filepath:
            with open(self.filepath, "r", encoding=encoding) as f:
                return f.read()
        return None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "url": self.url,
            "mime_type": self.mime_type,
            "size": self.size,
        }
