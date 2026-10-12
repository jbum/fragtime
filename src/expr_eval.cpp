// expr_eval.cpp -- the expression VM (port of ExpMgr::EvalScalar, QTS expmgr.cpp).

#include "expr.h"
#include "qts_math.h"
#include "image.h"
#include "seq.h"
#include "renderer.h"
#include <string.h>

ExpVars::ExpVars()
{
	memset((void *) this, 0, offsetof(ExpVars, itsSourceImage));
	renderer = NULL;
	lastResult.v1 = lastResult.v2 = lastResult.v3 = 0; lastResult.type = ST_Single;
	lastX = lastY = 0;
}

int32_t TruncXToLong(ssfloat d)
{
	// What (int) did on 32-bit Windows (and does on x86-64): INT_MIN for anything that
	// doesn't fit, NaN included. WebAssembly would trap, so spell it out.
	if (!(d > -2147483649.0 && d < 2147483648.0))
		return INT32_MIN;
	return (int32_t) d;
}

int32_t ExpMgr::PopL() { return TruncXToLong(PopF()); }

bool gRelativeSampling = false;

void InitGradientTable();

ExpMgr::ExpMgr()
{
	InitGradientTable();
	stackCtr = 0;
	lastMandelX = lastMandelY = -2;
	lastMandelVal = lastJuliaVal = lastMandelQVal = lastMandel3Val = lastDragonVal = 0;
	lastMandelCPM = 0;
	lastJuliaX = lastJuliaY = lastMandelQX = lastMandelQY = -2;
	lastMandelCPMX = lastMandelCPMY = lastMandel3X = lastMandel3Y = lastDragonX = lastDragonY = -2;
	wd1 = wd2 = 0;
	pi2 = pi*2;
	exp1 = sm_exp(1.0);
	log_half = sm_log(0.5);
	randSeed = 1;
}

// A sequence sampled at normalised coords (v1,v2) of its own field, at the current time
// or at scaled time tval.
void ExpMgr::SampSeq(int seqID, ssfloat v1, ssfloat v2, ExpVars *cVars, bool hasTime, ssfloat tval, Scalar *out)
{
	Renderer *renderer = cVars->renderer;
	Seq *seq = renderer ? renderer->SeqByID(seqID) : NULL;
	if (seq == NULL) {
		out->type = ST_Triple;
		out->v1 = out->v2 = out->v3 = 0;
		return;
	}
	if (seq->itsProps.m_Tile) {
		if (v2 < 0) {
			v2 = fabs(v2);
			v2 = 1-(v2-TruncXToLong(v2));
		}
		else
			v2 -= TruncXToLong(v2);

		if (v1 < 0) {
			v1 = fabs(v1);
			v1 = 1-(v1-TruncXToLong(v1));
		}
		else
			v1 -= TruncXToLong(v1);
	}
	ExpVars *seqVars = &seq->itsProps.expVars;
	seqVars->px = cVars->px;
	seqVars->py = cVars->py;
	seqVars->x = seqVars->leftVal + v1 * seqVars->widthVal;
	seqVars->y = seqVars->topVal + v2 * seqVars->heightVal;
	if (hasTime)
		seqVars->localScaledTime = tval;
	else
		seqVars->localScaledTime = (renderer->globalTime - seq->itsProps.globalDebut) / seq->itsProps.duration;
	seqVars->localFrameNbr = TruncXToLong(seqVars->localScaledTime * seq->itsProps.duration * seq->itsProps.frameRate);
	renderer->ComputeAndSaveSubColor(&seq->itsProps, out);
}

static inline uint32_t PixelAt(const Image *img, int tx, int ty)
{
	return img ? img->GetPixel(tx, ty) : 0;
}
#define GetRValue(c) ((int) ((c) & 0xFF))
#define GetGValue(c) ((int) (((c) >> 8) & 0xFF))
#define GetBValue(c) ((int) (((c) >> 16) & 0xFF))

