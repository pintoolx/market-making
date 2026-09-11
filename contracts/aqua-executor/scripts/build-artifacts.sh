#!/usr/bin/env bash
# Reproducibly builds deployable artifacts for the canonical 1inch Aqua + SwapVM contracts
# (official, unmodified sources) plus a testnet MockERC20.
#
#   AquaRouter        1inch/aqua    @ 9c5c42e5840e8741fba3597c48456c9510212b66
#                     (same src/ as the Blockscout-verified 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a)
#   AquaSwapVMRouter  1inch/swap-vm @ v1.0.2 (commit 32c687c2b73101fc26549e48fa1ff8a4d73afbac)
#                     (Blockscout-verified 0x111111338c5091E8440b67B168bAe16a668AC0De)
#   MockERC20         ./contracts/MockERC20.sol (OpenZeppelin 5.4.0)
#
# Env:
#   FORGE  forge binary (default: forge)
#   SOLC   optional path to a solc 0.8.30 binary; passed to forge via --use (else forge auto-installs 0.8.30)
#   YARN   yarn v1 command (default: "npx -y yarn@1.22.22")
#
# Writes: artifacts/{AquaRouter,AquaSwapVMRouter,MockERC20}.json
# Scratch: .cache/ (clones, node_modules, forge out/) -- gitignore it.
set -euo pipefail

START=$SECONDS
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.cache"
SRC="$CACHE/src"
ART="$ROOT/artifacts"
FORGE="${FORGE:-forge}"
SOLC="${SOLC:-}"
YARN="${YARN:-npx -y yarn@1.22.22}"
: "${YARN_CACHE_FOLDER:=$CACHE/yarn-cache}"
: "${npm_config_cache:=$CACHE/npm-cache}"
export YARN_CACHE_FOLDER npm_config_cache

AQUA_REPO="https://github.com/1inch/aqua"
AQUA_COMMIT="9c5c42e5840e8741fba3597c48456c9510212b66"
SWAPVM_REPO="https://github.com/1inch/swap-vm"
SWAPVM_TAG="v1.0.2"
SWAPVM_COMMIT="32c687c2b73101fc26549e48fa1ff8a4d73afbac"

# Canonical-bytecode compiler settings (from each repo's foundry.toml + verified metadata).
EVM_VERSION="prague"
# Remappings must be exactly the set used for the canonical (Blockscout "fully verified") builds,
# otherwise only the CBOR metadata hash differs. Newer forge auto-detects extra scope remappings
# ("@1inch/=", "@openzeppelin/="), so auto-detection is disabled and the set is given explicitly:
# each repo's remappings.txt + these two (which older forge auto-detected from node_modules).
EXTRA_REMAPPINGS=(--remappings "hardhat-deploy/=node_modules/hardhat-deploy/" --remappings "hardhat/=node_modules/hardhat/")

log() { printf '\n==> %s\n' "$*"; }

SOLC_ARGS=()
if [[ -n "$SOLC" ]]; then SOLC_ARGS=(--use "$SOLC"); fi

mkdir -p "$SRC" "$ART"

# --- 1. sources -------------------------------------------------------------
fetch_commit() { # dir repo commit [ref]
  local dir="$1" repo="$2" commit="$3" ref="${4:-$3}"
  if [[ ! -d "$dir/.git" ]]; then
    log "clone $repo @ $ref"
    rm -rf "$dir"
    git init -q "$dir"
    git -C "$dir" remote add origin "$repo"
    git -C "$dir" fetch -q --depth 1 origin "$ref"
    git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  local head
  head="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$head" != "$commit" ]]; then
    echo "ERROR: $dir is at $head, expected $commit (delete it and re-run)" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]]; then
    echo "ERROR: $dir has modified tracked files; sources must be unmodified" >&2
    exit 1
  fi
}

fetch_commit "$SRC/aqua" "$AQUA_REPO" "$AQUA_COMMIT"
fetch_commit "$SRC/swap-vm" "$SWAPVM_REPO" "$SWAPVM_COMMIT" "refs/tags/$SWAPVM_TAG"

# --- 2. dependencies (yarn v1 lockfiles, nodeLinker: node-modules) ---------
install_deps() { # dir
  local dir="$1"
  if [[ ! -f "$dir/node_modules/.yarn-integrity" ]]; then
    log "yarn install in $dir"
    (cd "$dir" && $YARN install --frozen-lockfile --ignore-scripts --non-interactive --no-progress)
  fi
}

pkg_version() { node -p "require('$1/package.json').version"; }
expect_version() { # pkgdir expected
  local got
  got="$(pkg_version "$1")"
  if [[ "$got" != "$2" ]]; then echo "ERROR: $1 is $got, expected $2" >&2; exit 1; fi
}

install_deps "$SRC/aqua"
install_deps "$SRC/swap-vm"
expect_version "$SRC/aqua/node_modules/@openzeppelin/contracts" 5.4.0
expect_version "$SRC/aqua/node_modules/@1inch/solidity-utils" 6.9.7
expect_version "$SRC/swap-vm/node_modules/@openzeppelin/contracts" 5.4.0
expect_version "$SRC/swap-vm/node_modules/@1inch/solidity-utils" 6.9.7
expect_version "$SRC/swap-vm/node_modules/@1inch/aqua" 0.1.0

