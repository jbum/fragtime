// expr_funcs.cpp -- noise, fractals, easing, colour and random (port of QTS expfuncs.cpp,
// which began as Pixel Magic's Functions.c, 1990).

#include "expr.h"
#include "qts_math.h"
#include <string.h>

#define TABSIZE          256
#define TABMASK          (TABSIZE-1)
#define PERM(x)          perm[(x)&TABMASK]
#define INDEX(ix,iy,iz)  PERM((ix)+PERM((iy)+PERM(iz)))

#define BIAS(x, p)			(sm_pow( (x), sm_log(p) / log_half ))
#define GAIN(x, p)			(x < .5? BIAS( 2*x, 1-p)/2 : 1 - BIAS(2-2*x,1-p)/2 )

// floor as the original's FLOOR macro computed it, kept finite for WebAssembly
static inline int qfloor(ssfloat x)
{
	int ix = TruncXToLong(x);
	return ix - (x < 0 && x != ix);
}

// ---------------------------------------------------------------- fractals

int	ExpMgr::CalcMandel(ssfloat p0, ssfloat q0, int recur)
{
	if (p0 == lastMandelX && q0 == lastMandelY)
		return lastMandelVal;
	else {
		ssfloat	x=0.0,y=0.0,x1,y1;
		int	kol=0,limit;

		limit = recur;

		x1 = y1 = x;
		do {
			x1 = x1 - y1 + p0;
			y1 = 2*x*y + q0;
			++kol;
			x = x1;
			y = y1;
			x1 *= x1;
			y1 *= y1;
		} while (kol <= limit && x1+y1 < 4.0);

		if (kol > limit)
			kol = 0;
		lastMandelX = p0;
		lastMandelY = q0;
		lastMandelVal = kol;
		return kol;
	}
}

// Mandelbrot set in quaternion space
int	ExpMgr::CalcMandelQ(ssfloat qw, ssfloat qx, ssfloat qy, ssfloat qz, int recur)
{
	if (qw == lastMandelQX && qx == lastMandelQY)
		return lastMandelQVal;
	else {
		ssfloat	rw,rx,ry,rz;
		ssfloat	rw2,rx2,ry2,rz2,tmp;
		int	kol=0,limit;

		limit = recur;

		rw = rx = ry = rz = 0.0;
		do {
			tmp = 2*rw;
			rx2 = tmp*rx;
			ry2 = tmp*ry;
			rz2 = tmp*rz;
			rw2 = rw*rw - (rx*rx+ry*ry+rz*rz);

			rw = rw2 + qw;
			rx = rx2 + qx;
			ry = ry2 + qy;
			rz = rz2 + qz;

			++kol;
		} while (kol <= limit && rw*rw+rx*rx < 4.0);

		if (kol > limit)
			kol = 0;
		lastMandelQX = qw;
		lastMandelQY = qx;
		lastMandelQVal = kol;
		return kol;
	}
}

ssfloat	ExpMgr::CalcMandelCPM(ssfloat p0, ssfloat q0, int recur)
{
	if (p0 == lastMandelCPMX && q0 == lastMandelCPMY)
		return lastMandelCPM;
	else {
		ssfloat	x=0.0,y=0.0,x1,y1,retVal,sumxy;
		int	kol=0,limit;

		limit = recur;

		x1 = x*x;
		y1 = y*y;
		kol = 0;
		do {
			x1 = x1-y1+p0;
			y = 2*x*y+q0;
			x = x1;
			y1 = y;
			x1 *= x1;
			y1 *= y1;
			++kol;
		} while (kol <= limit && x1+y1 < 10000);
		sumxy = x1+y1;
		if (kol > limit)
			retVal = 0.0;
		else {
			retVal = 0.5 * sm_log(sumxy) / sm_pow(2,kol);
		}

		lastMandelCPMX = p0;
		lastMandelCPMY = q0;
		lastMandelCPM = retVal;
		return retVal;
	}
}

