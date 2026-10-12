// seq.cpp -- the .can script parser and the sequence tree (port of QTS candy.l/.y,
// P_Seq.cpp and P_Prop.cpp).

#include "seq.h"
#include "renderer.h"
#include "qts_math.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>

// ---------------------------------------------------------------- Prop

std::string Prop::GetString() const
{
	if (isString) return str;
	char tbuf[64];
	snprintf(tbuf, sizeof tbuf, "%.30f", number);
	char *p = &tbuf[strlen(tbuf)-1];
	while (p > tbuf && *p == '0')
		*(p--) = 0;
	if (p > tbuf && *p == '.')		// the original left "1." and its lexer skipped the dot
		*p = 0;
	return tbuf;
}

ssfloat Prop::GetFloat() const   { return isString ? atof(str.c_str()) : number; }
int     Prop::GetInteger() const { return isString ? (int) atol(str.c_str()) : TruncXToLong(number); }

static bool ieq(const std::string &a, const char *b)
{
	size_t n = strlen(b);
	if (a.size() != n) return false;
	for (size_t i = 0; i < n; ++i)
		if (tolower((unsigned char) a[i]) != tolower((unsigned char) b[i])) return false;
	return true;
}

bool Prop::GetBoolean() const
{
	if (!isString) return number != 0.0;
	return ieq(str, "yes") || ieq(str, "true") || ieq(str, "on") || atol(str.c_str()) != 0;
}

PropsRec::PropsRec()
{
	m_Center = m_Oversample = m_Cycle = m_Wrapmode = m_Tile = false;
	m_Colormode = CM_TripletRGB;
	channelOp = CHOP_Normal;
	flags = 0;
	debut = duration = globalDebut = 0;
	frameRate = 12;
	firstGlobalFrame = 0;
	movieType = MT_QuickTime;
	frameWidth = frameHeight = 256;
	movieSeamless = false;
}

// ---------------------------------------------------------------- script lexer/parser

