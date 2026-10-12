// wasm_api.cpp -- the C interface the web page's worker calls (built by build/build_wasm.sh).
//
// A handle holds one compiled script and a frame buffer. Rendering is synchronous and
// row-banded: the worker asks for a band of rows at a time so it can report progress
// and notice a cancel between bands; a band renders the same bits as the whole frame.

#include "seq.h"
#include "renderer.h"
#include <string>
#include <vector>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define QTS_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define QTS_EXPORT
#endif

struct QtsHandle {
	Script               script;
	std::string          messages;
	std::string          info;
	std::vector<uint8_t> rgb;
	std::vector<uint8_t> rgba;
	int                  width, height;
	QtsHandle() : width(0), height(0) {}
};

extern "C" {

QTS_EXPORT QtsHandle *qts_new() { return new QtsHandle; }

QTS_EXPORT void qts_free(QtsHandle *h) { delete h; }

// Compiles text; images named in it are read from imageDir (a MEMFS directory the
// worker filled). Returns 1 on success. qts_messages() has the errors and warnings.
QTS_EXPORT int qts_compile(QtsHandle *h, const char *text, const char *title, const char *imageDir)
{
	h->script.imageDir = imageDir ? imageDir : "";
	bool ok = h->script.Compile(text ? text : "", title ? title : "script");
	h->messages.clear();
	for (const std::string &w : h->script.warnings) h->messages += "warning: " + w + "\n";
	for (const std::string &e : h->script.errors) h->messages += "error: " + e + "\n";
	char buf[256];
	snprintf(buf, sizeof buf, "{\"duration\":%.17g,\"frameRate\":%.17g,\"frames\":%d,\"width\":%d,\"height\":%d}",
	         h->script.Duration(), h->script.FrameRate(), h->script.NbrFrames(),
	         h->script.FrameWidth(), h->script.FrameHeight());
	h->info = buf;
	return ok ? 1 : 0;
}

QTS_EXPORT const char *qts_messages(QtsHandle *h) { return h->messages.c_str(); }
QTS_EXPORT const char *qts_info(QtsHandle *h) { return h->info.c_str(); }

// Renders rows y0..y1-1 of frame frameNbr of nbrFrames (or, with nbrFrames 1, of the
// frame at snapshot 0..1) at width x height, into the handle's RGBA buffer, and returns
// that buffer (width*height*4 bytes, opaque). Rows outside the band keep what they had.
QTS_EXPORT uint8_t *qts_render(QtsHandle *h, int frameNbr, int nbrFrames, double snapshot,
                               int width, int height, int y0, int y1)
{
	if (!h->script.mainSeq || width < 1 || height < 1) return NULL;
	if (width != h->width || height != h->height) {
		h->width = width;
		h->height = height;
		h->rgb.assign((size_t) width * height * 3, 0);
		h->rgba.assign((size_t) width * height * 4, 255);
	}
	Renderer r(&h->script, width, height);
	if (y1 < 0 || y1 > height) y1 = height;
	if (y0 < 0) y0 = 0;
	r.RenderFrame(frameNbr, nbrFrames, snapshot, h->rgb.data(), y0, y1);
	const uint8_t *s = h->rgb.data() + (size_t) y0 * width * 3;
	uint8_t *d = h->rgba.data() + (size_t) y0 * width * 4;
	for (size_t i = 0, n = (size_t) (y1 - y0) * width; i < n; ++i) {
		d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = 255;
		s += 3; d += 4;
	}
	return h->rgba.data();
}

// The RGB (3 bytes per pixel) version of the last render, for byte comparisons
QTS_EXPORT uint8_t *qts_rgb(QtsHandle *h) { return h->rgb.data(); }

}
