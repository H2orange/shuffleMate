#!/usr/bin/env python3
"""
iTunesSD 读写参考实现 —— 用于 iPod Shuffle 数据库重建。

本脚本是「写入通路」的验证工具，也是后续 TypeScript 版本的移植基准。
格式已通过「解析设备原文件 → 重新序列化 → 逐字节比对」验证。

用法:
    python itunessd-reference.py probe              # 只读：列出设备上的曲目
    python itunessd-reference.py speakable          # 只读：检查 VoiceOver 文件与格式
    python itunessd-reference.py voiceover [opts]   # 补齐缺失的 VoiceOver 语音
    python itunessd-reference.py validate           # 验证：重建为 3 首的数据库并写入
    python itunessd-reference.py restore            # 还原最近一次备份

安全约束:
    - 只写 iPod_Control/iTunes/iTunesSD 与 iPod_Control/Speakable/Tracks/
    - 永不触碰 Device/、Speakable/System、Speakable/Messages
    - 写入前自动备份，写入后 fsync
"""
import os
import sys
import glob
import struct
import hashlib
import shutil
import argparse
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voiceover  # noqa: E402  同目录模块

ITUNESDB_MHOD = {1: "title", 2: "path", 3: "album", 4: "artist", 5: "genre",
                 6: "filetype_desc", 12: "comment", 13: "composer"}

# ---------------------------------------------------------------- 设备发现

def find_ipod():
    for letter in "FGHIJKLMNOPQRSTUVWXYZABCDE":
        root = f"{letter}:/"
        if os.path.isfile(os.path.join(root, "iPod_Control/iTunes/iTunesSD")):
            return root
    return None


# ---------------------------------------------------------------- 解析

def parse_sd(data):
    """把 iTunesSD 二进制解析成结构化模型。"""
    (_id, version, total_len, n_tracks, n_playlists) = struct.unpack("<4sIIII", data[0:20])
    (unk_q, max_vol, voiceover, unk_h) = struct.unpack("<QBBH", data[20:32])
    (tracks_wo_pod, trk_off, pl_off) = struct.unpack("<III", data[32:44])
    root = dict(version=version, total_len=total_len, n_tracks=n_tracks,
                n_playlists=n_playlists, max_volume=max_vol, voiceover=voiceover,
                tracks_wo_podcasts=tracks_wo_pod, track_header_offset=trk_off,
                playlist_header_offset=pl_off, tail=data[44:64])

    (_h, th_len, th_n, _q) = struct.unpack("<4sIIQ", data[trk_off:trk_off + 20])
    offs = struct.unpack(f"<{th_n}I", data[trk_off + 20:trk_off + 20 + th_n * 4])
    tracks = [parse_track(data[o:o + 372]) for o in offs]

    pg = data[pl_off:pl_off + 72]
    (_p, pl_total, pl_n) = struct.unpack("<4sII", pg[0:12])
    records = []
    for k in range(pl_n):
        lo, = struct.unpack("<I", pg[68 + k * 4:72 + k * 4])
        records.append(parse_playlist(data, lo))
    return dict(root=root, tracks=tracks, playlist_header=pg, playlists=records)


def parse_track(r):
    (_id, hlen, start, stop, gain, ftype) = struct.unpack("<4sIIIII", r[0:24])
    return dict(
        raw=r, header_length=hlen, start_ms=start, stop_ms=stop, volume_gain=gain,
        filetype=ftype,
        filename=r[0x18:0x118].split(b"\x00")[0].decode("utf-8", "replace"),
        bookmark=struct.unpack("<I", r[0x118:0x11C])[0],
        dontskip=r[0x11C], remember=r[0x11D], unintalbum=r[0x11E], unknown=r[0x11F],
        pregap=struct.unpack("<I", r[0x120:0x124])[0],
        postgap=struct.unpack("<I", r[0x124:0x128])[0],
        numsamples=struct.unpack("<I", r[0x128:0x12C])[0],
        unk_12c=struct.unpack("<I", r[0x12C:0x130])[0],
        gapless=struct.unpack("<I", r[0x130:0x134])[0],
        unk_134=struct.unpack("<I", r[0x134:0x138])[0],
        albumid=struct.unpack("<I", r[0x138:0x13C])[0],
        track_no=struct.unpack("<H", r[0x13C:0x13E])[0],
        disc=struct.unpack("<H", r[0x13E:0x140])[0],
        unk_140=struct.unpack("<Q", r[0x140:0x148])[0],
        dbid=r[0x148:0x150],
        artistid=struct.unpack("<I", r[0x150:0x154])[0],
        tail=r[0x154:0x174],
    )


