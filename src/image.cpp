// image.cpp -- image loading through stb_image, and the shared cache.

#include "image.h"
#include "qts_math.h"
#include <mutex>
#include <map>
#include <stdio.h>
#include <ctype.h>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#include "stb_image.h"

uint32_t Image::Sample(ssfloat tx, ssfloat ty, bool tile) const
{
	ssfloat	px,py;
	if (tile)
	{
		if (tx < 0) {
			tx = fabs(tx);
			tx = 1-(tx-TruncXToLong(tx));
		}
		else
			tx -= TruncXToLong(tx);

		if (ty < 0) {
			ty = fabs(ty);
			ty = 1-(ty-TruncXToLong(ty));
		}
		else
			ty -= TruncXToLong(ty);
	}
	else {
		if (tx < 0)
			tx = 0;
		else if (tx > 1)
			tx = 1;
		if (ty < 0)
			ty = 0;
		else if (ty > 1)
			ty = 1;
	}
	px = tx*width;
	py = ty*height;
	return GetPixel(TruncXToLong(px), TruncXToLong(py));
}

bool Image::Load(const std::string &path, std::string &err)
{
	int w, h, n;
	unsigned char *data = stbi_load(path.c_str(), &w, &h, &n, 3);
	if (!data) {
		err = "Can't read image " + path + ": " + (stbi_failure_reason() ? stbi_failure_reason() : "");
		return false;
	}
	width = w;
	height = h;
	rgb.assign(data, data + (size_t) w * h * 3);
	stbi_image_free(data);
	return true;
}

static bool fileExists(const std::string &p)
{
	FILE *f = fopen(p.c_str(), "rb");
	if (!f) return false;
	fclose(f);
	return true;
}

static std::string lower(std::string s)
{
	for (char &c : s) c = tolower((unsigned char) c);
	return s;
}

std::string ImageCache::Resolve(const std::string &name, const std::string &dir)
{
	std::vector<std::string> dirs = searchDirs;
	if (!dir.empty()) dirs.insert(dirs.begin(), dir);
	dirs.insert(dirs.begin(), "");
	std::vector<std::string> names;
	names.push_back(name);
	names.push_back(lower(name));
	size_t dot = name.rfind('.');
	if (dot != std::string::npos) {
		std::string ext = lower(name.substr(dot));
		if (ext == ".bmp" || ext == ".jpg" || ext == ".gif") {
			names.push_back(name.substr(0, dot) + ".png");
			names.push_back(lower(name.substr(0, dot)) + ".png");
		}
	}
	for (const std::string &d : dirs)
		for (const std::string &n : names) {
			std::string p = d.empty() ? n : d + "/" + n;
			if (fileExists(p)) return p;
		}
	return "";
}

std::shared_ptr<Image> ImageCache::Get(const std::string &name, const std::string &dir, std::string &err)
{
	static std::mutex mu;
	static std::map<std::string, std::shared_ptr<Image>> cache;
	std::lock_guard<std::mutex> lock(mu);
	std::string key = dir + "|" + name;
	auto it = cache.find(key);
	if (it != cache.end()) return it->second;
	std::string path = Resolve(name, dir);
	if (path.empty()) {
		err = "Can't find image " + name;
		return nullptr;
	}
	std::shared_ptr<Image> img(new Image);
	if (!img->Load(path, err)) return nullptr;
	cache[key] = img;
	return img;
}

ImageCache &ImageCache::Shared()
{
	static ImageCache c;
	return c;
}
