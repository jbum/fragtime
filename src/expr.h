// expr.h -- the Pixel Magic expression language: compiler and stack VM.
//
// Ported from QTS (2001-2003) expmgr.h / pixexp.y / pixexp.l. One expression compiles
// to a small bytecode program; the renderer evaluates it once per pixel (per sub-sample)
// with the variables in ExpVars. Results are Scalars: a single value or an RGB triple.

#ifndef QTS_EXPR_H
#define QTS_EXPR_H

#include <stdint.h>
#include <string>
#include <vector>
#include <memory>
#include <map>

typedef double ssfloat;

enum StackType { ST_Single, ST_Triple };

struct Scalar {
	ssfloat   v1, v2, v3;
	StackType type;
};

enum Variables
{V_None, V_Number, V_Time, V_GlobalTime, V_RANDOM,
	V_X, V_Y, V_W, V_H, V_A, V_D, V_I, V_FrameNbr, V_GlobalFrameNbr,
	V_FW, V_FH, V_JX, V_JY, V_PX, V_PY,
	V_PW, V_PH, V_CX, V_CY, V_SX, V_SY, V_SZ,
	V_E, V_PI, V_PI2,
	V_R, V_G, V_B, V_C, V_S, V_L,
	V_Left, V_Top, V_ZoomFac, V_IW, V_IH,
	V_Recurse, V_Duration, V_MaxVal, V_MinVal,
	NbrVariables
};

enum Operators
  {OP_None,
   OP_Add, OP_Subtract, OP_Negate,
   OP_Multiply, OP_Divide, OP_Modulo, OP_Power, OP_Power2,
   OP_Integer,
   OP_And, OP_Or, OP_Xor, OP_Invert,
   OP_Equal, OP_Neq, OP_Greater, OP_Gte, OP_Less, OP_Lse, OP_Not,
   OP_LogicAnd, OP_LogicOr,
   OP_Angle, OP_Dist,
   OP_Sqrt, OP_Log, OP_Log10, OP_Fabs, OP_Sign, OP_Exp,
   OP_Cos, OP_Sin, OP_Sin2, OP_Cos2, OP_Sin3, OP_Cos3,
   OP_Tan, OP_ACos, OP_ASin, OP_ATan, OP_Cosh, OP_Sinh, OP_Tanh,
   OP_Mandel2, OP_MandelFast, OP_MandelQ2, OP_MandelQFast, OP_MandelCPM, OP_Mandel3,
   OP_JuliaFast, OP_Julia2, OP_Julia4,
   OP_Dragon, OP_Zebra,
   OP_Fib, OP_Prime,
   OP_FBM, OP_FBMT,
   OP_FastNoise2, OP_Noise, OP_Noise2, OP_Noise3D,
   OP_FastFNoise2, OP_FNoise, OP_FNoise3D,
   OP_FastTurb2, OP_Turb, OP_Turb3D,
   OP_WNoise1, OP_WNoise2,
   OP_terp, OP_terpt, OP_pinch, OP_pinch2, OP_ease, OP_bias, OP_biast, OP_gain, OP_gaint,
   OP_Min, OP_Max, OP_Clamp, OP_limit,
   OP_linen, OP_linenr,
   OP_Red, OP_Green, OP_Blue,
   OP_SampleN, OP_SampleP,
   OP_SampleN_2, OP_SampleP_2,
   OP_RGB, OP_Triple, OP_HSV,
   OP_SampSeq, OP_SampSeqT, OP_SampSeqXY, OP_SampSeqDA, OP_SampSeqXYT,
   OP_Lum, OP_Color, OP_Saturation,		// never implemented: a compile error
   NbrOperators};

enum ChannelOps {
	CHOP_Normal, CHOP_Multiply, CHOP_Screen, CHOP_Overlay, CHOP_Lighten, CHOP_Darken,
	CHOP_Difference, CHOP_Exclusion, CHOP_Softlight, CHOP_Hardlight, CHOP_Dodge, CHOP_Burn,
	CHOP_Hue, CHOP_Saturation, CHOP_Color, CHOP_Luminosity,
	kNbrCHOPs
};