int	ExpMgr::CalcDragon(ssfloat x0, ssfloat y0, ssfloat p0, ssfloat q0, int recur)		// z = kz*(1-z)
{
	if (p0 == lastDragonX && q0 == lastDragonY)
		return lastDragonVal;
	else {
		ssfloat	x=0.0,y=0.0,x1,y1;
		int	kol=0,limit;

		limit = recur;

		x1 = y1 = x;
		x = p0;
		y = q0;
		do {
			x1 = x*x0 - y*y0;
			y1 = y*x0 + x*y0;
			x = x1 - x*x1 + y*y1;
			y = y1 - x*y1 + y*y1 - y*x1;
			++kol;
		} while (kol <= limit && x+y < 4.0);

		if (kol > limit)
			kol = 0;
		lastDragonX = p0;
		lastDragonY = q0;
		lastDragonVal = kol;
		return kol;
	}
}

int	ExpMgr::CalcMandel3(ssfloat p0, ssfloat q0, int recur)
{
	ssfloat	x=0.0,y=0.0,x1,y1,x2,y2;
	int	kol=0,limit;

	limit = recur;

	if (p0 == lastMandel3X && q0 == lastMandel3Y)
		return lastMandel3Val;

	x2 = x*x;
	y2 = y*y;
	do {
		x1 = x2*x - 3*x*y2 + p0;
		y1 = 3*x2*y - y2*y + q0;
		++kol;
		x = x1;
		y = y1;
		x2 = x*x;
		y2 = y*y;
	} while (kol <= limit && x2+y2 < 4.0);

	if (kol > limit)
		kol = 0;
	lastMandel3X = p0;
	lastMandel3Y = q0;
	lastMandel3Val = kol;
	return kol;
}

// Here z is x,y and c is p,q
int	ExpMgr::CalcJulia(ssfloat x, ssfloat y, ssfloat p0, ssfloat q0, int recur)
{
	if (x == lastJuliaX && y == lastJuliaY)
		return lastJuliaVal;
	else {
		ssfloat	x1,y1;
		int	kol=0,limit;

		limit = recur;

		lastJuliaX = x;
		lastJuliaY = y;

		x1 = x*x;
		y1 = y*y;
		do {
			x1 = x1 - y1 + p0;
			y1 = 2*x*y + q0;
			++kol;
			x = x1;
			y = y1;
			x1 *= x1;
			y1 *= y1;
		} while (kol <= limit && x1+y1 < 4.0);

		if (kol > limit)
			kol = 0;
		lastJuliaVal = kol;
		return kol;
	}
}

ssfloat ExpMgr::CalcZebra(ssfloat n, ssfloat width, ssfloat step, ssfloat offset)
{
	int32_t	ln;
	int32_t	lwidth = TruncXToLong(width);
	int32_t lstep = TruncXToLong(step);
	if (n == 0.0 || lwidth == 0)
		return 0.0;
	ln = TruncXToLong(n + offset);
	if (ln & 1)
		ln += lstep;
	if ((ln/lwidth) & 1)
		return (lwidth-1) - (ln % lwidth);
	else
		return ln % lwidth;
}

// ---------------------------------------------------------------- easing

void ExpMgr::Ease(Scalar *a)
{
	a->v1 = EASE(a->v1);
	if (a->type == ST_Triple)
	{
		a->v2 = EASE(a->v2);
		a->v3 = EASE(a->v3);
	}
}

// Perlin & Hoffert's bias (Ebert, p. 35)
void ExpMgr::Bias(Scalar *a, ssfloat p)
{
	a->v1 = BIAS(a->v1,p);
	if (a->type == ST_Triple)
	{
		a->v2 = BIAS(a->v2,p);
		a->v3 = BIAS(a->v3,p);
	}
}