Scalar *ExpMgr::EvalScalar(const ExpRec &cExp, ExpVars *cVars, Scalar *retPtr)
{
	ssfloat  v1, v2, v3;
	Scalar   sc1, sc2;
	int32_t  lv1, lv2;
	int      lastStackCtr = stackCtr;
	const Instr *code = cExp.code.data();
	int      n = (int) cExp.code.size();
	const Image *img = cVars->itsSourceImage.get();

	if (cExp.cFlags & EF_HasMandel)
		CalcMandel(cVars->x, cVars->y, cVars->recur);
	else if (cExp.cFlags & EF_HasMandelQ)
		CalcMandelQ(cVars->x, cVars->y, cVars->p0, cVars->q0, cVars->recur);
	else if (cExp.cFlags & EF_HasJulia)
		CalcJulia(cVars->x, cVars->y, cVars->p0, cVars->q0, cVars->recur);
	else if (cExp.cFlags & EF_HasWorley2)
		CalcWorley2(cVars->x, cVars->y);
	else if (cExp.cFlags & EF_HasWorley3)
		CalcWorley3(cVars->x, cVars->y, 0.5);

	for (int ip = 0; ip < n; ++ip) {
		const Instr &ins = code[ip];
		if (stackCtr >= kMaxExecStack - 4)
			break;		// expression too deep: give up on it
		switch (ins.kind) {
		case 'O':
			switch (ins.code) {
			case OP_Add:
				PushF(PopF()+PopF());
				break;
			case OP_Subtract:
				v2 = PopF();
				v1 = PopF();
				PushF(v1-v2);
				break;
			case OP_Negate:
				PushF(-PopF());
				break;
			case OP_Multiply:
				PushF(PopF()*PopF());
				break;
			case OP_Divide:
				v2 = PopF();
				v1 = PopF();
				PushF(v2 == 0.0? HUGE_VAL : (v1/v2));
				break;
			case OP_Modulo:
				lv2 = PopL();
				lv1 = PopL();
				PushF((lv2 == 0 || (lv2 == -1 && lv1 == INT32_MIN))? 0.0 : (lv1%lv2));
				break;
			case OP_Power:
				v2 = PopF();
				v1 = PopF();
				PushF(sm_pow(v1,v2));
				break;
			case OP_Power2:
				v1 = PopF();
				PushF(sm_pow(2.0,v1));
				break;
			case OP_Integer:
				PushF(PopL());
				break;
			case OP_And:
				PushF(PopL() & PopL());
				break;
			case OP_Or:
				PushF(PopL() | PopL());
				break;
			case OP_Xor:
				PushF(PopL() ^ PopL());
				break;
			case OP_Invert:
				PushF(~PopL());
				break;
			case OP_Equal:
				PushF(PopF()==PopF()? 1.0 : 0.0);
				break;
			case OP_Neq:
				PushF(PopF()==PopF()? 0.0 : 1.0);
				break;
			case OP_Greater:
				v2 = PopF();
				v1 = PopF();
				PushF(v1>v2? 1.0 : 0.0);
				break;
			case OP_Gte:
				v2 = PopF();
				v1 = PopF();
				PushF(v1>=v2? 1.0 : 0.0);
				break;
			case OP_Less:
				v2 = PopF();
				v1 = PopF();
				PushF(v1<v2? 1.0 : 0.0);
				break;
			case OP_Lse:
				v2 = PopF();
				v1 = PopF();
				PushF(v1<=v2? 1.0 : 0.0);
				break;
			case OP_Not:
				PushF(PopF()==0? 1.0 : 0.0);
				break;
			case OP_LogicAnd:
				v2 = PopF();
				v1 = PopF();
				PushF((v1 != 0.0 && v2 != 0.0)? 1.0 : 0.0);
				break;
			case OP_LogicOr:
				v2 = PopF();
				v1 = PopF();
				PushF((v1 != 0.0 || v2 != 0.0)? 1.0 : 0.0);
				break;
			case OP_Angle:
				v2 = PopF();
				v1 = PopF();
				PushF(Angle(v1,v2));
				break;
			case OP_Dist:
				v2 = PopF();
				v1 = PopF();
				PushF(Distance(v1,v2));
				break;
			case OP_Sqrt:       PushF(sqrt(PopF()));				break;
			case OP_Log:				PushF(sm_log(PopF()));				break;
			case OP_Log10:			PushF(sm_log10(PopF()));			break;
			case OP_Fabs:				PushF(fabs(PopF()));				break;
			case OP_Sign:				PushF(PopF() < 0? -1.0 : 1.0);		break;
			case OP_Exp:				PushF(sm_exp(PopF()));				break;
			case OP_Cos:				PushF(sm_cos(PopF()));				break;
			case OP_Sin:				PushF(sm_sin(PopF()));				break;
			case OP_Sin2:				v1 = sm_sin(PopF());		PushF(v1*v1);				break;
			case OP_Cos2:				v1 = sm_cos(PopF());		PushF(v1*v1);				break;
			case OP_Sin3:				v1 = sm_sin(PopF());		PushF(v1*v1*v1);		break;
			case OP_Cos3:				v1 = sm_cos(PopF());		PushF(v1*v1*v1);		break;
			case OP_Tan:				PushF(sm_tan(PopF()));				break;
			case OP_ACos:				PushF(sm_acos(PopF()));				break;
			case OP_ASin:				PushF(sm_asin(PopF()));				break;
			case OP_ATan:				PushF(sm_atan(PopF()));				break;
			case OP_Cosh:				PushF(sm_cosh(PopF()));				break;
			case OP_Sinh:				PushF(sm_sinh(PopF()));				break;
			case OP_Tanh:				PushF(sm_tanh(PopF()));				break;

			case OP_Mandel2:
				v2 = PopF();
				v1 = PopF();
				PushF(CalcMandel(v1, v2, cVars->recur));
				break;
			case OP_MandelFast:
				PushF(lastMandelVal);
				break;
			case OP_MandelQ2:
				v2 = PopF();
				v1 = PopF();
				PushF(CalcMandelQ(cVars->x,cVars->y,v1, v2, cVars->recur));
				break;
			case OP_MandelQFast:
				PushF(lastMandelQVal);
				break;
			case OP_MandelCPM:
				PushF(CalcMandelCPM(cVars->x,cVars->y,cVars->recur));
				break;
			case OP_Mandel3:
				PushF(CalcMandel3(cVars->x,cVars->y,cVars->recur));
				break;
			case OP_JuliaFast:
				PushF(lastJuliaVal);
				break;
			case OP_Julia2:
				v2 = PopF();
				v1 = PopF();
				PushF(CalcJulia(cVars->x,cVars->y,v1,v2,cVars->recur));
				break;
			case OP_Julia4:
				{
					ssfloat v4 = PopF();
					v3 = PopF();
					v2 = PopF();
					v1 = PopF();
					PushF(CalcJulia(v1,v2,v3,v4,cVars->recur));
				}
				break;
			case OP_Dragon:
				PushF(CalcDragon(cVars->x,cVars->y,cVars->p0,cVars->q0,cVars->recur));
				break;
			case OP_Zebra:
				{
					ssfloat v4;
					v4 = PopF();
					v3 = PopF();
					v2 = PopF();
					v1 = PopF();
					PushF(CalcZebra(v1,v2,v3,v4));
				}
				break;
			case OP_Fib:
				PushF(Fibonacci(PopL()));
				break;
			case OP_Prime:
				PushF(isPrime(PopL()));
				break;
			case OP_FBM:
				{
					ssfloat v4,v5,v6;
					v6 = PopF();
					v5 = PopF();
					v4 = PopF();
					v3 = PopF();
					v2 = PopF();
					v1 = PopF();
					PushF(fBm(v1,v2,v3,v4,v5,v6));
				}
				break;
			case OP_FBMT:
				{
					ssfloat v4,v5,v6;
					v6 = PopF();
					v5 = PopF();
					v4 = PopF();
					v3 = PopF();
					v2 = PopF();
					v1 = PopF();
					PushF(fBmT(v1,v2,v3,v4,v5,v6));
				}
				break;
			case OP_FastNoise2:
				PushF(gnoise2d(cVars->x,cVars->y));
				break;
			case OP_Noise:
				v2 = PopF();
				v1 = PopF();
				PushF(gnoise2d(v1,v2));
				break;
			case OP_Noise2:
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				PushF(gnoisetest(v1,v2,0,v3));
				break;
			case OP_Noise3D:
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				PushF(gnoise3d(v1,v2,v3));
				break;
			case OP_FastFNoise2:
				PushF(FNoise2D(cVars->x,cVars->y));
				break;
			case OP_FNoise:
				v2 = PopF();
				v1 = PopF();
				PushF(FNoise2D(v1,v2));
				break;
			case OP_FNoise3D:
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				PushF(FNoise3D(v1,v2,v3));
				break;
			case OP_FastTurb2:
				PushF(GTurbulence2D(cVars->x,cVars->y));
				break;
			case OP_Turb:
				v2 = PopF();
				v1 = PopF();
				PushF(GTurbulence2D(v1,v2));
				break;
			case OP_Turb3D:
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				PushF(GTurbulence3D(v1,v2,v3));
				break;
			case OP_WNoise1:
				PushF(wd1);
				break;
			case OP_WNoise2:
				PushF(wd2);
				break;
			case OP_terp:
				PopScalar(&sc2);
				PopScalar(&sc1);
				Interpolate(&sc1,&sc2,cVars->localScaledTime);
				PushScalar(&sc1);
				break;
			case OP_terpt:
				v1 = PopF();		// time
				PopScalar(&sc2);	// color 2
				PopScalar(&sc1);	// color 1
				Interpolate(&sc1,&sc2,v1);
				PushScalar(&sc1);
				break;
			case OP_pinch:
				PopScalar(&sc1);
				Pinch(&sc1, 2);
				PushScalar(&sc1);
				break;
			case OP_pinch2:
				v1 = PopF();
				PopScalar(&sc1);
				Pinch(&sc1, v1);
				PushScalar(&sc1);
				break;
			case OP_ease:
				PopScalar(&sc1);
				Ease(&sc1);
				PushScalar(&sc1);
				break;
			case OP_bias:
				v1 = PopF();
				PopScalar(&sc1);
				Bias(&sc1, v1);
				PushScalar(&sc1);
				break;
			case OP_biast:		// bias(p): bias the local time by p
				v1 = PopF();
				PushF(cVars->localScaledTime);
				PopScalar(&sc1);
				Bias(&sc1, v1);
				PushScalar(&sc1);
				break;
			case OP_gain:
				v1 = PopF();
				PopScalar(&sc1);
				Gain(&sc1, v1);
				PushScalar(&sc1);
				break;
			case OP_gaint:
				v1 = PopF();
				PushF(cVars->localScaledTime);
				PopScalar(&sc1);
				Gain(&sc1, v1);
				PushScalar(&sc1);
				break;
			case OP_Min:
				v2 = PopF();
				v1 = PopF();
				PushF(v1 <= v2? v1 : v2);
				break;
			case OP_Max:
				v2 = PopF();
				v1 = PopF();
				PushF(v1 >= v2? v1 : v2);
				break;
			case OP_Clamp:
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				PushF(v1 <= v2? v2 : (v1 >= v3? v3 : v1));
				break;
			case OP_limit:
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				PushF(limit(v1,v2,v3));
				break;
			case OP_linen:
				{
					ssfloat	v4;
					v4 = PopF();
					v3 = PopF();
					v2 = PopF();
					v1 = PopF();
					PushF(linen(v1,v2,v3,v4));
				}
				break;
			case OP_linenr:
				{
					ssfloat	v4;
					v4 = PopF();
					v3 = PopF();
					v2 = PopF();
					v1 = PopF();
					PushF(linenr(v1,v2,v3,v4));
				}
				break;
			case OP_Red:
			case OP_Green:
			case OP_Blue:
				{
					v2 = PopF(); // y
					v1 = PopF(); // x
					uint32_t rgbv = 0;
					if (img)
						rgbv = img->GetPixel(TruncXToLong(v1*img->width), TruncXToLong(v2*img->height));
					PushF(ins.code == OP_Red ? GetRValue(rgbv) : ins.code == OP_Green ? GetGValue(rgbv) : GetBValue(rgbv));
				}
				break;
			case OP_SampleN:
				{
					uint32_t rgb = 0;
					if (img)
						rgb = img->Sample(cVars->x,cVars->y,cVars->tileMode);
					PushTriple(GetRValue(rgb)*(1/255.0),
										 GetGValue(rgb)*(1/255.0),
										 GetBValue(rgb)*(1/255.0));
				}
				break;
			case OP_SampleP:
				{
					uint32_t rgb = 0;
					if (img)
						rgb = img->Sample((ssfloat) cVars->px / img->width,
										  (ssfloat) cVars->py / img->height,
										  cVars->tileMode);
					PushTriple(GetRValue(rgb)*(1/255.0),
										 GetGValue(rgb)*(1/255.0),
										 GetBValue(rgb)*(1/255.0));
				}
				break;
			case OP_SampleN_2:
				{
					v2 = PopF();
					v1 = PopF();
					uint32_t rgb = 0;
					if (img)
						rgb = img->Sample(v1,v2,cVars->tileMode);
					PushTriple(GetRValue(rgb)*(1/255.0),
										 GetGValue(rgb)*(1/255.0),
										 GetBValue(rgb)*(1/255.0));
				}
				break;
			case OP_SampleP_2:
				{
					v2 = PopF();
					v1 = PopF();
					uint32_t rgb = 0;
					if (img)
						rgb = img->Sample(v1 / img->width, v2 / img->height, cVars->tileMode);
					PushTriple(GetRValue(rgb)*(1/255.0),
										 GetGValue(rgb)*(1/255.0),
										 GetBValue(rgb)*(1/255.0));
				}
				break;
			case OP_RGB:
			case OP_Triple:
				{
					v3 = PopF(); // blue
					v2 = PopF(); // green
					v1 = PopF(); // red
					PushTriple(v1, v2, v3);
				}
				break;
			case OP_HSV:
				{
					sc1.v3 = PopF();
					sc1.v2 = PopF();
					sc1.v1 = PopF();
					sc1.type = ST_Triple;
					HSVtoRGB(&sc1);
					PushScalar(&sc1);
				}
				break;
			// $a and $a[t]: the other sequence at this pixel, with this sequence's raw x,y
			// taken as 0..1 coordinates of a's field. That is what the source did and what
			// the archive's June 2001 and 2003 QuickTime renders show. Noise Etude (Feb 2001)
			// needs the same *relative* position instead (gRelativeSampling, the CLI's --rel);
			// examples/noiseetude.can was rewritten to say so explicitly, so it renders the
			// same either way.
			case OP_SampSeq:
				lv1 = PopL();
				if (gRelativeSampling)
					SampSeq(lv1, (cVars->x - cVars->leftVal) / cVars->widthVal,
					        (cVars->y - cVars->topVal) / cVars->heightVal, cVars, false, 0, &sc1);
				else
					SampSeq(lv1, cVars->x, cVars->y, cVars, false, 0, &sc1);
				PushScalar(&sc1);
				break;
			case OP_SampSeqT:
				lv1 = PopL();
				v3 = PopF();
				if (gRelativeSampling)
					SampSeq(lv1, (cVars->x - cVars->leftVal) / cVars->widthVal,
					        (cVars->y - cVars->topVal) / cVars->heightVal, cVars, true, v3, &sc1);
				else
					SampSeq(lv1, cVars->x, cVars->y, cVars, true, v3, &sc1);
				PushScalar(&sc1);
				break;
			case OP_SampSeqXY:
				lv1 = PopL();
				v2 = PopF();
				v1 = PopF();
				SampSeq(lv1, v1, v2, cVars, false, 0, &sc1);
				PushScalar(&sc1);
				break;
			case OP_SampSeqDA: // polar coords
				{
					lv1 = PopL();
					v2 = PopF();  // a
					v1 = PopF();  // d
					ssfloat x = .5 + sm_cos(v2)*v1;
					ssfloat y = .5 - sm_sin(v2)*v1;
					SampSeq(lv1, x, y, cVars, false, 0, &sc1);
					PushScalar(&sc1);
				}
				break;
			case OP_SampSeqXYT:
				lv1 = PopL();
				v3 = PopF();
				v2 = PopF();
				v1 = PopF();
				SampSeq(lv1, v1, v2, cVars, true, v3, &sc1);
				PushScalar(&sc1);
				break;
			default:
				break;
			}
			break;

		case 'V':
			switch (ins.code) {
			case V_Number:
				PushF(ins.num);
				break;
			case V_Time:
				PushF(cVars->localScaledTime);
				break;
			case V_GlobalTime:
				PushF(cVars->globalScaledTime);
				break;
			case V_RANDOM:
				PushF(DoubleRandom());
				break;
			case V_X:
				PushF(cVars->x);
				break;
			case V_Y:
				PushF(cVars->y);
				break;
			case V_W:
				PushF(cVars->widthVal);
				break;
			case V_H:
				PushF(cVars->heightVal);
				break;
			case V_A:
				PushF(Angle(cVars->x  - cVars->centerX,
							cVars->y - cVars->centerY));
				break;
			case V_D:
				PushF(Distance(cVars->x  - cVars->centerX,
								cVars->y - cVars->centerY));
				break;
			case V_I:
				PushF(cVars->recur);
				break;
			case V_FrameNbr:
				PushF(cVars->localFrameNbr);
				break;
			case V_GlobalFrameNbr:
				PushF(cVars->globalFrameNbr);
				break;
			case V_FW:
				PushF(cVars->fw);
				break;
			case V_FH:
				PushF(cVars->fh);
				break;
			case V_JX:
				PushF(cVars->p0);
				break;
			case V_JY:
				PushF(cVars->q0);
				break;
			case V_PX:
				PushF(cVars->px);
				break;
			case V_PY:
				PushF(cVars->py);
				break;
			case V_PW:
				PushF(cVars->pw);
				break;
			case V_PH:
				PushF(cVars->ph);
				break;
			case V_CX:
				PushF(cVars->centerX);
				break;
			case V_CY:
				PushF(cVars->centerY);
				break;
			case V_SX:
				PushF(SphereX((ssfloat) cVars->px/cVars->fw,(ssfloat) cVars->py/cVars->fh));
				break;
			case V_SY:
				PushF(SphereY((ssfloat) cVars->px/cVars->fw,(ssfloat) cVars->py/cVars->fh));
				break;
			case V_SZ:
				PushF(SphereZ((ssfloat) cVars->px/cVars->fw,(ssfloat) cVars->py/cVars->fh));
				break;
			case V_E:
				PushF(exp1);
				break;
			case V_PI:
				PushF(pi);
				break;
			case V_PI2:
				PushF(pi2);
				break;
			// The r,g,b,c,s,l variables read the source image at this pixel. Their odd
			// scales (r,g 0-255 but b 0-1, hue 0-255) are the original's.
			case V_R:
			case V_G:
			case V_B:
			case V_C:
			case V_S:
			case V_L:
				{
					uint32_t rgbv = 0;
					if (img)
						rgbv = img->GetPixel((int) ((cVars->px*img->width)/cVars->pw),
											 (int) ((cVars->py*img->height)/cVars->ph));
					int red = GetRValue(rgbv), grn = GetGValue(rgbv), blu = GetBValue(rgbv);
					if (ins.code == V_R) { PushF(red); break; }
					if (ins.code == V_G) { PushF(grn); break; }
					if (ins.code == V_B) { PushF(blu*(1/255.0)); break; }
					int value = red > grn ? red : grn;
					if (blu > value) value = blu;
					int minVal = red < grn ? red : grn;
					if (blu < minVal) minVal = blu;
					if (ins.code == V_L) { PushF(value); break; }
					if (ins.code == V_S) { PushF(value == 0 ? 0.0 : (value - minVal)*255.0/value); break; }
					// hue
					if (value == 0 || value == minVal)
						PushF(0.0);
					else {
						ssfloat cr,cg,cb,hue,div;
						div = (ssfloat) (value - minVal);
						cr = (value - red) / div;
						cg = (value - grn) / div;
						cb = (value - blu) / div;
						if (red == value)
							hue = cb - cg;
						else if (grn == value)
							hue = 2 + cr - cb;
						else if (blu == value)
							hue = 4 + cg - cr;
						else
							hue = 0;
						hue *= 60;
						if (hue < 0)
							hue += 360;
						PushF(hue*255/360.0);
					}
				}
				break;
			case V_Left:
				PushF(cVars->leftVal);
				break;
			case V_Top:
				PushF(cVars->topVal);
				break;
			case V_ZoomFac:
				PushF(cVars->zoomVal);
				break;
			case V_IW:
				PushF(img? img->width : 0.0);
				break;
			case V_IH:
				PushF(img? img->height : 0.0);
				break;
			case V_Recurse:
				PushF(cVars->recur);
				break;
			case V_Duration:
				PushF(cVars->duration);
				break;
			case V_MaxVal:
				PushF(cVars->maxVal);
				break;
			case V_MinVal:
				PushF(cVars->minVal);
				break;
			}
			break;

		case 'X':
			if (ins.code == X_Cond) {
				v1 = PopF();
				if (v1 != 0.0)
					break;			// fall into the then-branch
			}
			ip = ins.target - 1;	// jump (the loop's ++ip lands on target)
			break;
		}
	}
	if (stackCtr > lastStackCtr)
		PopScalar(retPtr);
	else {
		retPtr->type = ST_Single;
		retPtr->v1 = 0.0;
	}
	stackCtr = lastStackCtr;
	return retPtr;
}