def parse_playlist(data, off):
    (_id, total, nsongs, nonaudio) = struct.unpack("<4sIII", data[off:off + 16])
    dbid = data[off + 0x10:off + 0x18]
    listtype, = struct.unpack("<I", data[off + 0x18:off + 0x1C])
    members = struct.unpack(f"<{nsongs}I", data[off + 44:off + 44 + nsongs * 4])
    return dict(header=data[off:off + 44], total_length=total, n_songs=nsongs,
                n_nonaudio=nonaudio, dbid=dbid, listtype=listtype, members=list(members))


# ---------------------------------------------------------------- 构建

def build_track(t):
    out = bytearray(372)
    struct.pack_into("<4sIIIII", out, 0, b"rths", 0x174, t["start_ms"], t["stop_ms"],
                     t["volume_gain"], t["filetype"])
    name = t["filename"].encode("utf-8")[:255]
    out[0x18:0x18 + len(name)] = name
    struct.pack_into("<I", out, 0x118, t["bookmark"])
    out[0x11C], out[0x11D], out[0x11E], out[0x11F] = \
        t["dontskip"], t["remember"], t["unintalbum"], t["unknown"]
    struct.pack_into("<II", out, 0x120, t["pregap"], t["postgap"])
    struct.pack_into("<I", out, 0x128, t["numsamples"])
    struct.pack_into("<I", out, 0x12C, t["unk_12c"])
    struct.pack_into("<I", out, 0x130, t["gapless"])
    struct.pack_into("<I", out, 0x134, t["unk_134"])
    struct.pack_into("<I", out, 0x138, t["albumid"])
    struct.pack_into("<HH", out, 0x13C, t["track_no"], t["disc"])
    struct.pack_into("<Q", out, 0x140, t["unk_140"])
    out[0x148:0x150] = t["dbid"]
    struct.pack_into("<I", out, 0x150, t["artistid"])
    out[0x154:0x174] = t["tail"]
    return bytes(out)


def build_sd(model):
    """按模型序列化整个 iTunesSD。头部模板整体沿用设备现有值。"""
    tracks = model["tracks"]
    n = len(tracks)

    out = bytearray(64)
    out[0:4] = b"bdhs"
    struct.pack_into("<IIIII", out, 4, model["root"]["version"], 64, n,
                     model["root"]["n_playlists"], 0)
    struct.pack_into("<Q", out, 20, 0)
    out[28] = model["root"]["max_volume"]
    out[29] = model["root"]["voiceover"]
    struct.pack_into("<H", out, 30, 0)
    struct.pack_into("<I", out, 32, n)

    th_size = 20 + n * 4
    track_block = bytearray()
    offsets = bytearray()
    cur = 64 + th_size
    for t in tracks:
        offsets += struct.pack("<I", cur)
        track_block += build_track(t)
        cur += 372

    trk = bytearray()
    trk += struct.pack("<4sIIQ", b"hths", th_size, n, 0)
    trk += offsets + track_block

    struct.pack_into("<I", out, 36, 64)
    struct.pack_into("<I", out, 40, 64 + len(trk))
    out[44:64] = model["root"]["tail"]        # 保留模板尾部字节

    ph = bytearray(model["playlist_header"])
    struct.pack_into("<I", ph, 4, 72)
    struct.pack_into("<I", ph, 8, len(model["playlists"]))
    lphs_off = 64 + len(trk) + 72
    for k in range(len(model["playlists"])):
        struct.pack_into("<I", ph, 68 + k * 4, lphs_off if k == 0 else 0)

    pl = bytearray()
    for p in model["playlists"]:
        h = bytearray(p["header"])
        struct.pack_into("<I", h, 4, 44 + p["n_songs"] * 4)
        struct.pack_into("<I", h, 8, p["n_songs"])
        struct.pack_into("<I", h, 12, p["n_nonaudio"])
        pl += h
        pl += b"".join(struct.pack("<I", m) for m in p["members"])
    return bytes(out) + bytes(trk) + bytes(ph) + bytes(pl)