void ExpMgr::Gain(Scalar *a, ssfloat p)
{
	a->v1 = GAIN(a->v1,p);
	if (a->type == ST_Triple)
	{
		a->v2 = GAIN(a->v2,p);
		a->v3 = GAIN(a->v3,p);
	}
}

void ExpMgr::Pinch(Scalar *a, ssfloat p)
{
	a->v1 = 1 - sm_pow((1 - a->v1), p);
	if (a->type == ST_Triple)
	{
		a->v2 = 1 - sm_pow((1 - a->v2), p);
		a->v3 = 1 - sm_pow((1 - a->v3), p);
	}
}

void ExpMgr::Interpolate(Scalar *a, Scalar *b, ssfloat t)
{
	if (t < 0.0)
		t = 0.0;
	if (t > 1.0)
		t = 1.0;
	double it = 1-t;
	if (a->type == ST_Single && b->type == ST_Single) {
		a->type = ST_Single;
		a->v1 = a->v1*it + b->v1*t;
	}
	else {
		a->type = ST_Triple;
		a->v1 = a->v1*it + b->v1*t;
		a->v2 = a->v2*it + b->v2*t;
		a->v3 = a->v3*it + b->v3*t;
	}
}

// ---------------------------------------------------------------- worley (cell) noise

void ExpMgr::CalcWorley3(ssfloat x, ssfloat y, ssfloat z)
{
	int			i,j,k;
	ssfloat	s,t,u,ss,tt,uu,sp,tp,up,sd,td,ud,dist,md=1000,md2=1000;

	ss = floor(x)+.5;
	tt = floor(y)+.5;
	uu = floor(z)+.5;

	for (i = -1; i <= 1; ++i)
	{
		s = ss+i;
		for (j = -1; j <= 1; ++j)
		{
			t = tt+j;
			for (k = -1; k <= 1; ++k)
			{
				u = uu+k;
				sp = s + (gnoise3d(s,t,u)-0.5);
				tp = t + (gnoise3d(s+3,t+5,u+7)-0.5);
				up = u + (gnoise3d(s+11,t+12,u+21)-0.5);
				sd = sp - x;
				td = tp - y;
				ud = up - z;
				dist = sd*sd+td*td+ud*ud;
				if (dist < md) {
					md2 = md;
					md = dist;
				}
				else if (dist < md2)
				{
					md2 = dist;
				}
			}
		}
	}
	wd1 = sqrt(md);
	wd2 = sqrt(md2);
}

void ExpMgr::CalcWorley2(ssfloat x, ssfloat y)
{
	int			i,j;
	ssfloat	s,t,ss,tt,sp,tp,sd,td,dist,md=1000,md2=1000;

	ss = floor(x)+.5;
	tt = floor(y)+.5;

	for (i = -1; i <= 1; ++i)
	{
		s = ss+i;
		for (j = -1; j <= 1; ++j)
		{
			t = tt+j;
			sp = s + (gnoise2d(s,t)-0.5);
			tp = t + (gnoise2d(s+3,t+5)-0.5);
			sd = sp - x;
			td = tp - y;
			dist = sd*sd+td*td;
			if (dist < md) {
				md2 = md;
				md = dist;
			}
			else if (dist < md2)
			{
				md2 = dist;
			}
		}
	}
	wd1 = sqrt(md);
	wd2 = sqrt(md2);
}

// ---------------------------------------------------------------- fractal noise

// An optimized fbm(x,y,z,1,2,8)
ssfloat ExpMgr::FNoise3D(ssfloat x, ssfloat y, ssfloat z)
{
	ssfloat	turb, s;
	s = 1;
	turb = gnoise3d(x,y,z);
	int	ix;
	for (ix = 7; ix > 0; --ix) {
		s *= 2;
		turb += 1/s * gnoise3d(x*s,y*s,z*s);
	}
	return turb;
}

