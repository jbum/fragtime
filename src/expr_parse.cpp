// expr_parse.cpp -- compiles a Pixel Magic expression to bytecode.
//
// A hand-written lexer and precedence-climbing parser that reproduce QTS's flex/bison
// grammar (pixexp.l / pixexp.y): the same tokens (flex's longest-match, earliest-rule
// choice is mirrored for the keyword patterns), the same precedence table
//     ?:  <  && ||  <  comparisons  <  & | xor  <  + -  <  * / %  <  unary - ~  <  ^ (right)
// and the same bytecode. Differences from the original, all on purpose:
//   - constant folding works on the syntax tree, so it never folds across a ?: branch
//     (the original's byte-stream folding could);
//   - functions with a fixed argument count are checked at compile time instead of
//     reading garbage off the stack;
//   - an unknown character is an error instead of being echoed and ignored.

#include "expr.h"
#include "qts_math.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>
#include <map>

namespace {

enum TokType {
	T_END, T_NUMBER, T_STRING, T_SEQNAME, T_VARIABLE, T_FUNCTION, T_NEWVAR, T_CHARVAR,
	T_NOISE, T_NOISE2, T_FNOISE, T_TURB, T_TERP, T_PINCH, T_EASE, T_BIAS, T_GAIN,
	T_MANDEL, T_MANDELQ, T_JULIA, T_SAMPLE, T_SAMPLEP, T_WNOISE1, T_WNOISE2,
	T_LOGICAND, T_LOGICOR, T_MOD, T_POW, T_AND, T_OR, T_XOR, T_COMPARISON, T_CHAR
};

struct Token {
	TokType     type;
	ssfloat     val;
	int         code;		// variable / operator / comparison op / char
	int         flagsToClear;
	std::string text;
	int         argc;		// FUNCTION: required argument count, -1 = any
};

struct FunctionInitRec { const char *name; int ftype; int argc; };
const FunctionInitRec kFunctionInitRec[] =
{
 {"int", OP_Integer, 1},
 {"sqrt", OP_Sqrt, 1},
 {"log", OP_Log, 1},
 {"log10", OP_Log10, 1},
 {"abs", OP_Fabs, 1},
 {"fabs", OP_Fabs, 1},
 {"sign", OP_Sign, 1},
 {"exp", OP_Exp, 1},
 {"cos", OP_Cos, 1},
 {"sin", OP_Sin, 1},
 {"tan", OP_Tan, 1},
 {"acos", OP_ACos, 1},
 {"asin", OP_ASin, 1},
 {"atan", OP_ATan, 1},
 {"cosh", OP_Cosh, 1},
 {"sinh", OP_Sinh, 1},
 {"tanh", OP_Tanh, 1},
 {"sin2", OP_Sin2, 1},
 {"cos2", OP_Cos2, 1},
 {"sin3", OP_Sin3, 1},
 {"cos3", OP_Cos3, 1},
 {"mand3", OP_Mandel3, 0},
 {"mandel3", OP_Mandel3, 0},
 {"mandc", OP_MandelCPM, 0},
 {"mandcpm", OP_MandelCPM, 0},
 {"mandelcpm", OP_MandelCPM, 0},
 {"zebra", OP_Zebra, 4},
 {"dragon", OP_Dragon, 0},
 {"fbm", OP_FBM, 6},
 {"fbmt", OP_FBMT, 6},
 {"fib", OP_Fib, 1},
 {"prime", OP_Prime, 1},
 {"angle", OP_Angle, 2},
 {"linen", OP_linen, 4},
 {"linenr", OP_linenr, 4},
 {"limit", OP_limit, 3},
 {"mod", OP_Modulo, 2},
 {"xor", OP_Xor, 2},
 {"and", OP_And, 2},
 {"or", OP_Or, 2},
 {"not", OP_Not, 1},
 {"pow2", OP_Power2, 1},
 {"pow", OP_Power, 2},
 {"red", OP_Red, 2},
 {"green", OP_Green, 2},
 {"grn", OP_Green, 2},
 {"blue", OP_Blue, 2},
 {"blu", OP_Blue, 2},
 {"distance", OP_Dist, 2},
 {"dist", OP_Dist, 2},
 {"rgb", OP_RGB, 3},
 {"hsv", OP_HSV, 3},
 {"triple", OP_Triple, 3},
 {"min", OP_Min, 2},
 {"max", OP_Max, 2},
 {"clamp", OP_Clamp, 3},
 {NULL, OP_None, 0},
};

struct VarInitRec { const char *name; int vType; int compileFlagsToClear; };
const VarInitRec kVarInitRec[] =
{
	{"t",	V_Time,	EF_IsConstant | EF_NoTime},
	{"gt",	V_GlobalTime,	EF_IsConstant | EF_NoTime},
	{"x",	V_X,		EF_IsConstant | EF_NoTime},
	{"y",	V_Y,		EF_IsConstant | EF_NoTime},
	{"w",	V_W,		EF_IsConstant | EF_NoTime},
	{"h",	V_H,		EF_IsConstant | EF_NoTime},
	{"a",	V_A,		EF_IsConstant | EF_NoTime},
	{"d",	V_D,		EF_IsConstant | EF_NoTime},
	{"i",	V_I,		EF_IsConstant | EF_NoTime},
	{"n",	V_FrameNbr,		EF_IsConstant | EF_NoTime},
	{"gn",	V_GlobalFrameNbr,		EF_IsConstant | EF_NoTime},
	{"fw",	V_FW,		EF_IsConstant | EF_NoTime},
	{"fh",	V_FH,		EF_IsConstant | EF_NoTime},
	{"jx",	V_JX,		EF_NoTime},
	{"jy",	V_JY,		EF_NoTime},
	{"p0",	V_JX,		EF_NoTime},
	{"q0",	V_JY,		EF_NoTime},
	{"px",	V_PX,		EF_IsConstant | EF_NoTime},
	{"py",	V_PY,		EF_IsConstant | EF_NoTime},
	{"pw",	V_PW,		EF_IsConstant | EF_NoTime},
	{"ph",	V_PH,		EF_IsConstant | EF_NoTime},
	{"cx",	V_CX,		EF_IsConstant | EF_NoTime},
	{"cy",	V_CY,		EF_IsConstant | EF_NoTime},
	{"sx",	V_SX,		EF_IsConstant | EF_NoTime},
	{"sy",	V_SY,		EF_IsConstant | EF_NoTime},
	{"sz",	V_SZ,		EF_IsConstant | EF_NoTime},
	{"iw", V_IW,		EF_IsConstant | EF_NoTime},
	{"ih", V_IH,		EF_IsConstant | EF_NoTime},
	{"left",	V_Left,		EF_IsConstant | EF_NoTime},
	{"top",	V_Top,		EF_IsConstant | EF_NoTime},
	{"zoom",	V_ZoomFac,	EF_IsConstant | EF_NoTime},
	{"z",		V_ZoomFac,	EF_IsConstant | EF_NoTime},
	{"recur",    V_Recurse, EF_IsConstant | EF_NoTime},
	{"recurse",  V_Recurse, EF_IsConstant | EF_NoTime},
	{"dur",      V_Duration, EF_IsConstant | EF_NoTime},
	{"duration", V_Duration, EF_IsConstant | EF_NoTime},
	{"maxval",   V_MaxVal, EF_IsConstant | EF_NoTime},
	{"maxv",     V_MaxVal, EF_IsConstant | EF_NoTime},
	{"minval",   V_MinVal, EF_IsConstant | EF_NoTime},
	{"minv",     V_MinVal, EF_IsConstant | EF_NoTime},
	{NULL, V_None, 0}
};

bool ieq(const std::string &a, const char *b)
{
	size_t n = strlen(b);
	if (a.size() != n) return false;
	for (size_t i = 0; i < n; ++i)
		if (tolower((unsigned char) a[i]) != tolower((unsigned char) b[i])) return false;
	return true;
}

// Does the whole word match one of the alternatives (case-insensitive)?
bool matchAny(const std::string &w, const char *const *alts)
{
	for (; *alts; ++alts) if (ieq(w, *alts)) return true;
	return false;
}

const char *const kNoiseWords[]   = {"noise", "gnoise", "noise3d", "gnoise3d", NULL};
const char *const kTurbWords[]    = {"turb", "gturb", "turbulence", "gturbulence", "turb3d", "gturb3d",
                                     "turbulence3d", "gturbulence3d", NULL};
const char *const kNoise2Words[]  = {"noise2", "gnoise2", NULL};
const char *const kFNoiseWords[]  = {"fnoise", "fnoise3d", NULL};
const char *const kSamplePWords[] = {"sampp", "samplep", NULL};
const char *const kSampleWords[]  = {"samp", "sample", "samptile", "sampletile", NULL};
const char *const kTerpWords[]    = {"terp", "terpt", "interpolate", NULL};
const char *const kMandelQWords[] = {"mandq", "mandelq", NULL};
const char *const kMandelWords[]  = {"mand", "mandel", "mandelbrot", NULL};

// ---------------------------------------------------------------- syntax tree

enum NodeKind { N_Number, N_Var, N_Random, N_Op, N_Seq, N_Cond, N_CharVar };

struct Node {
	NodeKind kind;
	int      code;		// N_Var: variable; N_Op: operator; N_Seq: OP_SampSeq*; N_CharVar: V_R..
	ssfloat  num;		// N_Number
	int      seqID;		// N_Seq
	std::vector<Node *> kids;
	Node(NodeKind k, int c = 0) : kind(k), code(c), num(0), seqID(0) {}
};

struct ParseError { std::string msg; };

class Parser {
	const std::string &src;
	size_t pos;
	Token  tok;
	std::vector<std::unique_ptr<Node>> pool;
	int    flags;
	std::map<std::string, int> &seqNames;

