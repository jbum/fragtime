// qts_math.h -- the math every platform must agree on.
//
// pow, sin, log and friends come from src/smath (musl's libm, compiled in) so a frame
// renders the same bits natively and in WebAssembly. sqrt, floor and fabs are exact by
// IEEE 754 and come from <math.h>.

#ifndef QTS_MATH_H
#define QTS_MATH_H

#include <math.h>
#include <stdint.h>
#include "smath/smath.h"

#ifndef HUGE_VAL
#define HUGE_VAL (1.0/0.0)
#endif

#define FLOOR(x) ((int)(x) - ((x) < 0 && (x) != (int)(x)))
#define LERP(t,x0,x1)  ((x0) + (t)*((x1)-(x0)))
#define EASE(x)        ((x)*(x)*(3 - 2*(x)))

#endif
