// renderer.h -- renders one frame of a Script into an RGB buffer (port of QTS Renderer).
//
// A frame: find the leaf sequences alive at this time, evaluate each one's expression
// per pixel (4 sub-samples when oversampling), pin the result into 0..1 (clamp or wrap),
// and composite the layers back to front with their channel ops.

#ifndef QTS_RENDERER_H
#define QTS_RENDERER_H

#include "seq.h"
#include <vector>
#include <functional>

class Renderer {
public:
	Script  *script;
	ExpMgr  *expMgr;
	int      pictureWidth, pictureHeight;
	ssfloat  globalTime, globalScaledTime;
	long     globalFrameNbr;
	ssfloat  movieDuration;
	// set from another thread to stop a render early
	volatile bool *interrupt;
	// called after each row (0..1 of the frame); return false to stop
	std::function<bool(int)> onRow;

	Renderer(Script *s, int w, int h);

	// Frame frameNbr of nbrFrames (globalScaledTime = frameNbr/nbrFrames), or, when
	// nbrFrames is 1, the single frame at snapshotTime (0..1). rgb is width*height*3,
	// filled for rows y0..y1-1 (the others untouched). Returns false if interrupted.
	bool RenderFrame(int frameNbr, int nbrFrames, ssfloat snapshotTime,
	                 uint8_t *rgb, int y0 = 0, int y1 = -1);

	Seq *SeqByID(int id) const
	{
		if (id < 1 || id > (int) script->seqByID.size()) return NULL;
		return script->seqByID[id-1];
	}

	void ComputeAndSaveColor(PropsRec *pRec, Scalar *result);
	Scalar *ComputeAndSaveSubColor(PropsRec *pRec, Scalar *result);

private:
	std::vector<PropsRec *> itsSeqList;
	std::vector<uint8_t>    tempRGB;

	void InitFrameVars();
	bool StepRender(uint8_t *rgb, int y0, int y1);
	bool StepRenderChannel(PropsRec *pPtr, uint8_t *rgb, int y0, int y1);
	void MixIn(uint8_t *dst, const uint8_t *src, int chop, int y0, int y1);

	inline void PinScalar(Scalar *sp, ExpVars *eVars)
	{
		sp->v1 = PinF(sp->v1, eVars);
		if (sp->type == ST_Triple)
		{
			sp->v2 = PinF(sp->v2, eVars);
			sp->v3 = PinF(sp->v3, eVars);
		}
		else {
			sp->v2 = sp->v3 = sp->v1;
		}
	}

	inline ssfloat PinF(double v, ExpVars *eVars)
	{
		if (eVars->wrapMode)
		{
			v = (v - eVars->minVal) * eVars->tranFactor;
			if (v < 0) {
				v = -v;
				v = 1-(v - TruncXToLong(v));
			}
			else
				v -= TruncXToLong(v);
		}
		else {
			if (v < eVars->minVal)
				v = eVars->minVal;
			else if (v > eVars->maxVal)
				v = eVars->maxVal;
			else
				v = (v - eVars->minVal) * eVars->tranFactor;
		}
		if (eVars->cycleMode) {
			v = (v + (1/256.0)*globalFrameNbr);
			v -= TruncXToLong(v);
		}
		return v;
	}
};

#endif
