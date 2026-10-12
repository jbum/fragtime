// seq.h -- the script: a tree of <seq> sequences with properties (port of QTS
// P_Seq / P_Prop and the "candy" script grammar).
//
// A sequence is either a leaf that plots an expression, or a container whose children
// are layered back to front in source order. Each has a debut (start time, relative to
// its parent) and a duration; "debut=last" means after the previous sibling. Children
// inherit every property of their parent.

#ifndef QTS_SEQ_H
#define QTS_SEQ_H

#include "expr.h"
#include "image.h"
#include <string>
#include <vector>
#include <memory>

enum { SeqF_IsMap = 1 };

// Movie types
enum { MT_QuickTime, MT_PNGFrames, MT_BMPFrames };

enum { PRIO_LOW, PRIO_NORMAL, PRIO_HIGH };

enum { CM_TripletRGB, CM_TripletHSV, CM_Mono };

// Prop IDs
enum { PP_Undefined, PP_RGB, PP_HSV, PP_Mono, PP_Triple, PP_ID,
			 PP_Debut, PP_Duration, PP_FrameRate, PP_KeyFrameRate, PP_MaxDataRate,
			 PP_EndWidth,
			 PP_MovieDepth, PP_MoviePriority, PP_MovieCodec, PP_MovieFilename, PP_MovieDither,
			 PP_MovieSeamless, PP_Min, PP_Max, PP_Left, PP_Top,
			 PP_Width, PP_Height, PP_Center, PP_Oversample, PP_Cycle,
			 PP_ZoomFac, PP_ZoomFunc, PP_Recurse, PP_P0, PP_Q0, PP_Wrap, PP_Tile,
			 PP_FrameWidth, PP_FrameHeight, PP_Source, PP_ChannelOp, PP_Opacity,
			 PP_Author, PP_Gamma, PP_MovieType,
			 PP_NbrPropIDs};

// Property value as parsed: a quoted string / bare word, or a number
struct Prop {
	int         propID;
	bool        isString;
	std::string str;
	ssfloat     number;
	int         line;

	std::string GetString() const;
	ssfloat     GetFloat() const;
	int         GetInteger() const;
	bool        GetBoolean() const;
};

// The resolved properties of one sequence (after inheritance), plus its per-frame
// expression variables.
struct PropsRec {
	bool    m_Center, m_Oversample, m_Cycle, m_Wrapmode, m_Tile;

	ExpRec  m_PixExp;
	ExpRec  m_Left, m_Top;
	ExpRec  m_Width, m_Height;
	ExpRec  m_ZoomFac, m_ZoomFunc;
	ExpRec  m_Min, m_Max;
	ExpRec  m_Recurse;
	ExpRec  m_P0, m_Q0;
	ExpRec  m_EndWidth;
	ExpRec  m_Opacity;
	ExpRec  m_Gamma;
	int     m_Colormode;
	int     channelOp;
	int     flags;

	std::string idName;
	std::string srcName;
	ssfloat debut, duration, globalDebut;

	ssfloat frameRate;
	long    firstGlobalFrame;
	int     movieType;
	std::string movieFilename, author;
	int     frameWidth, frameHeight;
	bool    movieSeamless;

	ExpVars expVars;

	PropsRec();
};

class Script;

class Seq {
public:
	int               flags;
	PropsRec          itsProps;
	std::vector<Prop> propList;
	std::vector<std::unique_ptr<Seq>> children;		// source order: back to front
	int               line;

	Seq(int f = 0) : flags(f), line(0) {}

	void AssignProps(Script *script, Seq *parent);
	void AssignDurations(ssfloat timeOffset);
	// Collects the leaf sequences active at timeVal (in layer order) and sets up their
	// expression variables for this frame
	void InitPropsForFrame(Renderer *renderer, std::vector<PropsRec *> &sList, ssfloat timeVal);
};

// A compiled script: the sequence tree plus the id registry
class Script {
public:
	ExpMgr                 expMgr;
	std::unique_ptr<Seq>   mainSeq;
	std::vector<Seq *>     seqByID;		// id-1 -> seq (null for a name never defined)
	std::vector<std::string> errors, warnings;
	std::string            imageDir;	// where image= files are looked for first
	PropsRec               defaultProps, blackProps;

	// Parse and link. Returns false with errors filled in on failure.
	bool Compile(const std::string &text, const std::string &title);

	int     NbrFrames() const;
	ssfloat Duration() const  { return mainSeq ? mainSeq->itsProps.duration : 0; }
	ssfloat FrameRate() const { return mainSeq ? mainSeq->itsProps.frameRate : 12; }
	int     FrameWidth() const  { return mainSeq ? mainSeq->itsProps.frameWidth : 256; }
	int     FrameHeight() const { return mainSeq ? mainSeq->itsProps.frameHeight : 256; }

	void Error(int line, const std::string &msg);
	void RegisterSeq(Seq *seq);
	void CompileExp(ExpRec &rec, int line);
private:
	void InitDefaultProps(const std::string &title);
};

#endif
