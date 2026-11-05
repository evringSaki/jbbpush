#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包云函数 zip（只带运行必需的模块，零外部依赖）

    python deploy/scf/build.py

产物：deploy/scf/jd-babel-scf.zip
"""

import os
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
STAGE = os.path.join(HERE, ".stage")
OUT = os.path.join(HERE, "jd-babel-scf.zip")

# index.js 直接 require 到的模块（含间接依赖）
MODULES = [
    "config.js",
    "http.js",
    "parse.js",
    "normalize.js",
    "snapshot.js",
    "dashboard.js",
    "report.js",
    "notify.js",
    "channels/ssr.js",
]


def main():
    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(os.path.join(STAGE, "src", "channels"))

    shutil.copy2(os.path.join(HERE, "index.js"), os.path.join(STAGE, "index.js"))
    for m in MODULES:
        src = os.path.join(ROOT, "src", m.replace("/", os.sep))
        dst = os.path.join(STAGE, "src", m.replace("/", os.sep))
        if not os.path.exists(src):
            raise SystemExit(f"缺少模块：{src}")
        shutil.copy2(src, dst)

    if os.path.exists(OUT):
        os.remove(OUT)

    count = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(STAGE):
            for f in sorted(files):
                p = os.path.join(base, f)
                arc = os.path.relpath(p, STAGE).replace("\\", "/")
                z.write(p, arc)
                count += 1

    size = os.path.getsize(OUT)
    print(f"打包完成：{OUT}")
    print(f"  文件数 {count}，大小 {size / 1024:.1f} KB")
    with zipfile.ZipFile(OUT) as z:
        for i in z.infolist():
            print(f"  {i.filename}  {i.file_size}")


if __name__ == "__main__":
    main()