	Node *mk(NodeKind k, int c = 0) { pool.emplace_back(new Node(k, c)); return pool.back().get(); }

	[[noreturn]] void fail(const std::string &m) { throw ParseError{m}; }

	bool isIdentStart(char c) { return isalpha((unsigned char) c); }
	bool isIdentChar(char c)  { return isalnum((unsigned char) c) || c == '_'; }

	void lex()
	{
		while (pos < src.size() && (src[pos] == ' ' || src[pos] == '\t' || src[pos] == '\n' || src[pos] == '\r'))
			++pos;
		tok.text.clear();
		tok.argc = -1;
		if (pos >= src.size()) { tok.type = T_END; return; }
		char c = src[pos];

		// numbers: [0-9]+ | ([0-9]+)?\.[0-9]+   (no exponent form, no sign)
		if (isdigit((unsigned char) c) || (c == '.' && pos + 1 < src.size() && isdigit((unsigned char) src[pos+1]))) {
			size_t s = pos;
			while (pos < src.size() && isdigit((unsigned char) src[pos])) ++pos;
			if (pos < src.size() && src[pos] == '.' && pos + 1 < src.size() && isdigit((unsigned char) src[pos+1])) {
				++pos;
				while (pos < src.size() && isdigit((unsigned char) src[pos])) ++pos;
			}
			tok.type = T_NUMBER;
			tok.val = atof(src.substr(s, pos - s).c_str());
			return;
		}
		if (c == '"') {
			size_t e = src.find('"', pos + 1);
			if (e == std::string::npos || src.find('\n', pos) < e) fail("Unterminated string");
			tok.type = T_STRING;
			tok.text = src.substr(pos, e + 1 - pos);
			pos = e + 1;
			return;
		}
		if (c == '$') {
			size_t s = ++pos;
			if (pos >= src.size() || !isIdentStart(src[pos])) fail("Bad sequence reference");
			while (pos < src.size() && isIdentChar(src[pos])) ++pos;
			tok.type = T_SEQNAME;
			tok.text = src.substr(s, pos - s);
			return;
		}
		if (isIdentStart(c)) {
			size_t s = pos;
			while (pos < src.size() && isIdentChar(src[pos])) ++pos;
			std::string w = src.substr(s, pos - s);
			tok.text = w;
			// keyword rules, in pixexp.l order (all the same length as the word, so the
			// earliest rule wins)
			if (ieq(w, "pi"))  { tok.type = T_NUMBER; tok.val = pi; return; }
			if (ieq(w, "pi2")) { tok.type = T_NUMBER; tok.val = pi*2; return; }
			if (ieq(w, "e"))   { tok.type = T_NUMBER; tok.val = sm_exp(1); return; }
			if (ieq(w, "wnoise1")) { tok.type = T_WNOISE1; return; }
			if (ieq(w, "wnoise2")) { tok.type = T_WNOISE2; return; }
			if (matchAny(w, kNoiseWords))   { tok.type = T_NOISE; return; }
			if (matchAny(w, kTurbWords))    { tok.type = T_TURB; return; }
			if (matchAny(w, kNoise2Words))  { tok.type = T_NOISE2; return; }
			if (matchAny(w, kFNoiseWords))  { tok.type = T_FNOISE; return; }
			if (matchAny(w, kSamplePWords)) { tok.type = T_SAMPLEP; return; }
			if (matchAny(w, kSampleWords))  { tok.type = T_SAMPLE; return; }
			if (matchAny(w, kTerpWords))    { tok.type = T_TERP; return; }
			if (ieq(w, "pinch")) { tok.type = T_PINCH; return; }
			if (ieq(w, "ease"))  { tok.type = T_EASE; return; }
			if (ieq(w, "bias"))  { tok.type = T_BIAS; return; }
			if (ieq(w, "gain"))  { tok.type = T_GAIN; return; }
			if (matchAny(w, kMandelQWords)) { tok.type = T_MANDELQ; return; }
			if (matchAny(w, kMandelWords))  { tok.type = T_MANDEL; return; }
			if (ieq(w, "julia")) { tok.type = T_JULIA; return; }
			if (w.size() == 1 && strchr("rgbcsl", tolower((unsigned char) w[0]))) {
				tok.type = T_CHARVAR; tok.code = tolower((unsigned char) w[0]); return;
			}
			if (ieq(w, "and")) { tok.type = T_LOGICAND; return; }
			if (ieq(w, "or"))  { tok.type = T_LOGICOR; return; }
			if (ieq(w, "mod")) { tok.type = T_MOD; return; }
			if (ieq(w, "xor")) { tok.type = T_XOR; return; }
			for (const VarInitRec *vp = kVarInitRec; vp->name; ++vp)
				if (ieq(w, vp->name)) {
					tok.type = T_VARIABLE; tok.code = vp->vType; tok.flagsToClear = vp->compileFlagsToClear;
					return;
				}
			for (const FunctionInitRec *fp = kFunctionInitRec; fp->name; ++fp)
				if (ieq(w, fp->name)) {
					tok.type = T_FUNCTION; tok.code = fp->ftype; tok.argc = fp->argc;
					return;
				}
			tok.type = T_NEWVAR;
			return;
		}
		// operators
		auto two = [&](const char *s) { return src.compare(pos, 2, s) == 0; };
		if (two("&&")) { pos += 2; tok.type = T_LOGICAND; return; }
		if (two("||")) { pos += 2; tok.type = T_LOGICOR; return; }
		if (two("**")) { pos += 2; tok.type = T_POW; return; }
		if (two("==")) { pos += 2; tok.type = T_COMPARISON; tok.code = OP_Equal; return; }
		if (two("!=") || two("<>")) { pos += 2; tok.type = T_COMPARISON; tok.code = OP_Neq; return; }
		if (two("<=")) { pos += 2; tok.type = T_COMPARISON; tok.code = OP_Lse; return; }
		if (two(">=")) { pos += 2; tok.type = T_COMPARISON; tok.code = OP_Gte; return; }
		++pos;
		switch (c) {
		case '%': tok.type = T_MOD; return;
		case '^': tok.type = T_POW; return;
		case '&': tok.type = T_AND; return;
		case '|': tok.type = T_OR; return;
		case '=': tok.type = T_COMPARISON; tok.code = OP_Equal; return;
		case '<': tok.type = T_COMPARISON; tok.code = OP_Less; return;
		case '>': tok.type = T_COMPARISON; tok.code = OP_Greater; return;
		case '(': case ')': case ',': case '+': case '-': case '*': case '/': case '!':
		case '[': case ']': case '~': case '?': case ':': case '{': case '}':
			tok.type = T_CHAR; tok.code = c; return;
		}
		char msg[64];
		snprintf(msg, sizeof msg, "Unexpected character: %c", c);
		fail(msg);
	}

