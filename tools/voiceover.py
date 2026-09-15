#!/usr/bin/env python3
"""
iPod Shuffle VoiceOver 语音生成模块（参考实现）。

用途：把曲目信息合成为 WAV，写入 iPod_Control/Speakable/Tracks/，
      使 shuffle 在按下 VoiceOver 按钮时"念出"当前曲目。

已实机验证的规则
----------------
1. 目录：**`iPod_Control/Speakable/Tracks/`**（注意 Speakable 在 iPod_Control 之内，
   不在 iPod 根目录下）。
2. 文件名 = 该曲目 dbid（8 字节）**逐字节倒序**后的十六进制大写 + ".wav"。
   例：dbid = 5c da 28 4d 1d 1a 10 83  ->  83101A1D4D28DA5C.wav
   设备上 13 首 **13/13 全部命中**。
3. dbid 的生成方式 = md5(播报文本 utf-8)[:8]（沿用社区 4G 工具的做法）。
   实机确认 Apple 自己的 dbid **不是**任何可推导的哈希，是不可解释的随机 ID，
   因此 dbid 只是"不透明标识符"——我们自定义确定性方案完全合法，
   只要保证 dbid 与语音文件名成对出现即可。
4. 总开关在 iTunesSD 根头第 29 字节（voiceover_enabled）。
   本机 Apple 原值 = 1；重建数据库时必须原样保留，否则整机静音。
   **它是全局开关，不是逐曲开关。**

WAV 容器格式（已实机逐字节确认，全部 13 个文件一致）
--------------------------------------------------
    [0:4]      "RIFF"
    [4:8]      riff_size = 文件总长 - 8
    [8:12]     "WAVE"
    [12:16]    "fmt "
    [16:20]    16
    [20:36]    PCM 描述：audioformat=1, channels=1, samplerate, byterate,
               blockalign, bits
    [36:40]    "FLLR"
    [40:44]    4044
    [44:4088]  4044 字节全零填充
    [4088:4092] "data"
    [4092:4096] PCM 数据长度
    [4096:]    PCM 数据
  → 头部固定 4096 字节；格式 22050 Hz / 16 bit / 单声道 PCM。

  Windows SAPI 直接输出的是 46 字节紧凑头、且 `fmt ` 块为 18 字节。
  本模块**统一重打包为上面的 Apple 容器**，避免任何格式兼容性猜测。

命令行
------
    python voiceover.py voices                 # 列出系统可用语音
    python voiceover.py say "文本" -o out.wav   # 合成单个文件
    python voiceover.py inspect out.wav        # 检查 WAV 容器结构
"""
import os
import sys
import struct
import hashlib
import argparse

# SAPI SpAudioFormatType —— 单声道 16 位 PCM 的各采样率取值
SAFT_MONO16 = {
    8000: 6, 11025: 10, 12000: 14, 16000: 18, 22050: 22,
    24000: 26, 32000: 30, 44100: 34, 48000: 38,
}

DEFAULT_RATE = 22050      # 与设备上 Apple 文件完全一致
APPLE_HEADER_LEN = 4096   # Apple VoiceOver WAV 的固定头部长度

PREFERRED_VOICES = (      # 中文语音优先级
    "Microsoft Huihui Desktop",
    "Microsoft Xiaoxiao",
    "Microsoft Yaoyao",
    "Microsoft Kangkang",
)


# ---------------------------------------------------------------- 命名规则

def voice_filename(dbid: bytes) -> str:
    """dbid(8B) -> VoiceOver WAV 文件名（倒序十六进制大写）。"""
    return "".join(f"{b:02X}" for b in reversed(dbid)) + ".wav"


def dbid_from_text(text: str) -> bytes:
    """播报文本 -> dbid。确定性映射，保证重复导入自动复用同一语音文件。"""
    return hashlib.md5(text.encode("utf-8")).digest()[:8]


def unique_dbids(texts, seed_of=None):
    """为一批文本分配互不冲突的 dbid。

    同一首歌导入两次时 md5 会撞车（dbid 相同 -> 共用语音文件）。
    这里在同批次内检测冲突，给后续重复项追加序号后缀再哈希，
    使「同曲名不同文件」也能各自拥有独立语音。
    """
    seen, out = {}, []
    for i, text in enumerate(texts):
        base = text
        n = seen.get(base, 0)
        seen[base] = n + 1
        key = base if n == 0 else f"{base}\x1f#{n + 1}"
        if seed_of:
            key = seed_of(i, key)
        out.append(dbid_from_text(key))
    return out