# ---------------------------------------------------------------- iTunesDB 元数据

def read_itunesdb_titles(ipod_root):
    """从 iTunesDB 读标题，按路径索引。用于弥补 MP3 无 ID3 标签的情况。"""
    p = os.path.join(ipod_root, "iPod_Control/iTunes/iTunesDB")
    if not os.path.isfile(p):
        return {}
    db = open(p, "rb").read()
    i = 0
    while i >= 0:
        i = db.find(b"mhlt", i)
        if i < 0:
            break
        hl, n = struct.unpack("<II", db[i + 4:i + 12])
        break
    else:
        return {}
    if i < 0:
        return {}
    q = i + hl
    out = {}
    for _ in range(n):
        if db[q:q + 4] != b"mhit":
            break
        mhl, mtl, nmhod = struct.unpack("<III", db[q + 4:q + 16])
        c, fields = q + mhl, {}
        for _ in range(nmhod):
            if db[c:c + 4] != b"mhod":
                break
            chl, ctl = struct.unpack("<II", db[c + 4:c + 12])
            mtype, = struct.unpack("<I", db[c + 12:c + 16])
            slen, = struct.unpack("<I", db[c + chl + 4:c + chl + 8])
            s = db[c + chl + 16:c + chl + 16 + slen].decode("utf-16-le", "replace")
            fields[mtype] = s
            c += ctl
        path = fields.get(2, "").replace(":", "/")
        if path.startswith("/"):
            # 统一去掉前导 "/"，与 iTunesSD 中 filename 字段的写法对齐
            out[path.lstrip("/")] = fields.get(1, "")
        q += mtl
    return out


# ---------------------------------------------------------------- 命令行

def cmd_probe(ipod):
    data = open(os.path.join(ipod, "iPod_Control/iTunes/iTunesSD"), "rb").read()
    m = parse_sd(data)
    titles = read_itunesdb_titles(ipod)
    r = m["root"]
    print(f"设备: {ipod}  版本标记 0x{r['version']:08x}  "
          f"曲目 {r['n_tracks']}  播放列表 {r['n_playlists']}  VoiceOver={r['voiceover']}")
    print(f"{'#':>3} {'时长':>8} {'格式':>5} {'标题':<28} 路径")
    for k, t in enumerate(m["tracks"]):
        ftype = {1: "MP3", 2: "AAC"}.get(t["filetype"], str(t["filetype"]))
        print(f"{k:>3} {t['stop_ms']/1000:>7.1f}s {ftype:>5} "
              f"{titles.get(t['filename'], '<无标题>'):<28} {t['filename']}")
    for k, p in enumerate(m["playlists"]):
        print(f"  播放列表[{k}] type={p['listtype']} songs={p['n_songs']}")