ssfloat ExpMgr::FNoise2D(ssfloat x, ssfloat y)
{
	ssfloat	turb, s;
	s = 1;
	turb = gnoise2d(x,y);
	int	ix;
	for (ix = 7; ix > 0; --ix) {
		s *= 2;
		turb += 1/s * gnoise2d(x*s,y*s);
	}
	return turb;
}

// fbm(x,y,z,1,2,8) with abs(noise)
ssfloat ExpMgr::GTurbulence3D(ssfloat x, ssfloat y, ssfloat z)
{
	ssfloat	turb, s;
	s = 1;
	turb = fabs(gnoise3d(x,y,z));
	int	ix;
	for (ix = 7; ix > 0; --ix) {
		s *= 2;
		turb += 1/s * fabs(gnoise3d(x*s,y*s,z*s));
	}
	return turb;
}

ssfloat ExpMgr::GTurbulence2D(ssfloat x, ssfloat y)
{
	ssfloat	turb, s;
	s = 1;
	turb = fabs(gnoise2d(x,y));
	int	ix;
	for (ix = 7; ix > 0; --ix) {
		s *= 2;
		turb += 1/s * fabs(gnoise2d(x*s,y*s));
	}
	return turb;
}

ssfloat ExpMgr::fBm(ssfloat x, ssfloat y, ssfloat z,
		 ssfloat H, ssfloat lacunarity, ssfloat octaves)
{
	ssfloat i,result,amplitude,frequency=1.0;

	result = gnoise3d(x,y,z);
	for (i = octaves-1; i >= 0; i--)
	{
		x *= lacunarity;
		y *= lacunarity;
		z *= lacunarity;
		frequency *= lacunarity;
		amplitude = sm_pow(frequency,-H);
		if (i < 1)	amplitude *= i;
		result += amplitude * gnoise3d(x,y,z);
		if (amplitude < 0.00000000001)
				break;
	}
	return result;
}

ssfloat ExpMgr::fBmT(ssfloat x, ssfloat y, ssfloat z,
		 ssfloat H, ssfloat lacunarity, ssfloat octaves)
{
	ssfloat i,result,amplitude,frequency=1.0;

	result = fabs(gnoise3d(x,y,z));
	for (i = octaves-1; i >= 0; i--)
	{
		x *= lacunarity;
		y *= lacunarity;
		z *= lacunarity;
		frequency *= lacunarity;
		amplitude = sm_pow(frequency,-H);
		if (i < 1)	amplitude *= i;
		result += amplitude * fabs(gnoise3d(x,y,z));
		if (amplitude < 0.00000000001)
				break;
	}
	return result;
}

// ---------------------------------------------------------------- gradient noise (Peachey)

static const unsigned char perm[TABSIZE] = {
        225,155,210,108,175,199,221,144,203,116, 70,213, 69,158, 33,252,
          5, 82,173,133,222,139,174, 27,  9, 71, 90,246, 75,130, 91,191,
        169,138,  2,151,194,235, 81,  7, 25,113,228,159,205,253,134,142,
        248, 65,224,217, 22,121,229, 63, 89,103, 96,104,156, 17,201,129,
         36,  8,165,110,237,117,231, 56,132,211,152, 20,181,111,239,218,
        170,163, 51,172,157, 47, 80,212,176,250, 87, 49, 99,242,136,189,
        162,115, 44, 43,124, 94,150, 16,141,247, 32, 10,198,223,255, 72,
         53,131, 84, 57,220,197, 58, 50,208, 11,241, 28,  3,192, 62,202,
         18,215,153, 24, 76, 41, 15,179, 39, 46, 55,  6,128,167, 23,188,
        106, 34,187,140,164, 73,112,182,244,195,227, 13, 35, 77,196,185,
         26,200,226,119, 31,123,168,125,249, 68,183,230,177,135,160,180,
         12,  1,243,148,102,166, 38,238,251, 37,240,126, 64, 74,161, 40,
        184,149,171,178,101, 66, 29, 59,146, 61,254,107, 42, 86,154,  4,
        236,232,120, 21,233,209, 45, 98,193,114, 78, 19,206, 14,118,127,
         48, 79,147, 85, 30,207,219, 54, 88,234,190,122, 95, 67,143,109,
        137,214,145, 93, 92,100,245,  0,216,186, 60, 83,105, 97,204, 52
};