	bool isChar(int c) { return tok.type == T_CHAR && tok.code == c; }
	void expect(int c)
	{
		if (!isChar(c)) {
			char msg[64];
			snprintf(msg, sizeof msg, "parse error: expected '%c'", c);
			fail(msg);
		}
		lex();
	}

	// -------------------------------------------------------------- grammar

	// statement: ternary (lowest precedence, left-associative as in the yacc grammar)
	Node *parseStatement()
	{
		Node *e = parseLogic();
		while (isChar('?')) {
			lex();
			Node *a = parseStatement();		// the then-branch may itself be a conditional
			expect(':');
			Node *b = parseLogic();
			Node *c = mk(N_Cond);
			c->kids = {e, a, b};
			e = c;
		}
		return e;
	}

	Node *binop(int op, Node *a, Node *b) { Node *n = mk(N_Op, op); n->kids = {a, b}; return n; }

	Node *parseLogic()
	{
		Node *e = parseCompare();
		for (;;) {
			if (tok.type == T_LOGICAND) { lex(); e = binop(OP_LogicAnd, e, parseCompare()); }
			else if (tok.type == T_LOGICOR) { lex(); e = binop(OP_LogicOr, e, parseCompare()); }
			else return e;
		}
	}

	Node *parseCompare()
	{
		Node *e = parseBitwise();
		while (tok.type == T_COMPARISON) {
			int op = tok.code; lex();
			e = binop(op, e, parseBitwise());
		}
		return e;
	}

