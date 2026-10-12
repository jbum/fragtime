// renderer.cpp -- port of QTS Renderer.cpp (StepRender path) and PMDIB::MixIn.
//
// Faithful to the original where its quirks show in a picture: a value outside min..max
// in clamp mode becomes min or max itself rather than 0 or 1 (so min=-1 clips to -1,
// and the 8-bit output wraps), oversampling averages HSV triples before converting,
// and a sampled sequence is cached by position only.

#include "renderer.h"
#include "qts_math.h"
#include <string.h>

Renderer::Renderer(Script *s, int w, int h)
{
	script = s;
	expMgr = &s->expMgr;
	pictureWidth = w;
	pictureHeight = h;
	globalTime = globalScaledTime = 0;
	globalFrameNbr = 0;
	movieDuration = s->Duration();
	interrupt = NULL;
}

// Rows' random streams: a hash so chunks of rows rendered elsewhere agree
static int32_t RowSeed(long frame, int row)
{
	uint32_t h = 2166136261u;
	h = (h ^ (uint32_t) frame) * 16777619u;
	h = (h ^ (uint32_t) row) * 16777619u;
	h = (h ^ 0x9e3779b9u) * 16777619u;
	int32_t s = (int32_t) (h & 0x7fffffff);
	return s == 0 ? 1 : s;
}

void Renderer::InitFrameVars()
{
	globalTime = globalScaledTime * movieDuration;
	itsSeqList.clear();
	script->mainSeq->InitPropsForFrame(this, itsSeqList, globalTime);
}

bool Renderer::RenderFrame(int frameNbr, int nbrFrames, ssfloat snapshotTime,
                           uint8_t *rgb, int y0, int y1)
{
	if (y1 < 0 || y1 > pictureHeight) y1 = pictureHeight;
	if (y0 < 0) y0 = 0;
	globalFrameNbr = frameNbr;
	if (nbrFrames > 1)
		globalScaledTime = (ssfloat) frameNbr / (ssfloat) nbrFrames;
	else
		globalScaledTime = snapshotTime;
	InitFrameVars();
	tempRGB.resize((size_t) pictureWidth * pictureHeight * 3);
	return StepRender(rgb, y0, y1);
}

bool Renderer::StepRender(uint8_t *rgb, int y0, int y1)
{
	size_t i = 0;

	// Layers under an opaque (normal) layer never show: start at the last of those
	while (i + 1 < itsSeqList.size() && itsSeqList[i+1]->channelOp == CHOP_Normal)
		++i;

	if (i >= itsSeqList.size()) {
		// nothing alive at this time: black
		memset(rgb + (size_t) y0 * pictureWidth * 3, 0, (size_t) (y1 - y0) * pictureWidth * 3);
		return true;
	}

	for (; i < itsSeqList.size(); ++i)
	{
		if (itsSeqList[i]->flags & SeqF_IsMap)	// maps are only sampled, never drawn
			continue;
		if (!StepRenderChannel(itsSeqList[i], rgb, y0, y1))
			return false;
	}
	return true;
}

bool Renderer::StepRenderChannel(PropsRec *pPtr, uint8_t *rgb, int y0, int y1)
{
	ExpVars *expVars = &pPtr->expVars;
	uint8_t *dst = pPtr->channelOp == CHOP_Normal ? rgb : tempRGB.data();

	for (expVars->py = y0; expVars->py < y1; ++expVars->py)
	{
		expVars->y = expVars->topVal + expVars->yInc * expVars->py;
		expMgr->SeedRandom(RowSeed(globalFrameNbr, expVars->py));
		uint8_t *row = dst + (size_t) expVars->py * pictureWidth * 3;

		for (expVars->px = 0; expVars->px < pictureWidth; ++expVars->px)
		{
			expVars->x = expVars->px*expVars->xInc + expVars->leftVal;
			Scalar	result;
			ComputeAndSaveColor(pPtr, &result);
			if (result.type == ST_Triple) {
				row[0] = (uint8_t) TruncXToLong(result.v1*255);
				row[1] = (uint8_t) TruncXToLong(result.v2*255);
				row[2] = (uint8_t) TruncXToLong(result.v3*255);
			}
			else {
				row[0] = row[1] = row[2] = (uint8_t) TruncXToLong(result.v1*255);
			}
			row += 3;
		}
		if (interrupt && *interrupt)
			return false;
		if (onRow && !onRow(expVars->py))
			return false;
	}
	if (pPtr->channelOp != CHOP_Normal)
		MixIn(rgb, tempRGB.data(), pPtr->channelOp, y0, y1);
	return true;
}