// Park & Miller's minimal standard generator (CACM Oct 1988): the '?' variable and the
// gradient table use it.
#define	R_A	16807L
#define	R_M	2147483647L
#define R_Q	127773L
#define R_R	2836L

static int32_t NextRandom(int32_t &seed)
{
	int32_t	hi,lo,test;

	hi   = seed / R_Q;
	lo   = seed % R_Q;
	test = R_A * lo - R_R * hi;
	if (test > 0)
		seed = test;
	else
		seed = test + R_M;
	return seed;
}

ssfloat ExpMgr::DoubleRandom()
{
	return NextRandom(randSeed) / (ssfloat) R_M;
}

static ssfloat gradientTab[TABSIZE*3];
static bool gradientReady = false;

// Built once, before any render thread starts (the first ExpMgr does it)
void InitGradientTable();

static void gradientTabInit(int seed)
{
	ssfloat *table = gradientTab;
	ssfloat z, r, theta;
	int32_t rs = seed;
	int i;

	for(i = 0; i < TABSIZE; i++) {
		z = 1. - 2.* (NextRandom(rs) / (ssfloat) R_M);
		r = sqrt(1 - z*z);
		theta = 2 * pi * (NextRandom(rs) / (ssfloat) R_M);
		*table++ = r * sm_cos(theta);
		*table++ = r * sm_sin(theta);
		*table++ = z;
	}
	gradientReady = true;
}

void InitGradientTable()
{
	if (!gradientReady)
		gradientTabInit(665);
}

static inline ssfloat glattice(int ix, int iy, int iz, ssfloat fx, ssfloat fy, ssfloat fz)
{
	const ssfloat *g = &gradientTab[INDEX(ix,iy,iz)*3];
	return g[0]*fx + g[1]*fy + g[2]*fz;
}

ssfloat ExpMgr::gnoise3d(ssfloat x, ssfloat y, ssfloat z)
{
    int ix, iy, iz;
    ssfloat fx0, fx1, fy0, fy1, fz0, fz1;
    ssfloat wx, wy, wz;
    ssfloat vx0, vx1, vy0, vy1, vz0, vz1;

    if (!gradientReady)
        gradientTabInit(665);

    ix = qfloor(x);
    fx0 = x - ix;
    fx1 = fx0 - 1;
    wx = EASE(fx0);

    iy = qfloor(y);
    fy0 = y - iy;
    fy1 = fy0 - 1;
    wy = EASE(fy0);

    iz = qfloor(z);
    fz0 = z - iz;
    fz1 = fz0 - 1;
    wz = EASE(fz0);

    vx0 = glattice(ix,iy,iz,fx0,fy0,fz0);
    vx1 = glattice(ix+1,iy,iz,fx1,fy0,fz0);
    vy0 = LERP(wx, vx0, vx1);
    vx0 = glattice(ix,iy+1,iz,fx0,fy1,fz0);
    vx1 = glattice(ix+1,iy+1,iz,fx1,fy1,fz0);
    vy1 = LERP(wx, vx0, vx1);
    vz0 = LERP(wy, vy0, vy1);

    vx0 = glattice(ix,iy,iz+1,fx0,fy0,fz1);
    vx1 = glattice(ix+1,iy,iz+1,fx1,fy0,fz1);
    vy0 = LERP(wx, vx0, vx1);
    vx0 = glattice(ix,iy+1,iz+1,fx0,fy1,fz1);
    vx1 = glattice(ix+1,iy+1,iz+1,fx1,fy1,fz1);
    vy1 = LERP(wx, vx0, vx1);
    vz1 = LERP(wy, vy0, vy1);

    return LERP(wz, vz0, vz1);
}