namespace {

enum PTokType { P_END, P_SYM, P_BOOLSYM, P_SEQTAG, P_NUMBER, P_STRING, P_CHAR };

struct PTok {
	PTokType    type;
	int         id;		// prop id / seq tag flags / char
	ssfloat     num;
	std::string text;
	int         line;
};

struct Keyword { const char *name; int id; };

// property names -> ids (candy.l)
const Keyword kPropWords[] = {
	{"id", PP_ID}, {"debut", PP_Debut}, {"duration", PP_Duration}, {"rgb", PP_RGB},
	{"triple", PP_Triple}, {"pix", PP_Triple}, {"hsv", PP_HSV}, {"mono", PP_Mono},
	{"framerate", PP_FrameRate}, {"keyframes", PP_KeyFrameRate}, {"keyframerate", PP_KeyFrameRate},
	{"datarate", PP_MaxDataRate}, {"maxdatarate", PP_MaxDataRate}, {"endwidth", PP_EndWidth},
	{"depth", PP_MovieDepth}, {"moviedepth", PP_MovieDepth},
	{"priority", PP_MoviePriority}, {"moviepriority", PP_MoviePriority},
	{"codec", PP_MovieCodec}, {"moviecodec", PP_MovieCodec},
	{"file", PP_MovieFilename}, {"filename", PP_MovieFilename}, {"moviefile", PP_MovieFilename},
	{"moviefilename", PP_MovieFilename},
	{"movietype", PP_MovieType}, {"framewidth", PP_FrameWidth}, {"fw", PP_FrameWidth},
	{"frameheight", PP_FrameHeight}, {"fh", PP_FrameHeight}, {"min", PP_Min}, {"max", PP_Max},
	{"left", PP_Left}, {"top", PP_Top}, {"width", PP_Width}, {"startwidth", PP_Width},
	{"height", PP_Height}, {"zoomfunc", PP_ZoomFunc}, {"zoom", PP_ZoomFac}, {"zoomfactor", PP_ZoomFac},
	{"recurse", PP_Recurse}, {"p0", PP_P0}, {"jx", PP_P0}, {"q0", PP_Q0}, {"jy", PP_Q0},
	{"chop", PP_ChannelOp}, {"opacity", PP_Opacity}, {"opaque", PP_Opacity},
	{"source", PP_Source}, {"image", PP_Source}, {"bmp", PP_Source},
	{"author", PP_Author}, {"gamma", PP_Gamma},
	{NULL, 0}
};
const Keyword kBoolWords[] = {
	{"dither", PP_MovieDither}, {"moviedither", PP_MovieDither},
	{"seamless", PP_MovieSeamless}, {"movieseamless", PP_MovieSeamless},
	{"center", PP_Center}, {"oversample", PP_Oversample}, {"cycle", PP_Cycle},
	{"wrap", PP_Wrap}, {"tile", PP_Tile},
	{NULL, 0}
};
// words that are numbers
const Keyword kNumberWords[] = {
	{"yes", 1}, {"true", 1}, {"on", 1}, {"no", 0}, {"false", 0}, {"off", 0},
	{"next", -1}, {"last", -1},
	{"quicktime", MT_QuickTime}, {"pngframes", MT_PNGFrames}, {"bmpframes", MT_BMPFrames},
	{"normal", CHOP_Normal}, {"multiply", CHOP_Multiply}, {"screen", CHOP_Screen},
	{"overlay", CHOP_Overlay}, {"lighten", CHOP_Lighten}, {"darken", CHOP_Darken},
	{"difference", CHOP_Difference}, {"exclusion", CHOP_Exclusion}, {"softlight", CHOP_Softlight},
	{"hardlight", CHOP_Hardlight}, {"dodge", CHOP_Dodge}, {"colordodge", CHOP_Dodge},
	{"colourdodge", CHOP_Dodge}, {"burn", CHOP_Burn}, {"colorburn", CHOP_Burn}, {"colourburn", CHOP_Burn},
	{"hue", CHOP_Hue}, {"sat", CHOP_Saturation}, {"saturation", CHOP_Saturation},
	{"col", CHOP_Color}, {"color", CHOP_Color}, {"colour", CHOP_Color},
	{"lum", CHOP_Luminosity}, {"luminosity", CHOP_Luminosity},
	{NULL, 0}
};

class ScriptParser {
	const std::string &src;
	size_t pos;
	int    line;
	PTok   tok;
	Script *script;
	bool   failed;

public:
	ScriptParser(const std::string &s, Script *sc) : src(s), pos(0), line(1), script(sc), failed(false) {}

	void error(const std::string &m)
	{
		script->Error(tok.line, m);
		failed = true;
	}