# ---------------------------------------------------------------- WAV 解析 / 封装

def parse_wav(path):
    """解析 RIFF/WAVE，返回格式与 data 块位置。支持 Apple 的 4096 字节头。"""
    with open(path, "rb") as fh:
        d = fh.read()
    if d[0:4] != b"RIFF" or d[8:12] != b"WAVE":
        return None
    fmt = data_off = data_size = None
    i = 12
    while i + 8 <= len(d):
        cid, sz = d[i:i + 4], struct.unpack("<I", d[i + 4:i + 8])[0]
        if cid == b"fmt ":
            af, ch, sr, br, ba, bits = struct.unpack("<HHIIHH", d[i + 8:i + 24])
            fmt = dict(audio_format=af, channels=ch, rate=sr, byte_rate=br,
                       block_align=ba, bits=bits, pcm=(af == 1))
        elif cid == b"data":
            data_off, data_size = i + 8, sz
            break
        i += 8 + sz + (sz & 1)
    if not fmt or data_off is None:
        return None
    fmt.update(file_size=len(d), data_offset=data_off, data_size=data_size,
               duration=data_size / fmt["byte_rate"] if fmt["byte_rate"] else 0,
               raw=d)
    return fmt


def read_wav_format(path):
    """兼容旧调用：返回精简格式信息。"""
    i = parse_wav(path)
    if not i:
        return None
    return dict(channels=i["channels"], rate=i["rate"], bits=i["bits"],
                duration=i["duration"], pcm=i["pcm"])


def build_apple_wav(pcm: bytes, rate=DEFAULT_RATE, channels=1, bits=16) -> bytes:
    """把裸 PCM 包装成 Apple VoiceOver 的 WAV 容器（4096 字节头）。"""
    block_align = channels * bits // 8
    byte_rate = rate * block_align
    header = bytearray(APPLE_HEADER_LEN)
    header[0:4] = b"RIFF"
    struct.pack_into("<I", header, 4, APPLE_HEADER_LEN + len(pcm) - 8)
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    struct.pack_into("<I", header, 16, 16)
    struct.pack_into("<HHIIHH", header, 20, 1, channels, rate,
                     byte_rate, block_align, bits)
    header[36:40] = b"FLLR"
    struct.pack_into("<I", header, 40, APPLE_HEADER_LEN - 52)   # 4044
    # [44:4088] 已是全零填充
    header[4088:4092] = b"data"
    struct.pack_into("<I", header, 4092, len(pcm))
    return bytes(header) + pcm


def repack_to_apple(src_wav, dst_wav):
    """把任意 PCM WAV 转为 Apple 容器格式。返回新文件格式信息。"""
    i = parse_wav(src_wav)
    if not i or not i["pcm"]:
        raise ValueError(f"{src_wav} 不是 PCM WAV，无法转换")
    if i["channels"] != 1 or i["bits"] != 16:
        raise ValueError(f"仅支持 单声道16位，当前 {i['channels']}ch/{i['bits']}bit")
    pcm = i["raw"][i["data_offset"]:i["data_offset"] + i["data_size"]]
    with open(dst_wav, "wb") as fh:
        fh.write(build_apple_wav(pcm, rate=i["rate"], channels=i["channels"], bits=i["bits"]))
        fh.flush()
        os.fsync(fh.fileno())
    return read_wav_format(dst_wav)


# ---------------------------------------------------------------- TTS 引擎

