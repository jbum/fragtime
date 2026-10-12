#!/usr/bin/env python3
"""Assemble the fragtime.jbum.com site in build/web.

Copies web/ and the examples, imports every example script as a patch (name.fragtime),
renders a thumbnail of every example with the native qts (make first), writes
examples/index.json and images.json, and puts the Noise Etude movie and the social card in
assets/. The site renders on the GPU only: the wasm renderer isn't part of it any more.
"""
import json, os, re, shutil, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "web")
QTS = os.path.join(ROOT, "qts")
EXAMPLES = os.path.join(ROOT, "examples")

# scripts that are only test fragments, or don't compile
SKIP = {"logicfrac.can", "noiseetude2.can", "test.can", "test2.can", "speedtest.can", "condtest.can",
        "chop_test.can", "png_test.can", "ps_test.can", "ps_logo_test.can", "noisetest.can",
        "mandel_test.can", "spiral2_test.can", "gnoise.can"}

# scripts that aren't shader-friendly (the site's default view and movie path): copied, so a
# ?x= link still opens them, but kept out of the examples menu and gallery. The deep
# Mandelbrot zooms reach widths of 1e-9..1e-12, which 32-bit GPU floats can't resolve
# (they dissolve into noise, some from the first frame); julia2 iterates 8192 times, so its
# escape counts drift too, and it draws at 6 fps. (jbum, 2026-10-11: "comment out the
# presets that aren't shader friendly".) mandel_classic, at width 2.75, is fine and stays.
NOT_SHADER = {"mandel.can", "mandel2.can", "mandel3.can", "mandel4.can", "mandel5.can", "mandel6.can",
              "mandel_bw.can", "mandel_classic2.can", "mandel_ctab.can", "mandel_ctab2.can", "julia2.can"}

# scaffolding for Noise Etude: noise studies and title/credit tests that were pasted into it
# and reworked there (the LEC_ files were lecture demos; LEC_eclipse duplicates eclipse).
# Copied like the above, but not listed. (jbum, 2026-10-11: "It was scaffolding.")
SCAFFOLDING = {"LEC_Noise1.can", "LEC_Noise2.can", "LEC_Noise3.can", "LEC_Noise3a.can", "LEC_Noise4.can",
               "LEC_Noise5.can", "LEC_NoiseAni.can", "LEC_Foreground.can", "LEC_eclipse.can", "noise.can",
               "clouds.can", "clouds_dusk.can", "chop_sample.can", "ripple2.can", "endcredits.can"}

# the order in the gallery: the showpieces first
FEATURED = ["noiseetude.can", "sun.can", "star.can", "spiral2.can", "mona.can", "smokezoom.can", "fire.can",
            "mandel_classic.can", "julia.can", "saturnrings.can", "eclipse.can", "lavalamp.can", "xorspiral.can"]


def run(*args, **kw):
    subprocess.run(args, check=True, **kw)


def info(path):
    out = subprocess.run([QTS, "-i", path], capture_output=True, text=True)
    if out.returncode != 0:
        return None
    m = re.search(r"duration (\S+) s, (\S+) fps, (\d+) frames, (\d+)x(\d+)", out.stdout)
    return {"duration": float(m[1]), "frameRate": float(m[2]), "frames": int(m[3]),
            "width": int(m[4]), "height": int(m[5])}


def description(path):
    with open(path, "rb") as f:
        first = f.readline().decode("latin-1").strip()
    if first.startswith("//"):
        return first[2:].strip()
    return ""