	void lex()
	{
		for (;;) {
			while (pos < src.size() && (src[pos] == ' ' || src[pos] == '\t' || src[pos] == '\r')) ++pos;
			if (pos < src.size() && src[pos] == '\n') { ++line; ++pos; continue; }
			if (pos + 1 < src.size() && src[pos] == '/' && src[pos+1] == '/') {
				while (pos < src.size() && src[pos] != '\n') ++pos;
				continue;
			}
			break;
		}
		tok.line = line;
		tok.text.clear();
		if (pos >= src.size()) { tok.type = P_END; return; }
		char c = src[pos];

		// times mm:ss[.f] and hh:mm:ss[.f], and numbers (a leading '-' is part of the number)
		if (isdigit((unsigned char) c) || (c == '-' && pos + 1 < src.size() && (isdigit((unsigned char) src[pos+1]) || src[pos+1] == '.'))
			|| (c == '.' && pos + 1 < src.size() && isdigit((unsigned char) src[pos+1]))) {
			size_t s = pos;
			if (c == '-') ++pos;
			while (pos < src.size() && (isdigit((unsigned char) src[pos]) || src[pos] == '.' || src[pos] == ':')) ++pos;
			std::string w = src.substr(s, pos - s);
			tok.type = P_NUMBER;
			int colons = 0;
			for (char ch : w) if (ch == ':') ++colons;
			if (colons == 2) {
				int hours = 0, mins = 0; double secs = 0;
				sscanf(w.c_str(), "%d:%d:%lf", &hours, &mins, &secs);
				tok.num = hours*60*60 + mins*60 + secs;
			}
			else if (colons == 1) {
				int mins = 0; double secs = 0;
				sscanf(w.c_str(), "%d:%lf", &mins, &secs);
				tok.num = mins*60 + secs;
			}
			else
				tok.num = atof(w.c_str());
			return;
		}
		if (c == '"' || c == '\'') {
			size_t e = src.find(c, pos + 1);
			size_t nl = src.find('\n', pos);
			if (e == std::string::npos || nl < e) {
				error("Unterminated string");
				pos = nl == std::string::npos ? src.size() : nl;
				tok.type = P_STRING;
				return;
			}
			tok.type = P_STRING;
			tok.text = src.substr(pos + 1, e - pos - 1);
			pos = e + 1;
			return;
		}
		if (isalpha((unsigned char) c)) {
			size_t s = pos;
			while (pos < src.size() && (isalnum((unsigned char) src[pos]) || src[pos] == '_')) ++pos;
			std::string w = src.substr(s, pos - s);
			tok.text = w;
			if (ieq(w, "seq")) { tok.type = P_SEQTAG; tok.id = 0; return; }
			if (ieq(w, "map")) { tok.type = P_SEQTAG; tok.id = SeqF_IsMap; return; }
			for (const Keyword *k = kNumberWords; k->name; ++k)
				if (ieq(w, k->name)) { tok.type = P_NUMBER; tok.num = k->id; return; }
			for (const Keyword *k = kPropWords; k->name; ++k)
				if (ieq(w, k->name)) { tok.type = P_SYM; tok.id = k->id; return; }
			for (const Keyword *k = kBoolWords; k->name; ++k)
				if (ieq(w, k->name)) { tok.type = P_BOOLSYM; tok.id = k->id; return; }
			tok.type = P_STRING;		// a bare word: a value such as id=main or max=pi
			return;
		}
		++pos;
		if (c == '<' || c == '>' || c == '=' || c == '/') { tok.type = P_CHAR; tok.id = c; return; }
		char msg[64];
		snprintf(msg, sizeof msg, "Unexpected character: %c", c);
		error(msg);
		lex();
	}

	bool isChar(int c) { return tok.type == P_CHAR && tok.id == c; }

	// script: seqlist. The whole file is a list of sequences; the original keeps only the
	// last top-level one as "main" (a list is attached in reverse). A single root is the
	// normal case; several are made children of an implicit root.
	std::unique_ptr<Seq> parse()
	{
		lex();
		std::vector<std::unique_ptr<Seq>> list;
		while (tok.type != P_END && !failed) {
			std::unique_ptr<Seq> s = parseSeq();
			if (s) list.push_back(std::move(s));
		}
		if (failed) return nullptr;
		if (list.empty()) { error("Empty script"); return nullptr; }
		if (list.size() == 1) return std::move(list[0]);
		std::unique_ptr<Seq> root(new Seq(0));
		root->children = std::move(list);
		return root;
	}

	std::unique_ptr<Seq> parseSeq()
	{
		if (!isChar('<')) { error("parse error: expected <seq"); return nullptr; }
		lex();
		if (tok.type != P_SEQTAG) { error("parse error: expected seq or map"); return nullptr; }
		std::unique_ptr<Seq> seq(new Seq(tok.id));
		seq->line = tok.line;
		lex();
		// proplist
		while (tok.type == P_SYM || tok.type == P_BOOLSYM || tok.type == P_STRING) {
			if (failed) return nullptr;
			PTok name = tok;
			lex();
			Prop p;
			p.line = name.line;
			p.propID = name.type == P_STRING ? PP_Undefined : name.id;
			p.isString = false;
			p.number = 0;
			if (isChar('=')) {
				lex();
				if (tok.type == P_STRING) { p.isString = true; p.str = tok.text; }
				else if (tok.type == P_NUMBER) { p.number = tok.num; }
				else { error("parse error: bad property value"); return nullptr; }
				lex();
				if (name.type == P_BOOLSYM && p.isString) {
					error("Improper use of boolean");
					p.isString = false; p.number = 1;
				}
			}
			else if (name.type == P_BOOLSYM)
				p.number = 1;			// a bare flag: center, wrap, tile...
			else { error("parse error: expected = after " + name.text); return nullptr; }
			if (name.type == P_STRING) error("Unknown Tag: " + name.text);
			seq->propList.push_back(p);
		}
		if (isChar('/')) {
			lex();
			if (!isChar('>')) { error("parse error: expected >"); return nullptr; }
			lex();
			return seq;
		}
		if (!isChar('>')) { error("parse error: expected > or />"); return nullptr; }
		lex();
		while (!(isChar('<') && pos < src.size() && src[pos] == '/')) {
			if (tok.type == P_END || failed) { error("parse error: missing </seq>"); return nullptr; }
			std::unique_ptr<Seq> child = parseSeq();
			if (!child) return nullptr;
			seq->children.push_back(std::move(child));
		}
		lex();		// '/'
		lex();
		if (tok.type != P_SEQTAG) { error("parse error: expected </seq>"); return nullptr; }
		lex();
		if (!isChar('>')) { error("parse error: expected >"); return nullptr; }
		lex();
		return seq;
	}
};

} // namespace