class SapiTts:
    """Windows 内置 SAPI5 语音合成。中文播报无需联网、无需额外依赖。"""

    def __init__(self):
        import win32com.client as _w          # pywin32
        self._w = _w
        self._voice = _w.Dispatch("SAPI.SpVoice")

    def voices(self):
        return [t.GetDescription() for t in self._voice.GetVoices()]

    def pick_voice(self, prefer=None):
        avail = self.voices()
        for want in ([prefer] if prefer else []) + list(PREFERRED_VOICES):
            if want and want in avail:
                return want
        for v in avail:                        # 退而求其次：任何中文语音
            if "Chinese" in v:
                return v
        return avail[0] if avail else None

    def synth(self, text, out_path, rate=DEFAULT_RATE, voice=None, speed=0,
              apple_container=True):
        """合成到 WAV。默认重打包为 Apple 容器格式。

        speed 为 SAPI 语速 -10..10。
        """
        if rate not in SAFT_MONO16:
            raise ValueError(f"不支持的采样率 {rate}，可选 {sorted(SAFT_MONO16)}")
        voice = voice or self.pick_voice()
        out_path = os.path.abspath(out_path)
        work = out_path + ".raw.wav" if apple_container else out_path

        stream = self._w.Dispatch("SAPI.SpFileStream")
        stream.Format.Type = SAFT_MONO16[rate]      # 必须在 Open 之前设置
        stream.Open(work, 3, False)                 # 3 = SSFMCreateForWrite
        try:
            self._voice.AudioOutputStream = stream
            if voice:
                for t in self._voice.GetVoices():
                    if t.GetDescription() == voice:
                        self._voice.Voice = t
                        break
            self._voice.Rate = max(-10, min(10, speed))
            self._voice.Volume = 100
            self._voice.Speak(text)
        finally:
            stream.Close()

        if apple_container:
            try:
                info = repack_to_apple(work, out_path)
            finally:
                if os.path.exists(work):
                    os.remove(work)
        else:
            info = read_wav_format(out_path)
        return info


def get_tts():
    try:
        return SapiTts()
    except ImportError:
        sys.exit("需要 pywin32：pip install pywin32")


# ---------------------------------------------------------------- 播报文本

def announce_text(title, artist=None, album=None):
    """拼装播报文本。先曲名，有艺术家时追加。"""
    parts = [p.strip() for p in (title, artist) if p and p.strip()]
    return " - ".join(parts) if parts else ""


# ---------------------------------------------------------------- CLI

def _inspect(path):
    i = parse_wav(path)
    if not i:
        print(f"{path}: 不是有效的 RIFF/WAVE")
        return
    print(f"{path}")
    print(f"  文件 {i['file_size']} B   头部 {i['data_offset']} B   "
          f"PCM 数据 {i['data_size']} B")
    print(f"  fmt: audiofmt={i['audio_format']} {i['channels']}ch {i['rate']}Hz "
          f"{i['bits']}bit  blockAlign={i['block_align']}")
    print(f"  时长 {i['duration']:.3f}s")
    chunks, j = [], 12
    while j + 8 <= i["file_size"] and j < i["data_offset"]:
        cid, sz = i["raw"][j:j + 4].decode("latin1"), struct.unpack("<I", i["raw"][j + 4:j + 8])[0]
        chunks.append(f"{cid!r}({sz})")
        if cid == "data":
            break
        j += 8 + sz + (sz & 1)
    print(f"  chunks: {' + '.join(chunks)}")
    print(f"  Apple 容器: {'是' if i['data_offset'] == APPLE_HEADER_LEN else '否'}")


def main():
    ap = argparse.ArgumentParser(description="iPod Shuffle VoiceOver 语音生成")
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("voices", help="列出系统可用语音")

    p = sub.add_parser("say", help="合成一段文本到 WAV")
    p.add_argument("text")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--rate", type=int, default=DEFAULT_RATE)
    p.add_argument("--voice", default=None)
    p.add_argument("--speed", type=int, default=0)
    p.add_argument("--raw", action="store_true", help="保留 SAPI 原始紧凑头，不重打包")

    p = sub.add_parser("inspect", help="检查 WAV 容器结构")
    p.add_argument("path")

    p = sub.add_parser("name", help="演示 dbid -> 文件名映射")
    p.add_argument("text")

    a = ap.parse_args()
    if a.cmd == "voices":
        t = get_tts()
        cur = t.pick_voice()
        for v in t.voices():
            print(("  * " if v == cur else "    ") + v)
        print(f"\n默认选用: {cur}")
    elif a.cmd == "say":
        t = get_tts()
        info = t.synth(a.text, a.out, rate=a.rate, voice=a.voice, speed=a.speed,
                       apple_container=not a.raw)
        print(f"{a.out}  {info}")
    elif a.cmd == "inspect":
        _inspect(a.path)
    elif a.cmd == "name":
        dbid = dbid_from_text(a.text)
        print(f"dbid      = {dbid.hex()}")
        print(f"VoiceOver = iPod_Control/Speakable/Tracks/{voice_filename(dbid)}")
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
