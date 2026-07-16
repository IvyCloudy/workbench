#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将目标目录下所有 .js / .py 文件追加 .txt 后缀。
用法:
    python3 scripts/append_txt_ext.py <target_dir>
    python3 scripts/append_txt_ext.py <target_dir> --dry-run    # 仅预览
    python3 scripts/append_txt_ext.py <target_dir> --verbose    # 详细日志
"""

import os
import sys
import argparse


def walk_files(root: str):
    """递归遍历目录，返回所有 .js / .py 文件绝对路径（跳过 .js.txt / .py.txt）。"""
    files = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(('.js.txt', '.py.txt')):
                continue  # 已处理过
            if name.endswith(('.js', '.py')):
                files.append(os.path.join(dirpath, name))
    return files


def main():
    parser = argparse.ArgumentParser(description="为目录下所有 .js /.py 文件追加 .txt 后缀")
    parser.add_argument("target_dir", help="目标目录路径")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不改名")
    parser.add_argument("--verbose", action="store_true", help="打印每条重命名详情")
    args = parser.parse_args()

    root = os.path.abspath(args.target_dir)
    if not os.path.isdir(root):
        print(f"[ERROR] 目录不存在: {root}")
        sys.exit(1)

    files = walk_files(root)

    if not files:
        print("未找到 .js 或 .py 文件（或已全部添加过 .txt 后缀）。")
        return

    print(f"找到 {len(files)} 个文件{'（预览模式）' if args.dry_run else ''}:")
    renamed = 0
    for src in files:
        dst = src + ".txt"
        if args.verbose or args.dry_run:
            rel = os.path.relpath(src, root)
            print(f"  {src}  →  {rel}.txt")
        if not args.dry_run:
            os.rename(src, dst)
            renamed += 1

    if args.dry_run:
        print(f"\n[dry-run] 共 {len(files)} 个文件将被重命名，未实际修改。")
    else:
        print(f"\n✓ 已重命名 {renamed} 个文件。")


if __name__ == "__main__":
    main()