// ---------------------------------------------------------------- Script

void Script::Error(int line, const std::string &msg)
{
	char buf[32];
	snprintf(buf, sizeof buf, "Line %d: ", line);
	errors.push_back(buf + msg);
}

void Script::CompileExp(ExpRec &rec, int line)
{
	std::string err;
	if (expMgr.CompileExp(rec, err))
		Error(line, err + " in \"" + rec.exp + "\"");
}

void Script::RegisterSeq(Seq *seq)
{
	int id = expMgr.NameToSequenceID(seq->itsProps.idName);
	if ((int) seqByID.size() < id) seqByID.resize(id, NULL);
	seqByID[id-1] = seq;		// a repeated id: the last one wins
}

static void SetExp(ExpRec &rec, const char *text) { rec.exp = text; }

void Script::InitDefaultProps(const std::string &title)
{
	PropsRec &d = defaultProps;
	d = PropsRec();
	SetExp(d.m_PixExp, "RGB(x,y,x+y)");
	SetExp(d.m_Left, "0");
	SetExp(d.m_Top, "0");
	SetExp(d.m_Width, "1");
	SetExp(d.m_Height, "w*fh/fw");
	SetExp(d.m_Min, "0");
	SetExp(d.m_Max, "1");
	SetExp(d.m_Recurse, "64");
	SetExp(d.m_ZoomFac, "1.0");
	SetExp(d.m_ZoomFunc, "t");		// transforms scaled time for the zoom: lets it accelerate
	SetExp(d.m_P0, "0");
	SetExp(d.m_Q0, "0");
	SetExp(d.m_Opacity, "1");
	SetExp(d.m_Gamma, "0.454550");
	CompileExp(d.m_PixExp, 0); CompileExp(d.m_Left, 0); CompileExp(d.m_Top, 0);
	CompileExp(d.m_Width, 0); CompileExp(d.m_Height, 0); CompileExp(d.m_Min, 0);
	CompileExp(d.m_Max, 0); CompileExp(d.m_Recurse, 0); CompileExp(d.m_ZoomFac, 0);
	CompileExp(d.m_ZoomFunc, 0); CompileExp(d.m_P0, 0); CompileExp(d.m_Q0, 0);
	CompileExp(d.m_Opacity, 0); CompileExp(d.m_Gamma, 0);
	d.channelOp = CHOP_Normal;
	d.frameRate = 12;
	d.movieType = MT_QuickTime;
	d.movieSeamless = false;
	d.frameWidth = 256;
	d.frameHeight = 256;
	d.debut = 0;
	d.duration = 1;
	d.movieFilename = title;
	size_t dot = d.movieFilename.find('.');
	if (dot != std::string::npos) d.movieFilename.erase(dot);

	blackProps = d;
	SetExp(blackProps.m_PixExp, "0");
	CompileExp(blackProps.m_PixExp, 0);
}