ssfloat ExpMgr::gnoise2d(ssfloat x, ssfloat y)
{
    int ix, iy;
    ssfloat fx0, fx1, fy0, fy1;
    ssfloat wx, wy;
    ssfloat vx0, vx1, vy0, vy1;

    if (!gradientReady)
        gradientTabInit(665);

    ix = qfloor(x);
    fx0 = x - ix;
    fx1 = fx0 - 1;
    wx = EASE(fx0);

    iy = qfloor(y);
    fy0 = y - iy;
    fy1 = fy0 - 1;
    wy = EASE(fy0);

    vx0 = glattice(ix,iy,0,fx0,fy0,0);
    vx1 = glattice(ix+1,iy,0,fx1,fy0,0);
    vy0 = LERP(wx, vx0, vx1);
    vx0 = glattice(ix,iy+1,0,fx0,fy1,0);
    vx1 = glattice(ix+1,iy+1,0,fx1,fy1,0);
    vy1 = LERP(wx, vx0, vx1);
    return LERP(wy, vy0, vy1);
}

// noise2(): gradient noise with a gain() curve instead of ease() between lattice points
ssfloat ExpMgr::gnoisetest(ssfloat x, ssfloat y, ssfloat z, ssfloat p)
{
    int ix, iy, iz;
    ssfloat fx0, fx1, fy0, fy1, fz0, fz1;
    ssfloat wx, wy, wz;
    ssfloat vx0, vx1, vy0, vy1, vz0, vz1;

    if (!gradientReady)
        gradientTabInit(665);

    ix = qfloor(x);
    fx0 = x - ix;
    fx1 = fx0 - 1;
    wx = GAIN(fx0,p);

    iy = qfloor(y);
    fy0 = y - iy;
    fy1 = fy0 - 1;
    wy = GAIN(fy0,p);

    iz = qfloor(z);
    fz0 = z - iz;
    fz1 = fz0 - 1;
    wz = GAIN(fz0,p);

    vx0 = glattice(ix,iy,iz,fx0,fy0,fz0);
    vx1 = glattice(ix+1,iy,iz,fx1,fy0,fz0);
    vy0 = LERP(wx, vx0, vx1);
    vx0 = glattice(ix,iy+1,iz,fx0,fy1,fz0);
    vx1 = glattice(ix+1,iy+1,iz,fx1,fy1,fz0);
    vy1 = LERP(wx, vx0, vx1);
    vz0 = LERP(wy, vy0, vy1);

    vx0 = glattice(ix,iy,iz+1,fx0,fy0,fz1);
    vx1 = glattice(ix+1,iy,iz+1,fx1,fy0,fz1);
    vy0 = LERP(wx, vx0, vx1);
    vx0 = glattice(ix,iy+1,iz+1,fx0,fy1,fz1);
    vx1 = glattice(ix+1,iy+1,iz+1,fx1,fy1,fz1);
    vy1 = LERP(wx, vx0, vx1);
    vz1 = LERP(wy, vy0, vy1);

    return LERP(wz, vz0, vz1);
}

// ---------------------------------------------------------------- geometry

// Angle of the vector (xd,yd) from the x axis, 0 - 2pi
ssfloat Angle(ssfloat xd, ssfloat yd)
{
	ssfloat	r;
	r = Distance(xd,yd);
	if (r == 0.0)
		return 0;
	else {
		if (yd > 0)
			return (pi*2)-sm_acos(xd/r);
		else
			return sm_acos(xd/r);
	}
}

ssfloat Distance(ssfloat xd, ssfloat yd)
{
	return sqrt(xd*xd+yd*yd);
}