	Node *parseBitwise()
	{
		Node *e = parseAdd();
		for (;;) {
			if (tok.type == T_AND) { lex(); e = binop(OP_And, e, parseAdd()); }
			else if (tok.type == T_OR) { lex(); e = binop(OP_Or, e, parseAdd()); }
			else if (tok.type == T_XOR) { lex(); e = binop(OP_Xor, e, parseAdd()); }
			else return e;
		}
	}

	Node *parseAdd()
	{
		Node *e = parseMul();
		for (;;) {
			if (isChar('+')) { lex(); e = binop(OP_Add, e, parseMul()); }
			else if (isChar('-')) { lex(); e = binop(OP_Subtract, e, parseMul()); }
			else return e;
		}
	}

	Node *parseMul()
	{
		Node *e = parseUnary();
		for (;;) {
			if (isChar('*')) { lex(); e = binop(OP_Multiply, e, parseUnary()); }
			else if (isChar('/')) { lex(); e = binop(OP_Divide, e, parseUnary()); }
			else if (tok.type == T_MOD) { lex(); e = binop(OP_Modulo, e, parseUnary()); }
			else return e;
		}
	}

	Node *parseUnary()
	{
		if (isChar('-')) { lex(); Node *n = mk(N_Op, OP_Negate); n->kids = {parseUnary()}; return n; }
		if (isChar('~')) { lex(); Node *n = mk(N_Op, OP_Invert); n->kids = {parseUnary()}; return n; }
		return parsePow();
	}