bool Script::Compile(const std::string &text, const std::string &title)
{
	errors.clear();
	seqByID.clear();
	expMgr.ResetSequenceNames();
	mainSeq.reset();

	ScriptParser p(text, this);
	std::unique_ptr<Seq> root = p.parse();
	if (!root || !errors.empty()) return false;
	mainSeq = std::move(root);

	InitDefaultProps(title);
	mainSeq->AssignProps(this, NULL);
	PropsRec &rootProps = mainSeq->itsProps;
	if (rootProps.debut == -1) rootProps.debut = 0;
	rootProps.globalDebut = rootProps.debut;
	rootProps.firstGlobalFrame = (long) ceil(rootProps.globalDebut * rootProps.frameRate);
	mainSeq->AssignDurations(rootProps.globalDebut);
	// a name that was only ever referenced samples as black, as it did in QTS
	for (auto &kv : expMgr.seqNames)
		if (kv.second > (int) seqByID.size() || seqByID[kv.second-1] == NULL)
			warnings.push_back("Unknown sequence: $" + kv.first + " (renders black)");
	return errors.empty();
}

int Script::NbrFrames() const
{
	if (!mainSeq) return 0;
	return TruncXToLong(mainSeq->itsProps.duration * mainSeq->itsProps.frameRate);
}

// ---------------------------------------------------------------- Seq

void Seq::AssignProps(Script *script, Seq *parent)
{
	PropsRec *parProps = parent ? &parent->itsProps : &script->defaultProps;

	// inherit everything, then override from the prop list
	itsProps = *parProps;
	itsProps.debut = 0;
	itsProps.flags = flags;

	for (const Prop &p : propList) {
		switch (p.propID) {
		case PP_Triple:
			itsProps.m_PixExp.exp = p.GetString();
			script->CompileExp(itsProps.m_PixExp, p.line);
			itsProps.m_Colormode = CM_TripletRGB;
			break;
		case PP_RGB:
			itsProps.m_PixExp.exp = "triple(" + p.GetString() + ")";
			script->CompileExp(itsProps.m_PixExp, p.line);
			itsProps.m_Colormode = CM_TripletRGB;
			break;
		case PP_HSV:
			itsProps.m_PixExp.exp = "triple(" + p.GetString() + ")";
			script->CompileExp(itsProps.m_PixExp, p.line);
			itsProps.m_Colormode = CM_TripletHSV;
			break;
		case PP_Mono:
			itsProps.m_PixExp.exp = p.GetString();
			script->CompileExp(itsProps.m_PixExp, p.line);
			itsProps.m_Colormode = CM_Mono;
			break;
		case PP_ID:
			itsProps.idName = p.GetString();
			script->RegisterSeq(this);
			break;
		case PP_Source: {
			itsProps.srcName = p.GetString();
			std::string err;
			itsProps.expVars.itsSourceImage = ImageCache::Shared().Get(itsProps.srcName, script->imageDir, err);
			if (!itsProps.expVars.itsSourceImage)
				script->Error(p.line, err);
			break;
		}
		case PP_Debut:        itsProps.debut = p.GetFloat();          break;
		case PP_Duration:     itsProps.duration = p.GetFloat();       break;
		case PP_FrameRate:    itsProps.frameRate = p.GetFloat();      break;
		case PP_MovieSeamless: itsProps.movieSeamless = p.GetBoolean(); break;
		case PP_MovieType:    itsProps.movieType = p.GetInteger();    break;
		case PP_MovieFilename: itsProps.movieFilename = p.GetString(); break;
		case PP_Author:       itsProps.author = p.GetString();        break;
		case PP_KeyFrameRate: case PP_MaxDataRate: case PP_MovieDepth: case PP_MoviePriority:
		case PP_MovieCodec: case PP_MovieDither:
			break;		// QuickTime settings: nothing to do with them now
		case PP_Min:       itsProps.m_Min.exp = p.GetString();      script->CompileExp(itsProps.m_Min, p.line); break;
		case PP_Max:       itsProps.m_Max.exp = p.GetString();      script->CompileExp(itsProps.m_Max, p.line); break;
		case PP_Left:      itsProps.m_Left.exp = p.GetString();     script->CompileExp(itsProps.m_Left, p.line); break;
		case PP_Top:       itsProps.m_Top.exp = p.GetString();      script->CompileExp(itsProps.m_Top, p.line); break;
		case PP_Width:     itsProps.m_Width.exp = p.GetString();    script->CompileExp(itsProps.m_Width, p.line); break;
		case PP_Height:    itsProps.m_Height.exp = p.GetString();   script->CompileExp(itsProps.m_Height, p.line); break;
		case PP_ZoomFac:   itsProps.m_ZoomFac.exp = p.GetString();  script->CompileExp(itsProps.m_ZoomFac, p.line); break;
		case PP_ZoomFunc:  itsProps.m_ZoomFunc.exp = p.GetString(); script->CompileExp(itsProps.m_ZoomFunc, p.line); break;
		case PP_Recurse:   itsProps.m_Recurse.exp = p.GetString();  script->CompileExp(itsProps.m_Recurse, p.line); break;
		case PP_P0:        itsProps.m_P0.exp = p.GetString();       script->CompileExp(itsProps.m_P0, p.line); break;
		case PP_Q0:        itsProps.m_Q0.exp = p.GetString();       script->CompileExp(itsProps.m_Q0, p.line); break;
		case PP_EndWidth:  itsProps.m_EndWidth.exp = p.GetString(); script->CompileExp(itsProps.m_EndWidth, p.line); break;
		case PP_Opacity:   itsProps.m_Opacity.exp = p.GetString();  script->CompileExp(itsProps.m_Opacity, p.line); break;
		case PP_Gamma:     itsProps.m_Gamma.exp = p.GetString();    script->CompileExp(itsProps.m_Gamma, p.line); break;
		case PP_Center:     itsProps.m_Center = p.GetBoolean();     break;
		case PP_Oversample: itsProps.m_Oversample = p.GetBoolean(); break;
		case PP_Cycle:      itsProps.m_Cycle = p.GetBoolean();      break;
		case PP_Wrap:       itsProps.m_Wrapmode = p.GetBoolean();   break;
		case PP_Tile:       itsProps.m_Tile = p.GetBoolean();       break;
		case PP_FrameWidth:  itsProps.frameWidth = p.GetInteger();  break;
		case PP_FrameHeight: itsProps.frameHeight = p.GetInteger(); break;
		case PP_ChannelOp:   itsProps.channelOp = p.GetInteger();   break;
		}
	}
	for (auto &child : children)
		child->AssignProps(script, this);
}