def main():
    if not os.path.exists(QTS):
        sys.exit("build the native qts first (make)")
    shutil.rmtree(OUT, ignore_errors=True)
    # the wasm renderer's pages stay in the repo for the inherited tests, not on the site
    shutil.copytree(os.path.join(ROOT, "web"), OUT, ignore=shutil.ignore_patterns("worker.js", "bench.html", "bench.js"))

    exdir = os.path.join(OUT, "examples")
    thumbs = os.path.join(exdir, "thumbs")
    os.makedirs(thumbs)
    for f in os.listdir(EXAMPLES):
        if f.endswith(".png"):
            shutil.copy(os.path.join(EXAMPLES, f), exdir)

    entries = []
    names = sorted(f for f in os.listdir(EXAMPLES) if f.endswith(".can") and f not in SKIP)
    names.sort(key=lambda n: (FEATURED.index(n) if n in FEATURED else len(FEATURED), n))
    for name in names:
        src = os.path.join(EXAMPLES, name)
        meta = info(src)
        if not meta:
            print("skip", name, "(doesn't compile)")
            continue
        shutil.copy(src, exdir)
        if name in NOT_SHADER or name in SCAFFOLDING:
            print("unlisted", name, "(not shader-friendly)" if name in NOT_SHADER else "(Noise Etude scaffolding)")
            continue
        thumb = os.path.join(thumbs, name[:-4] + ".png")
        w, h = meta["width"], meta["height"]
        tw = 320
        th = max(1, round(h * tw / w))
        frac = "0.5" if meta["frames"] > 1 else "0"
        if name == "noiseetude.can":
            frac = str(9.0 / meta["duration"])
        run(QTS, "-q", "-T", frac, "-w", str(tw), "-h", str(th), "-o", thumb, src)
        entry = {"file": name, "description": description(src)}
        entry.update(meta)
        entries.append(entry)
        print("example", name, f"{w}x{h}", meta["frames"], "frames")
    run("node", os.path.join(ROOT, "build", "import_examples.js"), exdir)
    for e in entries:
        e["patch"] = e["file"][:-4] + ".fragtime"
    with open(os.path.join(exdir, "index.json"), "w") as f:
        json.dump(entries, f, indent=1)
    with open(os.path.join(exdir, "images.json"), "w") as f:
        json.dump(sorted(f2 for f2 in os.listdir(exdir) if f2.endswith(".png")), f)

    assets = os.path.join(OUT, "assets")
    os.makedirs(assets, exist_ok=True)
    movie = None
    for cand in ("noise_etude_720.mp4", "noise_etude_360.mp4"):
        p = os.path.join(ROOT, "build", "out", cand)
        # a render still in progress isn't a readable movie yet
        if os.path.exists(p) and subprocess.run(["ffprobe", "-v", "error", p], capture_output=True).returncode == 0:
            movie = p
            break
    if movie:
        shutil.copy(movie, os.path.join(assets, "noise_etude.mp4"))
        run("ffmpeg", "-v", "error", "-y", "-ss", "9", "-i", movie, "-frames:v", "1", "-q:v", "3",
            os.path.join(assets, "etude_poster.jpg"))
        print("movie", os.path.basename(movie))
    else:
        print("no Noise Etude movie in build/out (render it with qts -raw | ffmpeg)")

    # icon and social card from the sun example
    icon_src = os.path.join(thumbs, "sun.png")
    if os.path.exists(icon_src):
        im = Image.open(icon_src).convert("RGB")
        s = min(im.size)
        im = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2))
        im.resize((128, 128), Image.LANCZOS).save(os.path.join(assets, "icon.png"))
    card_src = os.path.join(assets, "etude_poster.jpg")
    if not os.path.exists(card_src):
        card_src = icon_src
    if os.path.exists(card_src):
        tmp = os.path.join(ROOT, "build", "out", "card_frame.png")
        run(QTS, "-q", "-T", "0.5", "-w", "1200", "-h", "630", "-o", tmp, os.path.join(EXAMPLES, "sun.can"))
        card = Image.open(tmp).convert("RGB")
        draw = ImageDraw.Draw(card)
        try:
            font = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 64)
            small = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 30)
        except OSError:
            font = small = ImageFont.load_default()
        for dx, dy in ((2, 2), (0, 0)):
            col = (0, 0, 0) if (dx, dy) == (2, 2) else (255, 255, 255)
            draw.text((50 + dx, 470 + dy), "Fragtime", font=font, fill=col)
            draw.text((52 + dx, 550 + dy), "a formula for every pixel, plus time — fragtime.jbum.com", font=small, fill=col)
        card.save(os.path.join(assets, "card.png"))

    # the editor's relative links on the about page
    with open(os.path.join(OUT, "about.html")) as f:
        s = f.read()
    s = s.replace('href="?x=', 'href="./?x=')
    with open(os.path.join(OUT, "about.html"), "w") as f:
        f.write(s)
    print("built", OUT, "with", len(entries), "examples")


if __name__ == "__main__":
    main()