// Flags returned by the compiler
#define EF_IsConstant		0x01
#define EF_NoParams			0x02
#define EF_NoTime			0x04
#define EF_HasMandel		0x08 // used for MandelFast
#define EF_HasJulia			0x10 // used for JuliaFast
#define EF_HasMandelQ		0x20 // used for MandelQFast
#define EF_HasWorley2		0x40
#define EF_HasWorley3		0x80

// One bytecode instruction. kind: 'V' variable (code = Variables, num for V_Number),
// 'O' operator (code = Operators), 'X' control: X_Cond pops a value and jumps to target
// when it is zero, X_Jump always jumps.
enum { X_Cond = 1, X_Jump = 2 };
struct Instr {
	char    kind;
	int     code;
	int     target;
	ssfloat num;
};

struct ExpRec {
	std::string        exp;		// source text
	std::vector<Instr> code;	// compiled program (empty program evaluates to 0)
	int                cFlags;
	ExpRec() : cFlags(0) {}
};

class Image;
class Renderer;

#define pi 3.1415926535897932

// Everything an expression can see: set up per sequence per frame (InitPropsForFrame),
// x/y/px/py stepped per pixel.
struct ExpVars
{
	int      px, py, pw, ph, fw, fh, recur;
	ssfloat  leftVal, topVal, widthVal, heightVal, endWidthVal;
	ssfloat  zoomVal, centerX, centerY;
	ssfloat  minVal, maxVal;
	ssfloat  p0, q0;
	ssfloat  x, y, xInc, yInc;
	ssfloat  localScaledTime, globalScaledTime;
	ssfloat  tranFactor;
	ssfloat  duration;
	bool     wrapMode, cycleMode, tileMode;
	long     globalFrameNbr, localFrameNbr;
	ssfloat  opacity, gamma;

	std::shared_ptr<Image> itsSourceImage;
	Renderer *renderer;

	// The sub-sample cache: a sequence sampled twice at the same point is computed once
	Scalar   lastResult;
	ssfloat  lastX, lastY;

	ExpVars();
};

#define kMaxExecStack	256

class ExpMgr
{
	int      stackCtr;
	ssfloat  stackF[kMaxExecStack];
	char     stackT[kMaxExecStack];

	// Fractal caches (one per function: the original shared one key between them)
	int      lastMandelVal, lastJuliaVal, lastMandelQVal, lastMandel3Val, lastDragonVal;
	ssfloat  lastMandelCPM;
	ssfloat  lastMandelX, lastMandelY, lastJuliaX, lastJuliaY, lastMandelQX, lastMandelQY;
	ssfloat  lastMandelCPMX, lastMandelCPMY, lastMandel3X, lastMandel3Y, lastDragonX, lastDragonY;
	ssfloat  wd1, wd2;		// worley distances for the current pixel

	ssfloat  pi2, exp1, log_half;

	// the '?' random variable: Park-Miller, reseeded per row by the renderer
	int32_t  randSeed;

public:
	ExpMgr();

	// Compile exp.exp into exp.code; returns non-zero on error (message in err).
	// "$name" references become sequence ids (1-based) in seqNames, one registry per script.
	int CompileExp(ExpRec &exp, std::string &err);
	std::map<std::string, int> seqNames;
	int  NameToSequenceID(const std::string &name);
	void ResetSequenceNames() { seqNames.clear(); }

	Scalar *EvalScalar(const ExpRec &cExp, ExpVars *cVars, Scalar *retPtr);

	inline ssfloat EvalF(const ExpRec &cExp, ExpVars *cVars) {
		Scalar retVal;
		EvalScalar(cExp, cVars, &retVal);
		return retVal.v1;
	}

	void SeedRandom(int32_t s) { randSeed = s == 0 ? 1 : s; }
	ssfloat DoubleRandom();

	// Fractals
	int     CalcMandel(ssfloat p0, ssfloat q0, int recur);
	ssfloat CalcMandelCPM(ssfloat p0, ssfloat q0, int recur);
	int     CalcDragon(ssfloat x0, ssfloat y0, ssfloat p0, ssfloat q0, int recur);
	int     CalcMandel3(ssfloat p0, ssfloat q0, int recur);
	int     CalcJulia(ssfloat x, ssfloat y, ssfloat p0, ssfloat q0, int recur);
	int     CalcMandelQ(ssfloat x, ssfloat y, ssfloat p0, ssfloat q0, int recur);
	ssfloat CalcZebra(ssfloat p0, ssfloat width, ssfloat step, ssfloat offset);
	void    CalcWorley2(ssfloat x, ssfloat y);
	void    CalcWorley3(ssfloat x, ssfloat y, ssfloat z);
	int32_t Fibonacci(int32_t x);
	int32_t isPrime(int32_t n);

