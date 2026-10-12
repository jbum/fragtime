// image.h -- a source image for sample(), r[x,y] and friends (port of QTS PMDIB's
// read side). Pixels are 8-bit RGB, row 0 at the top, packed as 0x00BBGGRR like
// Windows' COLORREF so the expression code reads them the same way.

#ifndef QTS_IMAGE_H
#define QTS_IMAGE_H

#include <stdint.h>
#include <string>
#include <vector>
#include <memory>
#include "expr.h"

class Image {
public:
	int width, height;
	std::vector<uint8_t> rgb;		// width*height*3

	Image() : width(0), height(0) {}

	// Black outside the image, as the original
	inline uint32_t GetPixel(int tx, int ty) const
	{
		if (tx < 0 || ty < 0 || tx >= width || ty >= height)
			return 0;
		const uint8_t *p = &rgb[((size_t) ty * width + tx) * 3];
		return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16);
	}

	// Nearest pixel at normalised coordinates; tile wraps, otherwise clamps to 0..1
	// (where 1.0 lands just past the last pixel and reads black -- the original did too)
	uint32_t Sample(ssfloat tx, ssfloat ty, bool tile) const;

	// Decode a PNG/BMP/JPEG/GIF file. Returns false (and a message) when it can't.
	bool Load(const std::string &path, std::string &err);
};

// Images are shared between threads and between the sequences that name the same file:
// load each file once. A name is looked for as given, then in dir, then in the search
// directories; a ".bmp" (or .jpg/.gif) that isn't there is tried as ".png", since the
// web site carries the archive's images as PNGs. Case-insensitive on the extension's side.
class ImageCache {
public:
	std::vector<std::string> searchDirs;
	std::shared_ptr<Image> Get(const std::string &name, const std::string &dir, std::string &err);
	static ImageCache &Shared();
private:
	std::string Resolve(const std::string &name, const std::string &dir);
};

#endif