def cmd_validate(ipod):
    sd_path = os.path.join(ipod, "iPod_Control/iTunes/iTunesSD")
    original = open(sd_path, "rb").read()
    m = parse_sd(original)
    titles = read_itunesdb_titles(ipod)

    # 备份
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backups",
                        f"{stamp}-prechange")
    os.makedirs(bdir, exist_ok=True)
    shutil.copy2(sd_path, os.path.join(bdir, "iTunesSD"))
    print(f"[备份] {sd_path} -> {os.path.abspath(bdir)}/iTunesSD")

    # 挑选：1 条全新生成 + 2 条沿用原记录
    fresh_src = next(t for t in m["tracks"] if t["filename"].endswith("VQCA.mp3"))
    keep = [next(t for t in m["tracks"] if t["filename"].endswith("SBJT.mp3")),
            next(t for t in m["tracks"] if t["filename"].endswith("CGMU.mp3"))]

    title = titles.get(fresh_src["filename"], "")
    fp = ipod + fresh_src["filename"].lstrip("/")
    size = os.path.getsize(fp)
    id3v1 = 0
    with open(fp, "rb") as fh:
        fh.seek(-128, os.SEEK_END)
        id3v1 = 128 if fh.read(3) == b"TAG" else 0
    head = open(fp, "rb").read(10)
    id3v2 = 0
    if head[:3] == b"ID3":
        sz = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
        id3v2 = 10 + sz

    fresh = dict(
        raw=b"", header_length=0x174, start_ms=0,
        stop_ms=fresh_src["stop_ms"],          # 真实时长
        volume_gain=0, filetype=1,
        filename=fresh_src["filename"],
        bookmark=0, dontskip=1, remember=0, unintalbum=0, unknown=0,
        pregap=528,                            # 设备上 13 首全为此常量
        postgap=0,                             # 由 Apple 按音频内容计算，先填 0
        numsamples=int(fresh_src["stop_ms"] / 1000 * 44100),   # 时长 × 采样率
        unk_12c=0, gapless=0, unk_134=0,
        albumid=0,
        track_no=0, disc=0, unk_140=0,
        dbid=voiceover.dbid_from_text(title),   # 全新 dbid，与语音文件名同源
        artistid=0,
        tail=b"\x00" * 32,
    )

    m["tracks"] = [fresh] + keep
    m["root"]["n_tracks"] = 3
    m["playlists"] = [dict(header=m["playlists"][0]["header"], total_length=56,
                           n_songs=3, n_nonaudio=3, dbid=b"\x00" * 8,
                           listtype=1, members=[0, 1, 2])]

    new = build_sd(m)
    print(f"[构建] {len(original)} B -> {len(new)} B，曲目 13 -> 3")
    for k, t in enumerate(m["tracks"]):
        print(f"    [{k}] {t['filename']}  {t['stop_ms']/1000:.1f}s  dbid={t['dbid'].hex()}")

    tmp = sd_path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(new)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, sd_path)

    # 回读校验
    back = open(sd_path, "rb").read()
    chk = parse_sd(back)
    ok = build_sd(chk) == back
    print(f"[写入] {sd_path}  {len(back)} B  回读重建一致={ok}")
    print(f"[校验] 曲目数={chk['root']['n_tracks']} 播放列表曲目={chk['playlists'][0]['members']}")
    print("\n完成。请按以下步骤验证（见文档）")


def cmd_restore(ipod):
    """把最近一次备份的 iTunesSD 还原回设备。"""
    here = os.path.dirname(os.path.abspath(__file__))
    bdir = os.path.join(here, "..", "backups")
    cands = sorted(
        (os.path.join(bdir, d, "iTunesSD") for d in os.listdir(bdir)
         if os.path.isfile(os.path.join(bdir, d, "iTunesSD"))),
        key=os.path.getmtime)
    if not cands:
        sys.exit("没有可用备份")
    src, sd_path = cands[-1], os.path.join(ipod, "iPod_Control/iTunes/iTunesSD")
    print(f"[还原] {os.path.abspath(src)}")
    print(f"   ->  {sd_path}")
    shutil.copyfile(src, sd_path)
    with open(sd_path, "r+b") as fh:
        os.fsync(fh.fileno())
    back = open(sd_path, "rb").read()
    print(f"[完成] 设备 iTunesSD = {len(back)} B，曲目数 "
          f"{parse_sd(back)['root']['n_tracks']}")
    print("       请安全弹出后再断开。")


# ---------------------------------------------------------------- VoiceOver