	Node *parsePow()
	{
		Node *e = parsePrimary();
		if (tok.type == T_POW) {
			lex();
			return binop(OP_Power, e, parseUnary());		// right-associative, binds a unary minus
		}
		return e;
	}

	// '(' args ')' -> argument list (possibly empty)
	std::vector<Node *> parseArgs()
	{
		std::vector<Node *> args;
		expect('(');
		if (isChar(')')) { lex(); return args; }
		args.push_back(parseStatement());
		while (isChar(',')) { lex(); args.push_back(parseStatement()); }
		expect(')');
		return args;
	}

	Node *op(int code, std::vector<Node *> kids) { Node *n = mk(N_Op, code); n->kids = kids; return n; }
	Node *number(ssfloat v) { Node *n = mk(N_Number); n->num = v; return n; }
	Node *timeVar() { flags &= ~(EF_IsConstant | EF_NoTime); return mk(N_Var, V_Time); }

	[[noreturn]] void badArgs(const char *name) { fail(std::string("Wrong number of arguments: ") + name); }

	Node *parsePrimary()
	{
		Token t = tok;
		switch (t.type) {
		case T_NUMBER:
			lex();
			return number(t.val);
		case T_STRING:
			fail("Unexpected string: " + t.text);
		case T_NEWVAR:
			fail("Unexpected symbol: " + t.text);
		case T_SEQNAME: {
			lex();
			int id;
			{
				auto it = seqNames.find(t.text);
				if (it == seqNames.end()) { id = (int) seqNames.size() + 1; seqNames[t.text] = id; }
				else id = it->second;
			}
			Node *n = mk(N_Seq);
			n->seqID = id;
			flags &= ~(EF_IsConstant | EF_NoTime);
			if (isChar('[')) {
				lex();
				std::vector<Node *> args;
				args.push_back(parseStatement());
				while (isChar(',')) { lex(); args.push_back(parseStatement()); }
				expect(']');
				n->kids = args;
				if (args.size() == 1) n->code = OP_SampSeqT;
				else if (args.size() == 2) n->code = OP_SampSeqXY;
				else if (args.size() == 3) n->code = OP_SampSeqXYT;
				else fail("Bad sequence reference: $" + t.text);
			}
			else if (isChar('{')) {
				lex();
				Node *d = parseStatement();
				expect(',');
				Node *a = parseStatement();
				expect('}');
				n->kids = {d, a};
				n->code = OP_SampSeqDA;
			}
			else
				n->code = OP_SampSeq;
			return n;
		}
		case T_SAMPLE: {
			lex();
			std::vector<Node *> a = parseArgs();
			flags &= ~(EF_IsConstant | EF_NoTime);
			if (a.empty()) return op(OP_SampleN, {});
			if (a.size() == 2) return op(OP_SampleN_2, a);
			badArgs("sample");
		}
		case T_SAMPLEP: {
			lex();
			std::vector<Node *> a = parseArgs();
			flags &= ~(EF_IsConstant | EF_NoTime);
			if (a.empty()) return op(OP_SampleP, {});
			if (a.size() == 2) return op(OP_SampleP_2, a);
			badArgs("samplep");
		}
		case T_NOISE: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.empty()) { flags &= ~(EF_IsConstant | EF_NoTime); return op(OP_FastNoise2, {}); }
			if (a.size() == 2) return op(OP_Noise, a);
			if (a.size() == 3) return op(OP_Noise3D, a);
			if (a.size() == 6) return op(OP_FBM, a);
			badArgs("noise");
		}
		case T_NOISE2: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.size() == 2) { a.push_back(number(2.0)); return op(OP_Noise2, a); }
			if (a.size() == 3) return op(OP_Noise2, a);
			badArgs("noise2");
		}
		case T_WNOISE1: case T_WNOISE2: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (!a.empty()) badArgs("wnoise");
			flags |= EF_HasWorley2;
			flags &= ~(EF_IsConstant | EF_NoTime);
			return op(t.type == T_WNOISE1 ? OP_WNoise1 : OP_WNoise2, {});
		}
		case T_FNOISE: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.empty()) { flags &= ~(EF_IsConstant | EF_NoTime); return op(OP_FastFNoise2, {}); }
			if (a.size() == 2) return op(OP_FNoise, a);
			if (a.size() == 3) return op(OP_FNoise3D, a);
			if (a.size() == 6) return op(OP_FBM, a);
			badArgs("fnoise");
		}
		case T_TURB: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.empty()) { flags &= ~(EF_IsConstant | EF_NoTime); return op(OP_FastTurb2, {}); }
			if (a.size() == 2) return op(OP_Turb, a);
			if (a.size() == 3) return op(OP_Turb3D, a);
			if (a.size() == 6) return op(OP_FBMT, a);
			badArgs("turb");
		}
		case T_TERP: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.size() == 2) { flags &= ~(EF_IsConstant | EF_NoTime); return op(OP_terp, a); }
			if (a.size() == 3) return op(OP_terpt, a);
			badArgs("terp");
		}
		case T_PINCH: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.size() == 1) return op(OP_pinch, a);
			if (a.size() == 2) return op(OP_pinch2, a);
			badArgs("pinch");
		}
		case T_EASE: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.empty()) return op(OP_ease, {timeVar()});
			if (a.size() == 1) return op(OP_ease, a);
			if (a.size() == 2) return op(OP_gain, a);
			badArgs("ease");
		}
		case T_BIAS: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.size() == 1) { flags &= ~(EF_IsConstant | EF_NoTime); return op(OP_biast, a); }
			if (a.size() == 2) return op(OP_bias, a);
			badArgs("bias");
		}
		case T_GAIN: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (a.size() == 1) { flags &= ~(EF_IsConstant | EF_NoTime); return op(OP_gaint, a); }
			if (a.size() == 2) return op(OP_gain, a);
			badArgs("gain");
		}
		case T_MANDEL: {
			lex();
			std::vector<Node *> a = parseArgs();
			flags &= ~(EF_IsConstant | EF_NoTime);
			if (a.empty()) { flags |= EF_HasMandel; return op(OP_MandelFast, {}); }
			if (a.size() == 2) return op(OP_Mandel2, a);
			badArgs("mandel");
		}
		case T_MANDELQ: {
			lex();
			std::vector<Node *> a = parseArgs();
			flags &= ~(EF_IsConstant | EF_NoTime);
			if (a.empty()) { flags |= EF_HasMandelQ; return op(OP_MandelQFast, {}); }
			if (a.size() == 2) return op(OP_MandelQ2, a);
			badArgs("mandelq");
		}
		case T_JULIA: {
			lex();
			std::vector<Node *> a = parseArgs();
			flags &= ~(EF_IsConstant | EF_NoTime);
			if (a.empty()) { flags |= EF_HasJulia; return op(OP_JuliaFast, {}); }
			if (a.size() == 2) return op(OP_Julia2, a);
			if (a.size() == 4) return op(OP_Julia4, a);
			badArgs("julia");
		}
		case T_VARIABLE: {
			lex();
			if (isChar('(')) fail("Unknown function: " + t.text);
			flags &= ~t.flagsToClear;
			return mk(N_Var, t.code);
		}
		case T_FUNCTION: {
			lex();
			std::vector<Node *> a = parseArgs();
			if (t.argc >= 0 && (int) a.size() != t.argc) badArgs(t.text.c_str());
			switch (t.code) {
			case OP_Lum: case OP_Color: case OP_Saturation:
				fail("Not implemented: " + t.text);
			case OP_Mandel3: case OP_MandelCPM: case OP_Dragon:
			case OP_Red: case OP_Green: case OP_Blue:
				flags &= ~(EF_IsConstant | EF_NoTime);
				break;
			}
			return op(t.code, a);
		}
		case T_CHARVAR: {
			lex();
			flags &= ~(EF_IsConstant | EF_NoTime);
			int c = t.code;
			if (isChar('[')) {
				lex();
				Node *x = parseStatement();
				expect(',');
				Node *y = parseStatement();
				expect(']');
				int o = c == 'r' ? OP_Red : c == 'g' ? OP_Green : c == 'b' ? OP_Blue :
				        c == 'c' ? OP_Color : c == 's' ? OP_Saturation : OP_Lum;
				if (o == OP_Color || o == OP_Saturation || o == OP_Lum)
					fail(std::string("Not implemented: ") + (char) c + "[x,y]");
				return op(o, {x, y});
			}
			int v = c == 'r' ? V_R : c == 'g' ? V_G : c == 'b' ? V_B : c == 'c' ? V_C : c == 's' ? V_S : V_L;
			return mk(N_CharVar, v);
		}
		case T_CHAR:
			if (t.code == '?') {
				lex();
				flags &= ~(EF_IsConstant | EF_NoTime);
				return mk(N_Random);
			}
			if (t.code == '(') {
				lex();
				if (isChar(')')) fail("parse error: empty parentheses");
				Node *e = parseStatement();
				expect(')');
				return e;
			}
			break;
		default:
			break;
		}
		fail("parse error");
	}

	// ------------------------------------------------------------ code generation

	static bool isPure(int code)
	{
		switch (code) {
		case OP_Add: case OP_Subtract: case OP_Negate: case OP_Multiply: case OP_Divide:
		case OP_Modulo: case OP_Power: case OP_Power2: case OP_Integer:
		case OP_And: case OP_Or: case OP_Xor: case OP_Invert:
		case OP_Equal: case OP_Neq: case OP_Greater: case OP_Gte: case OP_Less: case OP_Lse: case OP_Not:
		case OP_LogicAnd: case OP_LogicOr: case OP_Angle: case OP_Dist:
		case OP_Sqrt: case OP_Log: case OP_Log10: case OP_Fabs: case OP_Sign: case OP_Exp:
		case OP_Cos: case OP_Sin: case OP_Sin2: case OP_Cos2: case OP_Sin3: case OP_Cos3:
		case OP_Tan: case OP_ACos: case OP_ASin: case OP_ATan: case OP_Cosh: case OP_Sinh: case OP_Tanh:
		case OP_Min: case OP_Max: case OP_Clamp: case OP_limit:
			return true;
		}
		return false;
	}

	void emit(Node *n, std::vector<Instr> &out, ExpMgr &mgr)
	{
		Instr ins = {0, 0, 0, 0};
		switch (n->kind) {
		case N_Number:
			ins.kind = 'V'; ins.code = V_Number; ins.num = n->num;
			out.push_back(ins);
			return;
		case N_Var:
		case N_CharVar:
			ins.kind = 'V'; ins.code = n->code;
			out.push_back(ins);
			return;
		case N_Random:
			ins.kind = 'V'; ins.code = V_RANDOM;
			out.push_back(ins);
			return;
		case N_Op: {
			bool allConst = isPure(n->code) && !n->kids.empty();
			for (Node *k : n->kids) if (k->kind != N_Number) allConst = false;
			if (allConst) {
				// fold: run the operator on its constant arguments now
				ExpRec tmp;
				for (Node *k : n->kids) {
					Instr c = {'V', V_Number, 0, k->num};
					tmp.code.push_back(c);
				}
				Instr o = {'O', n->code, 0, 0};
				tmp.code.push_back(o);
				ExpVars dummy;
				ins.kind = 'V'; ins.code = V_Number; ins.num = mgr.EvalF(tmp, &dummy);
				out.push_back(ins);
				return;
			}
			for (Node *k : n->kids) emit(k, out, mgr);
			ins.kind = 'O'; ins.code = n->code;
			out.push_back(ins);
			return;
		}
		case N_Seq: {
			for (Node *k : n->kids) emit(k, out, mgr);
			ins.kind = 'V'; ins.code = V_Number; ins.num = n->seqID;
			out.push_back(ins);
			Instr o = {'O', n->code, 0, 0};
			out.push_back(o);
			return;
		}
		case N_Cond: {
			emit(n->kids[0], out, mgr);
			size_t condAt = out.size();
			Instr c = {'X', X_Cond, 0, 0};
			out.push_back(c);
			emit(n->kids[1], out, mgr);
			size_t jumpAt = out.size();
			Instr j = {'X', X_Jump, 0, 0};
			out.push_back(j);
			out[condAt].target = (int) out.size();
			emit(n->kids[2], out, mgr);
			out[jumpAt].target = (int) out.size();
			return;
		}
		}
	}