void Seq::AssignDurations(ssfloat timeOffset)
{
	// (the caller sets globalDebut/debut for each child in order so "last" can see the
	// previous sibling)
	if (!children.empty()) {
		Seq *prev = NULL;
		for (auto &child : children) {
			PropsRec &cp = child->itsProps;
			if (cp.debut == -1 && prev != NULL) {
				cp.globalDebut = prev->itsProps.globalDebut + prev->itsProps.duration;
				cp.debut = cp.globalDebut - itsProps.globalDebut;
			}
			else {
				if (cp.debut == -1) cp.debut = 0;
				cp.globalDebut = cp.debut + itsProps.globalDebut;
			}
			cp.firstGlobalFrame = (long) ceil(cp.globalDebut * cp.frameRate);
			child->AssignDurations(cp.globalDebut);
			ssfloat temp = cp.debut + cp.duration;
			if (itsProps.duration < temp)
				itsProps.duration = temp;
			prev = child.get();
		}
	}
	(void) timeOffset;
}

void Seq::InitPropsForFrame(Renderer *renderer, std::vector<PropsRec *> &sList, ssfloat timeVal)
{
	if (timeVal < itsProps.debut || timeVal > itsProps.debut + itsProps.duration)
		return;

	for (auto &child : children)
		child->InitPropsForFrame(renderer, sList, timeVal - itsProps.debut);

	if (children.empty())
		sList.push_back(&itsProps);

	ExpVars *expVars = &itsProps.expVars;
	ExpMgr *expMgr = renderer->expMgr;

	expVars->renderer = renderer;
	expVars->globalScaledTime = renderer->globalScaledTime;
	expVars->globalFrameNbr = renderer->globalFrameNbr;

	expVars->localScaledTime = (renderer->globalTime - itsProps.globalDebut) / itsProps.duration;
	expVars->localFrameNbr = renderer->globalFrameNbr - itsProps.firstGlobalFrame;

	expVars->duration = itsProps.duration;
	expVars->px = expVars->py = 0;
	expVars->pw = renderer->pictureWidth;
	expVars->ph = renderer->pictureHeight;
	expVars->fw = renderer->pictureWidth;
	expVars->fh = renderer->pictureHeight;
	expVars->leftVal = expMgr->EvalF(itsProps.m_Left, expVars);
	expVars->topVal = expMgr->EvalF(itsProps.m_Top, expVars);

	// width & height may refer to left and top...
	expVars->widthVal = expMgr->EvalF(itsProps.m_Width, expVars);
	expVars->heightVal = expMgr->EvalF(itsProps.m_Height, expVars);

	// ...and left and top to width and height
	expVars->leftVal = expMgr->EvalF(itsProps.m_Left, expVars);
	expVars->topVal = expMgr->EvalF(itsProps.m_Top, expVars);

	expVars->zoomVal = expMgr->EvalF(itsProps.m_ZoomFac, expVars);
	expVars->endWidthVal = expMgr->EvalF(itsProps.m_EndWidth, expVars);

	// endwidth: the zoom per frame that gets there by the sequence's last frame
	if (expVars->endWidthVal > 0 && expVars->zoomVal == 1.0 && expVars->widthVal > 0)
	{
		int nbrFrames = TruncXToLong(itsProps.duration * itsProps.frameRate);
		if (nbrFrames > 1) {
			expVars->zoomVal = sm_pow(expVars->endWidthVal / expVars->widthVal , 1.0 / (nbrFrames-1));
		}
	}

	if (itsProps.m_Center)
	{
		expVars->leftVal -= expVars->widthVal/2;
		expVars->topVal -= expVars->heightVal/2;
	}
	expVars->lastX = expVars->leftVal + expVars->widthVal;
	expVars->lastY = expVars->topVal + expVars->heightVal;

	if (expVars->zoomVal != 1.0) {
		ssfloat	frameZoomFactor,diff,tranFrameNbr;
		int nbrFrames = TruncXToLong(itsProps.duration * itsProps.frameRate);
		tranFrameNbr = (nbrFrames-1)*expMgr->EvalF(itsProps.m_ZoomFunc, expVars);
		frameZoomFactor = sm_pow(expVars->zoomVal, tranFrameNbr);
		diff = (expVars->widthVal*frameZoomFactor) - expVars->widthVal;
		expVars->widthVal += diff;
		expVars->leftVal -= diff/2;
		diff = (expVars->heightVal*frameZoomFactor) - expVars->heightVal;
		expVars->heightVal += diff;
		expVars->topVal -= diff/2;
	}

	expVars->centerX = expVars->leftVal+expVars->widthVal/2;
	expVars->centerY = expVars->topVal+expVars->heightVal/2;

	expVars->recur = TruncXToLong(expMgr->EvalF(itsProps.m_Recurse, expVars));

	expVars->p0 = expMgr->EvalF(itsProps.m_P0, expVars);
	expVars->q0 = expMgr->EvalF(itsProps.m_Q0, expVars);

	expVars->xInc = expVars->widthVal / expVars->fw;
	expVars->yInc = expVars->heightVal / expVars->fh;
	expVars->x = expVars->leftVal;
	expVars->y = expVars->topVal;

	expVars->minVal = expMgr->EvalF(itsProps.m_Min, expVars);
	expVars->maxVal = expMgr->EvalF(itsProps.m_Max, expVars);

	if (expVars->maxVal == expVars->minVal) {
		expVars->minVal -= 0.01;
		expVars->maxVal += 0.01;
	}
	expVars->tranFactor = 1 / (expVars->maxVal - expVars->minVal);
	expVars->wrapMode = itsProps.m_Wrapmode;
	expVars->cycleMode = itsProps.m_Cycle;
	expVars->tileMode = itsProps.m_Tile;

	expVars->opacity = expMgr->EvalF(itsProps.m_Opacity, expVars);
	expVars->gamma = expMgr->EvalF(itsProps.m_Gamma, expVars);
}