# --- 3. compile -------------------------------------------------------------
# Only the target file (and its imports) is handed to solc, which is the same input set as the
# Blockscout verification. Optimizer/viaIR settings come from each repo's own foundry.toml:
#   aqua:    solc 0.8.30, optimizer 10_000_000 runs, via_ir
#   swap-vm: solc 0.8.30, optimizer 700 runs, via_ir, custom yulDetails.optimizerSteps
log "forge build AquaRouter"
FOUNDRY_AUTO_DETECT_REMAPPINGS=false \
  "$FORGE" build --root "$SRC/aqua" "${SOLC_ARGS[@]}" --evm-version "$EVM_VERSION" "${EXTRA_REMAPPINGS[@]}" \
  "$SRC/aqua/src/AquaRouter.sol"

log "forge build AquaSwapVMRouter"
FOUNDRY_AUTO_DETECT_REMAPPINGS=false \
  "$FORGE" build --root "$SRC/swap-vm" "${SOLC_ARGS[@]}" --evm-version "$EVM_VERSION" "${EXTRA_REMAPPINGS[@]}" \
  "$SRC/swap-vm/src/routers/AquaSwapVMRouter.sol"

log "forge build MockERC20"
MOCK="$CACHE/build/mock"
mkdir -p "$MOCK"
ln -sfn "$ROOT/contracts" "$MOCK/src"
ln -sfn "$SRC/aqua/node_modules/@openzeppelin/contracts" "$MOCK/oz"
cat > "$MOCK/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "out"
libs = []
auto_detect_remappings = false
remappings = ["@openzeppelin/contracts/=oz/"]
solc = "0.8.30"
optimizer = true
optimizer_runs = 200
via_ir = false
evm_version = "prague"
TOML
"$FORGE" build --root "$MOCK" "${SOLC_ARGS[@]}" "$MOCK/src/MockERC20.sol"

# --- 4. artifacts -----------------------------------------------------------
emit() { # forgeJson outJson contractName repo commit
  node -e '
    const fs = require("fs");
    const [inp, out, name, repo, commit] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(inp, "utf8"));
    const md = typeof j.metadata === "string" ? JSON.parse(j.metadata) : j.metadata;
    const s = md.settings;
    const bytecode = j.bytecode.object.startsWith("0x") ? j.bytecode.object : "0x" + j.bytecode.object;
    if (bytecode.length <= 2) throw new Error("empty bytecode for " + name);
    const compiler = {
      solc: md.compiler.version,
      // solc metadata omits "enabled" when optimizer.details is given (details fully specify it)
      optimizer: { enabled: s.optimizer.enabled ?? !!s.optimizer.details, runs: s.optimizer.runs },
      viaIR: !!s.viaIR,
      evmVersion: s.evmVersion,
    };
    if (s.optimizer.details) compiler.optimizer.details = s.optimizer.details;
    const a = { contractName: name, abi: j.abi, bytecode };
    if (repo) a.source = { repo, commit };
    a.compiler = compiler;
    fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
    console.log(`${name}: ${(bytecode.length - 2) / 2} bytes creation code, solc ${compiler.solc}, runs ${compiler.optimizer.runs}, viaIR ${compiler.viaIR}, ${compiler.evmVersion} -> ${out}`);
  ' "$@"
}

log "write artifacts"
emit "$SRC/aqua/out/AquaRouter.sol/AquaRouter.json" "$ART/AquaRouter.json" \
  AquaRouter "$AQUA_REPO" "$AQUA_COMMIT"
emit "$SRC/swap-vm/out/AquaSwapVMRouter.sol/AquaSwapVMRouter.json" "$ART/AquaSwapVMRouter.json" \
  AquaSwapVMRouter "$SWAPVM_REPO" "$SWAPVM_COMMIT"
emit "$MOCK/out/MockERC20.sol/MockERC20.json" "$ART/MockERC20.json" MockERC20 "" ""

# --- 5. canonical check -----------------------------------------------------
# sha256 of the creation bytecode that was proven to deploy runtime code identical to Base mainnet
# (AquaRouter byte-for-byte; AquaSwapVMRouter modulo immutables). A drifted toolchain fails here.
check() { # name sha256
  local got
  got="$(node -e 'const a=require(process.argv[1]);console.log(require("crypto").createHash("sha256").update(Buffer.from(a.bytecode.slice(2),"hex")).digest("hex"))' "$ART/$1.json")"
  if [[ "$got" != "$2" ]]; then echo "ERROR: $1 creation bytecode sha256 $got != canonical $2" >&2; exit 1; fi
}
check AquaRouter 5d4968082eb42824ca79c02e056709407338cc425273f80c1aa850876ecdacf8
check AquaSwapVMRouter a90f05e01c561d7657f6779b0baa444be108780e758bf54bdcb056705f8e7003

log "done in $((SECONDS - START))s"