def speakable_dirs(ipod):
    """返回 Tracks / Playlists 两个语音目录（统一用 / 分隔，便于显示与跨平台）。

    注意：Speakable 位于 **iPod_Control/ 之内**，不在 iPod 根目录下。
    实机确认：`iPod_Control/Speakable/{Tracks,Playlists,System,Messages}`。
    """
    base = os.path.join(ipod, "iPod_Control", "Speakable").replace("\\", "/")
    return f"{base}/Tracks", f"{base}/Playlists"


def detect_speakable_format(ipod):
    """从设备上 Apple 已有的语音文件里探测音频格式，作为我们生成的默认值。

    Apple 的 VoiceOver Kit 生成的文件是最权威的格式依据，比猜测可靠。
    """
    trk_dir, _ = speakable_dirs(ipod)
    if not os.path.isdir(trk_dir):
        return None
    for f in sorted(os.listdir(trk_dir)):
        if not f.lower().endswith(".wav"):
            continue
        info = voiceover.read_wav_format(os.path.join(trk_dir, f))
        if info and info["pcm"]:
            info["source"] = f
            return info
    return None


def resolve_titles(ipod, tracks):
    """给每条曲目确定播报文本。优先 iTunesDB 标题，回退到文件名主干。"""
    tmap = read_itunesdb_titles(ipod)
    out = []
    for t in tracks:
        rel = t["filename"].lstrip("/")
        stem = os.path.splitext(os.path.basename(rel))[0]
        out.append(tmap.get(rel) or stem)
    return out


def cmd_speakable(ipod):
    """只读：盘点设备上的 VoiceOver 资产与实际文件格式。"""
    root = os.path.join(ipod, "iPod_Control", "Speakable")
    print(f"=== {root.replace(chr(92), '/')} ===")
    if os.path.isdir(root):
        for d in sorted(os.listdir(root)):
            p = os.path.join(root, d)
            if os.path.isdir(p):
                print(f"  {d}/  ({len(os.listdir(p))} 个文件)")
        plists = [f for f in os.listdir(root) if f.lower().endswith(".plist")]
        if plists:
            print(f"  语言配置: {len(plists)} 个（含 "
                  + ", ".join(sorted(x for x in plists if x.lower().startswith(('zh', 'yue'))))
                  + "）")
        if "VoiceOverDB" in os.listdir(root):
            vdb = os.path.join(root, "VoiceOverDB")
            print(f"  VoiceOverDB  {os.path.getsize(vdb)} B（VoiceOver Kit 的音色清单，无需改动）")
    else:
        print("  (不存在)")

    trk_dir, _ = speakable_dirs(ipod)
    files = sorted(os.listdir(trk_dir)) if os.path.isdir(trk_dir) else []
    print(f"\n=== Tracks/ 实际文件格式（前 8 个）===")
    for f in files[:8]:
        info = voiceover.read_wav_format(os.path.join(trk_dir, f))
        if info:
            print(f"  {f}  {info['channels']}ch {info['rate']}Hz {info['bits']}bit "
                  f"PCM={info['pcm']}  {info['duration']:.2f}s")

    sd = parse_sd(open(os.path.join(ipod, "iPod_Control/iTunes/iTunesSD"), "rb").read())
    titles = resolve_titles(ipod, sd["tracks"])
    have = set(x.lower() for x in files)
    print(f"\n=== 曲目 <-> 语音匹配（VoiceOver 总开关 = "
          f"{'开' if sd['root']['voiceover'] else '关'}）===")
    miss = 0
    for k, (t, title) in enumerate(zip(sd["tracks"], titles)):
        fn = voiceover.voice_filename(t["dbid"])
        ok = fn.lower() in have
        miss += 0 if ok else 1
        print(f"  [{k:>2}] {'OK ' if ok else '缺失'} {fn}  {title}")
    print(f"\n缺失 {miss} / {len(sd['tracks'])}")