void Renderer::ComputeAndSaveColor(PropsRec *pRec, Scalar *result)
{
	ExpVars *eVars = &pRec->expVars;

	switch (pRec->m_Colormode) {
	case CM_Mono:
		if (pRec->m_Oversample) {
			ssfloat	x,y;
			ssfloat	r1,r2,r3,r4;
			x = eVars->x;
			y = eVars->y;
			r1 = PinF(expMgr->EvalF(pRec->m_PixExp, eVars),eVars);
			eVars->y += eVars->yInc/2;
			r2 = PinF(expMgr->EvalF(pRec->m_PixExp, eVars),eVars);
			eVars->x += eVars->xInc/2;
			r3 = PinF(expMgr->EvalF(pRec->m_PixExp, eVars),eVars);
			eVars->y = y;
			r4 = PinF(expMgr->EvalF(pRec->m_PixExp, eVars),eVars);
			eVars->x = x;
			result->v1 = (r1+r2+r3+r4) * 0.25;
			result->type = ST_Single;
		}
		else {
			result->v1 = PinF(expMgr->EvalF(pRec->m_PixExp, eVars),eVars);
			result->type = ST_Single;
		}
		break;
	case CM_TripletRGB:
	case CM_TripletHSV:
		if (pRec->m_Oversample) {
			ssfloat	x,y;
			Scalar	p1,p2,p3,p4;
			x = eVars->x;
			y = eVars->y;
			PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, &p1), eVars);
			eVars->y += eVars->yInc/2;
			PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, &p2), eVars);
			eVars->x += eVars->xInc/2;
			PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, &p3), eVars);
			eVars->y = y;
			PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, &p4), eVars);
			eVars->x = x;
			result->v1 = (p1.v1 + p2.v1 + p3.v1 + p4.v1) * 0.25;
			result->v2 = (p1.v2 + p2.v2 + p3.v2 + p4.v2) * 0.25;
			result->v3 = (p1.v3 + p2.v3 + p3.v3 + p4.v3) * 0.25;
			result->type = ST_Triple;
		}
		else {
			PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, result), eVars);
		}
		if (pRec->m_Colormode == CM_TripletHSV)
			HSVtoRGB(result);
		break;
	default:
		result->v1 = 0;
		result->type = ST_Single;
	}
}

// A sequence sampled from another's expression: never oversampled, cached per position
Scalar *Renderer::ComputeAndSaveSubColor(PropsRec *pRec, Scalar *result)
{
	ExpVars *eVars = &pRec->expVars;

	if (eVars->lastX == eVars->x && eVars->lastY == eVars->y)
	{
		*result = eVars->lastResult;
		return result;
	}

	switch (pRec->m_Colormode) {
	case CM_Mono:
		result->v1 = PinF(expMgr->EvalF(pRec->m_PixExp, eVars),eVars);
		result->type = ST_Single;
		break;
	case CM_TripletRGB:
		PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, result), eVars);
		break;
	case CM_TripletHSV:
		PinScalar(expMgr->EvalScalar(pRec->m_PixExp, eVars, result), eVars);
		HSVtoRGB(result);
		break;
	default:
		result->v1 = 0;
		result->type = ST_Single;
	}
	eVars->lastX = eVars->x;
	eVars->lastY = eVars->y;
	eVars->lastResult = *result;
	return result;
}

// Photoshop-style channel ops on 8-bit values (PMDIB::MixIn). dst is the picture so
// far (A), src the new layer (B). Lighten had a missing break in the original (it fell
// into multiply); here it lightens. Dodge, burn, hue, saturation, color and luminosity
// were never written: those layers are skipped, as they were.
void Renderer::MixIn(uint8_t *dst, const uint8_t *src, int chop, int y0, int y1)
{
	size_t from = (size_t) y0 * pictureWidth * 3, to = (size_t) y1 * pictureWidth * 3;
	for (size_t i = from; i < to; ++i) {
		int a = dst[i], b = src[i], r;
		switch (chop) {
		case CHOP_Darken:     r = a < b ? a : b; break;
		case CHOP_Lighten:    r = a > b ? a : b; break;
		case CHOP_Multiply:   r = (int) (255 * (a/255.0) * (b/255.0)); break;
		case CHOP_Screen:     r = 255 - (int) (255 * ((255-a)/255.0) * ((255-b)/255.0)); break;
		case CHOP_Overlay:
			r = (int) (255*((a/255.0)*((a/255.0) * (b/255.0)) +
				((255-a)/255.0)*(1-((255-a)/255.0)*((255-b)/255.0))));
			break;
		case CHOP_Difference: r = a > b ? a - b : b - a; break;
		case CHOP_Exclusion:  r = (int) ((b/255.0)*a + ((255-b)/255.0)*(255-a)); break;
		case CHOP_Softlight:  r = (int) ((b/255.0)*(a < b ? a : b) + ((255-b)/255.0)*(a > b ? a : b)); break;
		case CHOP_Hardlight:
			r = (int) (255*((b/255.0)*((a/255.0) * (b/255.0)) +
				((255-b)/255.0)*(1-((255-a)/255.0)*((255-b)/255.0))));
			break;
		default:
			return;
		}
		dst[i] = (uint8_t) r;
	}
}