int32_t ExpMgr::Fibonacci(int32_t x)
{
	int32_t n = 1,n1=0,tmp;
	if (x > 46) x = 46;		// past this it overflows 32 bits
	while (x-- > 0) {
		tmp = n1;
		n1 = n;
		n = n + tmp;
	}
	return n;
}

int32_t ExpMgr::isPrime(int32_t n)
{
	int32_t	x,l;
	if (n < 4)
		return 1;
	if (!(n & 1))
		return 0;
	x = 3;
	l = n/x;
	while (x < l) {
		if (x*l == n)
			return 0;
		x += 2;
		l = n/x;
	}
	return 1;
}

// ---------------------------------------------------------------- envelopes (from Syd)

ssfloat ExpMgr::linen(ssfloat t, ssfloat atk, ssfloat dur, ssfloat dcy)
{
	ssfloat	sdcy;
	if (t < 0 || t > dur)
		return 0.0;
	if (dcy > dur)
		dcy = dur;
	if (atk > 0 && t < atk) {
		return t/atk;
	}
	sdcy = dur-dcy;
	if (sdcy < 0)
		sdcy = 0;
	if (dcy > 0 && t >= sdcy) {
		return 1.0 - (t-sdcy)/dcy;
	}
	return 1.0;
}

ssfloat ExpMgr::linenr(ssfloat t, ssfloat atk, ssfloat dcy, ssfloat atdec)
{
	if (t < 0 || t > atk+dcy)
		return 0.0;
	if (atk > 0 && t < atk) {
		return t/atk;
	}
	t -= atk;
	return sm_pow(atdec,t/dcy);
}

ssfloat ExpMgr::limit(ssfloat v, ssfloat low, ssfloat high)
{
	if (high < low) {
		return (high-low)/2;
	}
	if (v < low)
		return low;
	if (v > high)
		return high;
	return v;
}

ssfloat ExpMgr::SphereX(ssfloat u, ssfloat v)
{
	double phi,theta;
	phi = pi * (v-0.5);
	theta = 2*pi * u;
	return sm_cos(phi)*sm_sin(theta);
}

ssfloat ExpMgr::SphereY(ssfloat u, ssfloat v)
{
	double phi,theta;
	phi = pi * (v-0.5);
	theta = 2*pi * u;
	return sm_cos(phi)*sm_cos(theta);
}

ssfloat ExpMgr::SphereZ(ssfloat u, ssfloat v)
{
	double phi;
	phi = pi * (v-0.5);
	return sm_sin(phi);
}

// ---------------------------------------------------------------- colour

void HSVtoRGB(Scalar *rgb)
{
	double	h,s,v,f,m,n,k;
	int		i;

	if (rgb->type == ST_Single)
	{
		rgb->v3 = rgb->v1;
		rgb->v2= rgb->v1;
		rgb->type = ST_Triple;
	}

	h = (360 * rgb->v1);
	s = rgb->v2;
	v = rgb->v3;

	if (s == 0.0) {
		rgb->v1 = rgb->v2 = rgb->v3 = v;
	}
	else {
		if (h >= 360.0)
			h = 0;
		else
			h /= 60.0;
		i = TruncXToLong(h);
		f = h - i;
		m = v*(1-s);
		n = v*(1-s*f);
		k = v*(1-s*(1-f));
		switch (i) {
		case 0:
			rgb->v1 = v;
			rgb->v2 = k;
			rgb->v3 = m;
			break;
		case 1:
			rgb->v1 = n;
			rgb->v2 = v;
			rgb->v3 = m;
			break;
		case 2:
			rgb->v1 = m;
			rgb->v2 = v;
			rgb->v3 = k;
			break;
		case 3:
			rgb->v1 = m;
			rgb->v2 = n;
			rgb->v3 = v;
			break;
		case 4:
			rgb->v1 = k;
			rgb->v2 = m;
			rgb->v3 = v;
			break;
		default:
			rgb->v1 = v;
			rgb->v2 = m;
			rgb->v3 = n;
			break;
		}
	}
}