public:
	Parser(const std::string &s, std::map<std::string, int> &names)
		: src(s), pos(0), flags(EF_IsConstant | EF_NoParams | EF_NoTime), seqNames(names) {}

	int compile(ExpRec &rec, ExpMgr &mgr, std::string &err)
	{
		rec.code.clear();
		try {
			lex();
			if (tok.type == T_END) { rec.cFlags = flags; return 0; }	// empty: evaluates to 0
			Node *root = parseStatement();
			// QTS let a stray ')' at the end pass (its parser had already emitted the
			// code by then), and several of the sample scripts have one
			while (isChar(')')) lex();
			if (tok.type != T_END) fail("parse error");
			emit(root, rec.code, mgr);
			rec.cFlags = flags;
			return 0;
		}
		catch (ParseError &e) {
			err = e.msg;
			rec.code.clear();
			rec.cFlags = 0;
			return 1;
		}
	}
};

} // namespace

int ExpMgr::CompileExp(ExpRec &exp, std::string &err)
{
	Parser p(exp.exp, seqNames);
	return p.compile(exp, *this, err);
}

int ExpMgr::NameToSequenceID(const std::string &name)
{
	auto it = seqNames.find(name);
	if (it != seqNames.end()) return it->second;
	int id = (int) seqNames.size() + 1;
	seqNames[name] = id;
	return id;
}