	// Noise
	ssfloat fBm(ssfloat x, ssfloat y, ssfloat z, ssfloat H, ssfloat lacunarity, ssfloat octaves);
	ssfloat fBmT(ssfloat x, ssfloat y, ssfloat z, ssfloat H, ssfloat lacunarity, ssfloat octaves);
	ssfloat GTurbulence3D(ssfloat x, ssfloat y, ssfloat z);
	ssfloat GTurbulence2D(ssfloat x, ssfloat y);
	ssfloat FNoise3D(ssfloat x, ssfloat y, ssfloat z);
	ssfloat FNoise2D(ssfloat x, ssfloat y);
	ssfloat gnoise3d(ssfloat x, ssfloat y, ssfloat z);
	ssfloat gnoise2d(ssfloat x, ssfloat y);
	ssfloat gnoisetest(ssfloat x, ssfloat y, ssfloat z, ssfloat p);

	ssfloat linen(ssfloat t, ssfloat atk, ssfloat dur, ssfloat dcy);
	ssfloat linenr(ssfloat t, ssfloat atk, ssfloat dcy, ssfloat atdec);
	ssfloat limit(ssfloat v, ssfloat low, ssfloat high);
	ssfloat SphereX(ssfloat u, ssfloat v);
	ssfloat SphereY(ssfloat u, ssfloat v);
	ssfloat SphereZ(ssfloat u, ssfloat v);

	void Interpolate(Scalar *a, Scalar *b, ssfloat t);
	void Pinch(Scalar *a, ssfloat p);
	void Ease(Scalar *a);
	void Bias(Scalar *a, ssfloat t);
	void Gain(Scalar *a, ssfloat t);

private:
	inline ssfloat PopFFast()    { return stackF[--stackCtr]; }
	inline void PushF(ssfloat v) { stackT[stackCtr] = ST_Single; stackF[stackCtr++] = v; }

	inline void PushTriple(ssfloat a, ssfloat b, ssfloat c)
	{
		stackF[stackCtr++] = c;
		stackF[stackCtr++] = b;
		stackT[stackCtr] = ST_Triple;
		stackF[stackCtr++] = a;
	}

	inline void PushScalar(Scalar *a)
	{
		if (a->type == ST_Triple)
			PushTriple(a->v1, a->v2, a->v3);
		else
			PushF(a->v1);
	}

	inline ssfloat PopF()
	{
		if (stackT[--stackCtr] == ST_Triple)
			stackCtr -= 2;
		return stackF[stackCtr];
	}

	inline void PopTriple(ssfloat *a, ssfloat *b, ssfloat *c)
	{
		if (stackT[--stackCtr] == ST_Triple) {
			*a = stackF[stackCtr--];
			*b = stackF[stackCtr--];
			*c = stackF[stackCtr];
		}
		else
			*a = *b = *c = stackF[stackCtr];
	}

	inline void PopScalar(Scalar *sp)
	{
		if (stackT[stackCtr - 1] == ST_Triple) {
			sp->type = ST_Triple;
			PopTriple(&sp->v1, &sp->v2, &sp->v3);
		}
		else {
			sp->type = ST_Single;
			sp->v3 = sp->v2 = sp->v1 = PopF();
		}
	}

	int32_t PopL();
	void SampSeq(int seqID, ssfloat v1, ssfloat v2, ExpVars *cVars, bool hasTime, ssfloat tval, Scalar *out);
};

void    HSVtoRGB(Scalar *rgb);
ssfloat Angle(ssfloat xd, ssfloat yd);
ssfloat Distance(ssfloat xd, ssfloat yd);

// (int) of a double, as 32-bit Windows did it: out-of-range and NaN give INT_MIN
int32_t TruncXToLong(ssfloat d);

// $a samples the other sequence with this sequence's raw x,y taken as 0..1 coordinates
// (false, the original) or at the same relative position in the field (true)
extern bool gRelativeSampling;

#endif
