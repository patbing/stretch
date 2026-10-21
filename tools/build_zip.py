#!/usr/bin/env python3
"""Package the extension into a versioned ZIP for the install page.

Also refuses to package anything that looks like a secret.
"""
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DOWNLOADS = os.path.join(SITE, "downloads")

INCLUDE_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "connect.html",
    "connect.js",
    "README.md",
    "PRIVACY.md",
]
INCLUDE_DIRS = ["lib", "icons"]

SECRET_PATTERNS = [
    re.compile(r"sk_[A-Za-z0-9]{16,}"),
    re.compile(r"gho_[A-Za-z0-9]{16,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9_\-]{24,}"),
]


def version():
    import json
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def collect():
    out = []
    for rel in INCLUDE_FILES:
        p = os.path.join(ROOT, rel)
        if os.path.isfile(p):
            out.append((rel, p))
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            p = os.path.join(base, name)
            if os.path.isfile(p):
                out.append((os.path.join(d, name).replace("\\", "/"), p))
    return out


def scan_secrets(files):
    problems = []
    for rel, path in files:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for pat in SECRET_PATTERNS:
            m = pat.search(text)
            if m:
                problems.append("%s: %s" % (rel, m.group(0)[:12] + "…"))
    return problems


def main():
    v = version()
    files = collect()
    problems = scan_secrets(files)
    if problems:
        print("SECRET-LIKE CONTENT FOUND — refusing to package:")
        for p in problems:
            print("  " + p)
        return 2
    os.makedirs(DOWNLOADS, exist_ok=True)
    out = os.path.join(DOWNLOADS, "stretch-%s.zip" % v)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, path in files:
            z.write(path, rel)
    print("wrote", out, os.path.getsize(out), "bytes,", len(files), "files")
    for rel, _ in files:
        print("   ", rel)
    return 0


if __name__ == "__main__":
    sys.exit(main())