def cmd_voiceover(ipod, args):
    """补齐（或强制重生成）Speakable/Tracks 下的曲目语音。"""
    sd_path = os.path.join(ipod, "iPod_Control/iTunes/iTunesSD")
    sd = parse_sd(open(sd_path, "rb").read())
    trk_dir, _ = speakable_dirs(ipod)
    os.makedirs(trk_dir, exist_ok=True)

    if not sd["root"]["voiceover"]:
        print("[!] 设备数据库的 VoiceOver 总开关为 0，设备不会播报任何语音。")

    titles = resolve_titles(ipod, sd["tracks"])
    targets = range(len(sd["tracks"])) if args.track is None else [args.track]

    # 采样率优先顺序：命令行 > 设备上 Apple 现有文件 > 内置默认
    rate = args.rate
    if rate is None:
        det = detect_speakable_format(ipod)
        if det:
            rate = det["rate"]
            print(f"[格式] 对齐设备现有语音文件 {det['source']}："
                  f"{det['channels']}ch {det['rate']}Hz {det['bits']}bit")
        else:
            rate = voiceover.DEFAULT_RATE
            print(f"[格式] 设备上无参考文件，使用默认 {rate}Hz")

    tts = voiceover.get_tts()
    print(f"[TTS] 语音 = {args.voice or tts.pick_voice()}  采样率 = {rate}  "
          f"语速 = {args.speed}")

    done = skip = 0
    for k in targets:
        t, title = sd["tracks"][k], titles[k]
        text = voiceover.announce_text(title)
        fn = voiceover.voice_filename(t["dbid"])
        dst = os.path.join(trk_dir, fn)
        if os.path.isfile(dst) and not args.force:
            print(f"  [{k:>2}] 已存在，跳过  {fn}")
            skip += 1
            continue
        if args.dry_run:
            print(f"  [{k:>2}] 待生成  {fn}  «{text}»")
            continue
        tmp = dst + ".tmp"
        info = tts.synth(text, tmp, rate=rate, voice=args.voice, speed=args.speed)
        os.replace(tmp, dst)
        with open(dst, "r+b") as fh:
            os.fsync(fh.fileno())
        print(f"  [{k:>2}] 生成  {fn}  {info['rate']}Hz {info['duration']:.2f}s  «{text}»")
        done += 1

    if not args.dry_run:
        print(f"\n[完成] 新生成 {done} 个，跳过 {skip} 个 -> {trk_dir}")
        print("       请安全弹出后再断开。")


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="iPod Shuffle iTunesSD 读写参考实现")
    ap.add_argument("action", nargs="?", default="probe",
                    choices=["probe", "speakable", "voiceover", "validate", "restore"])
    ap.add_argument("--force", action="store_true", help="voiceover: 已存在也重新生成")
    ap.add_argument("--dry-run", action="store_true", help="voiceover: 只列出不写入")
    ap.add_argument("--track", type=int, default=None, help="voiceover: 只处理某一条（0 基）")
    ap.add_argument("--rate", type=int, default=None,
                    help="voiceover: 采样率；缺省时对齐设备现有语音文件")
    ap.add_argument("--speed", type=int, default=0, help="voiceover: SAPI 语速 -10..10")
    ap.add_argument("--voice", default=None, help="voiceover: 指定语音名称")
    ap.add_argument("--ipod", default=None, help="指定 iPod 根目录（默认自动扫描盘符）")
    args = ap.parse_args()

    ipod = args.ipod or find_ipod()
    if ipod:
        ipod = ipod.replace("\\", "/")
        if not ipod.endswith("/"):
            ipod += "/"
    if not ipod:
        sys.exit("未找到 iPod（需要 iPod_Control/iTunes/iTunesSD）")
    print(f"[设备] {ipod}\n")
    if args.action == "probe":
        cmd_probe(ipod)
    elif args.action == "speakable":
        cmd_speakable(ipod)
    elif args.action == "voiceover":
        cmd_voiceover(ipod, args)
    elif args.action == "validate":
        cmd_validate(ipod)
    else:
        cmd_restore(ipod)


if __name__ == "__main__":
    main()
