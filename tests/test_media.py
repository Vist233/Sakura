"""
Tests for Media types

测试 Image, Audio, Video, File 媒体类型
"""

import pytest
import base64
import tempfile
from pathlib import Path

from sakura.media import Image, Audio, Video, File


class TestImage:
    """Image 类测试"""
    
    def test_image_creation_with_url(self):
        """测试通过 URL 创建图片"""
        img = Image(url="https://example.com/image.png")
        
        assert img.url == "https://example.com/image.png"
        assert img.mime_type == "image/png"
    
    def test_image_creation_with_data(self):
        """测试通过数据创建图片"""
        data = b"fake image data"
        img = Image(data=data)
        
        assert img.data == data
    
    def test_image_creation_with_base64(self):
        """测试通过 base64 创建图片"""
        b64 = base64.b64encode(b"test data").decode()
        img = Image(base64_data=b64)
        
        assert img.base64_data == b64
    
    def test_image_from_filepath(self, temp_image):
        """测试从文件路径创建图片"""
        img = Image(filepath=temp_image)
        
        assert img.filepath == temp_image
        assert img.mime_type == "image/png"
    
    def test_image_to_base64_from_data(self):
        """测试从数据转换为 base64"""
        data = b"test image data"
        img = Image(data=data)
        
        result = img.to_base64()
        
        assert result == base64.b64encode(data).decode("utf-8")
    
    def test_image_to_base64_from_file(self, temp_image):
        """测试从文件转换为 base64"""
        img = Image(filepath=temp_image)
        
        result = img.to_base64()
        
        assert result is not None
        # 验证是有效的 base64
        decoded = base64.b64decode(result)
        assert len(decoded) > 0
    
    def test_image_to_dict(self):
        """测试图片序列化"""
        img = Image(
            url="https://example.com/img.jpg",
            mime_type="image/jpeg",
            alt_text="Test image"
        )
        
        result = img.to_dict()
        
        assert result["url"] == "https://example.com/img.jpg"
        assert result["mime_type"] == "image/jpeg"
        assert result["alt_text"] == "Test image"
    
    def test_image_auto_mime_detection(self, tmp_path):
        """测试自动 MIME 类型检测"""
        # 创建一个 .jpg 文件
        jpg_path = tmp_path / "test.jpg"
        jpg_path.write_bytes(b"fake jpg data")
        
        img = Image(filepath=str(jpg_path))
        
        assert img.mime_type == "image/jpeg"


class TestAudio:
    """Audio 类测试"""
    
    def test_audio_creation_with_url(self):
        """测试通过 URL 创建音频"""
        audio = Audio(url="https://example.com/audio.mp3")
        
        assert audio.url == "https://example.com/audio.mp3"
        assert audio.mime_type == "audio/mp3"
    
    def test_audio_creation_with_data(self):
        """测试通过数据创建音频"""
        data = b"fake audio data"
        audio = Audio(data=data)
        
        assert audio.data == data
    
    def test_audio_with_duration(self):
        """测试带时长的音频"""
        audio = Audio(
            url="https://example.com/song.mp3",
            duration=180.5
        )
        
        assert audio.duration == 180.5
    
    def test_audio_to_base64(self):
        """测试转换为 base64"""
        data = b"audio content"
        audio = Audio(data=data)
        
        result = audio.to_base64()
        
        assert result == base64.b64encode(data).decode("utf-8")
    
    def test_audio_to_dict(self):
        """测试序列化"""
        audio = Audio(
            url="https://example.com/audio.wav",
            mime_type="audio/wav",
            duration=60.0
        )
        
        result = audio.to_dict()
        
        assert result["url"] == "https://example.com/audio.wav"
        assert result["duration"] == 60.0


class TestVideo:
    """Video 类测试"""
    
    def test_video_creation_with_url(self):
        """测试通过 URL 创建视频"""
        video = Video(url="https://example.com/video.mp4")
        
        assert video.url == "https://example.com/video.mp4"
        assert video.mime_type == "video/mp4"
    
    def test_video_with_duration(self):
        """测试带时长的视频"""
        video = Video(
            url="https://example.com/movie.mp4",
            duration=7200.0
        )
        
        assert video.duration == 7200.0
    
    def test_video_with_thumbnail(self):
        """测试带缩略图的视频"""
        thumb = Image(url="https://example.com/thumb.jpg")
        video = Video(
            url="https://example.com/video.mp4",
            thumbnail=thumb
        )
        
        assert video.thumbnail is not None
        assert video.thumbnail.url == "https://example.com/thumb.jpg"
    
    def test_video_to_dict(self):
        """测试序列化"""
        video = Video(
            url="https://example.com/clip.mp4",
            mime_type="video/mp4",
            duration=30.0
        )
        
        result = video.to_dict()
        
        assert result["url"] == "https://example.com/clip.mp4"
        assert result["duration"] == 30.0


class TestFile:
    """File 类测试"""
    
    def test_file_creation_with_url(self):
        """测试通过 URL 创建文件"""
        file = File(
            name="document.pdf",
            url="https://example.com/doc.pdf"
        )
        
        assert file.name == "document.pdf"
        assert file.url == "https://example.com/doc.pdf"
    
    def test_file_creation_with_data(self):
        """测试通过数据创建文件"""
        data = b"file content here"
        file = File(data=data)
        
        assert file.data == data
    
    def test_file_from_filepath(self, temp_file):
        """测试从文件路径创建"""
        file = File(filepath=temp_file)
        
        assert file.filepath == temp_file
        assert file.name == "test_file.txt"
    
    def test_file_auto_name_detection(self, tmp_path):
        """测试自动文件名检测"""
        file_path = tmp_path / "auto_name.json"
        file_path.write_text('{"key": "value"}')
        
        file = File(filepath=str(file_path))
        
        assert file.name == "auto_name.json"
    
    def test_file_auto_mime_detection(self, tmp_path):
        """测试自动 MIME 类型检测"""
        json_path = tmp_path / "data.json"
        json_path.write_text('{}')
        
        file = File(filepath=str(json_path))
        
        assert file.mime_type == "application/json"
    
    def test_file_to_base64(self, temp_file):
        """测试转换为 base64"""
        file = File(filepath=temp_file)
        
        result = file.to_base64()
        
        assert result is not None
        # 验证解码后内容正确
        decoded = base64.b64decode(result).decode("utf-8")
        assert decoded == "Hello, World!"
    
    def test_file_read_text(self, temp_file):
        """测试读取文本内容"""
        file = File(filepath=temp_file)
        
        content = file.read_text()
        
        assert content == "Hello, World!"
    
    def test_file_read_text_from_data(self):
        """测试从数据读取文本"""
        data = "Text content from data".encode("utf-8")
        file = File(data=data)
        
        content = file.read_text()
        
        assert content == "Text content from data"
    
    def test_file_to_dict(self):
        """测试序列化"""
        file = File(
            name="report.pdf",
            url="https://example.com/report.pdf",
            mime_type="application/pdf",
            size=1024
        )
        
        result = file.to_dict()
        
        assert result["name"] == "report.pdf"
        assert result["url"] == "https://example.com/report.pdf"
        assert result["size"] == 1024
    
    def test_file_with_metadata(self):
        """测试带元数据的文件"""
        file = File(
            name="doc.txt",
            metadata={"author": "Test", "version": "1.0"}
        )
        
        assert file.metadata["author"] == "Test"
        assert file.metadata["version"] == "1.0"
