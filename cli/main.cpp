// qts -- command-line renderer for Pixel Magic / QTS scripts.
//
//   qts script.can                      every frame -> script_0001.png, ...
//   qts -t 3.5 -o frame.png script.can  the frame at 3.5 seconds
//   qts -T 0.25 script.can              the frame at a quarter of the way through
//   qts -raw script.can | ffmpeg -f rawvideo -pix_fmt rgb24 -s WxH -r FPS -i - out.mp4
//
// Threads each hold their own copy of the compiled script and render whole frames
// (-j N; the default is every core), so the output is the same bits in any order.

#include "seq.h"
#include "renderer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <atomic>
#include <condition_variable>
#include <map>
#include <chrono>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

static void usage()
{
	fprintf(stderr,
		"usage: qts [options] script.can\n"
		"  -o PATH    output file (one frame) or pattern with %%d (frames); default script_%%04d.png\n"
		"  -t SECS    render only the frame at this time\n"
		"  -T FRAC    render only the frame at this fraction (0..1) of the movie\n"
		"  -f A[-B]   render frames A to B (0-based, inclusive)\n"
		"  -w W -h H  picture size (default: the script's fw/fh)\n"
		"  -j N       threads (default: all cores)\n"
		"  -raw       write raw RGB24 frames to stdout instead of PNGs\n"
		"  -i         print the script's duration, frame rate and size, and exit\n"
		"  -P         report progress on stderr\n"
		"  -q         quiet\n"
		"  --rel      $a samples at the same relative position (see expr_eval.cpp)\n");
	exit(2);
}

