#!/bin/sh
# Disposable build preparation only; never updates the Factory pin or runs deployment commands.
set -eu
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
FACTORY="$ROOT/.swarm/factory-source"
[ "$(git -C "$FACTORY" rev-parse HEAD)" = d380dfbd4cc65466f6757c680e654a967d2749e0 ] || exit 1
[ "$(git -C "$FACTORY" rev-parse 'HEAD^{tree}')" = 6c01a39ded60161082084e7d4b50546eb36b1021 ] || exit 1
[ -z "$(git -C "$FACTORY" status --porcelain --untracked-files=no)" ] || exit 1
npm --prefix "$FACTORY/boris" ci
# Consume generated public declarations so Michel's strict compiler flags do not redefine Factory source semantics.
node "$FACTORY/boris/node_modules/typescript/bin/tsc" -p "$FACTORY/boris/tsconfig.json" \
  --declaration --emitDeclarationOnly --outDir "$ROOT/.swarm/factory-types"
