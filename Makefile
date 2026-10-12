# QTS / Pixel Magic native build: the renderer library plus the qts command.
#
# -ffp-contract=off keeps multiply-adds unfused, and src/smath is our own libm, so a frame
# has the same bits natively and in WebAssembly (build/build_wasm.sh).

CXX      ?= c++
CXXFLAGS ?= -O2
CXXFLAGS += -std=c++17 -ffp-contract=off -Isrc -Wall -Wno-unused-function
CC       ?= cc
MFLAGS   := -O2 -std=c99 -ffp-contract=off -Isrc/smath -include smath_names.h \
            -Wno-unused-but-set-variable

SRCS     := $(wildcard src/*.cpp)
MSRCS    := $(wildcard src/smath/*.c)
OBJS     := $(SRCS:src/%.cpp=obj/%.o) $(MSRCS:src/smath/%.c=obj/smath/%.o)

qts: $(OBJS) obj/cli_main.o
	$(CXX) $(CXXFLAGS) -o $@ $(OBJS) obj/cli_main.o -lm -lpthread

obj/%.o: src/%.cpp $(wildcard src/*.h) | obj
	$(CXX) $(CXXFLAGS) -c -o $@ $<

obj/cli_main.o: cli/main.cpp $(wildcard src/*.h) | obj
	$(CXX) $(CXXFLAGS) -c -o $@ $<

obj/smath/%.o: src/smath/%.c $(wildcard src/smath/*.h) | obj
	$(CC) $(MFLAGS) -c -o $@ $<

obj:
	mkdir -p obj/smath

clean:
	rm -rf obj qts

.PHONY: clean