static std::string readFile(const std::string &path)
{
	FILE *f = fopen(path.c_str(), "rb");
	if (!f) { fprintf(stderr, "qts: can't open %s\n", path.c_str()); exit(1); }
	std::string s;
	char buf[65536];
	size_t n;
	while ((n = fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
	fclose(f);
	return s;
}

static std::string dirOf(const std::string &path)
{
	size_t s = path.find_last_of("/\\");
	return s == std::string::npos ? "" : path.substr(0, s);
}

static std::string baseOf(const std::string &path)
{
	size_t s = path.find_last_of("/\\");
	std::string b = s == std::string::npos ? path : path.substr(s + 1);
	size_t dot = b.rfind('.');
	return dot == std::string::npos ? b : b.substr(0, dot);
}

static void report(const Script &script)
{
	for (const std::string &w : script.warnings) fprintf(stderr, "warning: %s\n", w.c_str());
	for (const std::string &e : script.errors) fprintf(stderr, "error: %s\n", e.c_str());
}

int main(int argc, char **argv)
{
	std::string outPath, scriptPath;
	double snapSecs = -1, snapFrac = -1;
	int firstFrame = 0, lastFrame = -1;
	int width = 0, height = 0;
	int threads = (int) std::thread::hardware_concurrency();
	bool raw = false, info = false, progress = false, quiet = false, single = false;

	for (int i = 1; i < argc; ++i) {
		std::string a = argv[i];
		auto next = [&]() -> const char * { if (i + 1 >= argc) usage(); return argv[++i]; };
		if (a == "-o") outPath = next();
		else if (a == "-t") { snapSecs = atof(next()); single = true; }
		else if (a == "-T") { snapFrac = atof(next()); single = true; }
		else if (a == "-f") {
			const char *r = next();
			if (sscanf(r, "%d-%d", &firstFrame, &lastFrame) < 2) { firstFrame = atoi(r); lastFrame = firstFrame; }
		}
		else if (a == "-w") width = atoi(next());
		else if (a == "-h") height = atoi(next());
		else if (a == "-j") threads = atoi(next());
		else if (a == "-raw") raw = true;
		else if (a == "-i") info = true;
		else if (a == "-P") progress = true;
		else if (a == "-q") quiet = true;
		else if (a == "--rel") gRelativeSampling = true;
		else if (a[0] == '-' && a.size() > 1) usage();
		else scriptPath = a;
	}
	if (scriptPath.empty()) usage();
	if (threads < 1) threads = 1;

	std::string text = readFile(scriptPath);
	std::string title = baseOf(scriptPath);
	std::string imageDir = dirOf(scriptPath);

	Script script;
	script.imageDir = imageDir;
	bool ok = script.Compile(text, title);
	report(script);
	if (!ok) return 1;

	if (width <= 0) width = script.FrameWidth();
	if (height <= 0) height = script.FrameHeight();
	int nbrFrames = script.NbrFrames();
	if (nbrFrames < 1) nbrFrames = 1;

	if (info) {
		printf("duration %g s, %g fps, %d frames, %dx%d\n", script.Duration(), script.FrameRate(),
		       nbrFrames, width, height);
		return 0;
	}

	if (single) {
		double frac = snapFrac >= 0 ? snapFrac : (script.Duration() > 0 ? snapSecs / script.Duration() : 0);
		if (frac < 0) frac = 0;
		if (frac > 1) frac = 1;
		Renderer r(&script, width, height);
		std::vector<uint8_t> rgb((size_t) width * height * 3);
		auto t0 = std::chrono::steady_clock::now();
		r.RenderFrame(0, 1, frac, rgb.data());
		double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
		if (outPath.empty()) outPath = title + ".png";
		if (raw) {
#ifdef _WIN32
			_setmode(_fileno(stdout), _O_BINARY);
#endif
			fwrite(rgb.data(), 1, rgb.size(), stdout);
		}
		else if (!stbi_write_png(outPath.c_str(), width, height, 3, rgb.data(), width * 3)) {
			fprintf(stderr, "qts: can't write %s\n", outPath.c_str());
			return 1;
		}
		if (!quiet) fprintf(stderr, "%s: %dx%d in %.2f s\n", outPath.c_str(), width, height, secs);
		return 0;
	}

	if (lastFrame < 0 || lastFrame >= nbrFrames) lastFrame = nbrFrames - 1;
	if (firstFrame < 0) firstFrame = 0;
	if (firstFrame > lastFrame) { fprintf(stderr, "qts: no frames in range\n"); return 1; }
	int total = lastFrame - firstFrame + 1;
	if (threads > total) threads = total;
	if (outPath.empty()) outPath = (imageDir.empty() ? "" : imageDir + "/") + title + "_%04d.png";
	if (!raw && outPath.find('%') == std::string::npos) {
		size_t dot = outPath.rfind('.');
		outPath = (dot == std::string::npos ? outPath : outPath.substr(0, dot)) + "_%04d.png";
	}
#ifdef _WIN32
	if (raw) _setmode(_fileno(stdout), _O_BINARY);
#endif

	// Frames go out in order: a worker parks a finished frame until the writer wants it
	std::atomic<int> nextFrame(firstFrame);
	std::atomic<int> done(0);
	std::mutex mu;
	std::condition_variable cv;
	std::map<int, std::vector<uint8_t>> ready;
	bool failed = false;
	auto t0 = std::chrono::steady_clock::now();

	auto worker = [&](int id) {
		Script mine;
		Script *s = &script;
		if (id > 0) {
			mine.imageDir = imageDir;
			mine.Compile(text, title);
			s = &mine;
		}
		Renderer r(s, width, height);
		for (;;) {
			int f = nextFrame++;
			if (f > lastFrame) break;
			std::vector<uint8_t> rgb((size_t) width * height * 3);
			r.RenderFrame(f, nbrFrames, 0, rgb.data());
			if (raw) {
				std::unique_lock<std::mutex> lock(mu);
				ready[f] = std::move(rgb);
				cv.notify_all();
			}
			else {
				char name[1024];
				snprintf(name, sizeof name, outPath.c_str(), f + 1);
				if (!stbi_write_png(name, width, height, 3, rgb.data(), width * 3)) {
					std::unique_lock<std::mutex> lock(mu);
					fprintf(stderr, "qts: can't write %s\n", name);
					failed = true;
					nextFrame = lastFrame + 1;
				}
			}
			int d = ++done;
			if (progress) {
				std::unique_lock<std::mutex> lock(mu);
				fprintf(stderr, "progress %d/%d\n", d, total);
			}
		}
	};

	std::vector<std::thread> pool;
	for (int i = 0; i < threads; ++i) pool.emplace_back(worker, i);

	if (raw) {
		for (int f = firstFrame; f <= lastFrame; ++f) {
			std::vector<uint8_t> rgb;
			{
				std::unique_lock<std::mutex> lock(mu);
				cv.wait(lock, [&] { return ready.count(f) > 0; });
				rgb = std::move(ready[f]);
				ready.erase(f);
			}
			if (fwrite(rgb.data(), 1, rgb.size(), stdout) != rgb.size()) {
				fprintf(stderr, "qts: write failed\n");
				nextFrame = lastFrame + 1;
				failed = true;
				break;
			}
		}
	}
	for (auto &t : pool) t.join();
	double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
	if (!quiet)
		fprintf(stderr, "%d frames, %dx%d, %d thread%s: %.1f s (%.2f s/frame)\n", total, width, height,
		        threads, threads == 1 ? "" : "s", secs, secs / total);
	return failed ? 1 : 0;
}
