#!/bin/bash
# The offline pairing's gate (docs/notes/offline-pairing.md, phase B): two
# Rust CLIs that can reach each other and nothing else pair, verify and move
# a file, with no relay anywhere.
#
#   cargo build --release -p qrdrop-cli
#   unshare -rn bash crates/qrdrop-session/examples/offline.sh
#
# Two network namespaces over a veth pair, as netem.sh builds them, but with
# NO default route on either side: every public relay is unreachable, so the
# only way the two can meet is the locator in the sender's code. The sender
# runs here with QRDROP_OFFLINE=1, which is what puts the locator in the code
# until both CLIs share an --offline flag; the receiver runs in the other
# namespace with the code as printed. Linux only, and no root: `unshare -r`
# stands in for it, so this runs as an ordinary user under WSL as well.
#
# Pass means: both sides printed the same SAS, both report the same digest,
# and the received bytes equal the sent ones. Every line of both logs is
# printed on a failure.
#
# Variables: QRDROP (the binary; default target/release/qrdrop), SIZE (bytes,
# default 3 MiB), WAIT (seconds for the whole run, default 120).
set -u
here=$(cd "$(dirname "$0")" && pwd)
Q=${QRDROP:-$here/../../../target/release/qrdrop}
SIZE=${SIZE:-3145728}
work=$(mktemp -d)
trap 'kill $PEER 2>/dev/null; rm -rf "$work"' EXIT

ip link set lo up
unshare -n sleep infinity >/dev/null 2>&1 &
PEER=$!
sleep 0.3
ip link add va type veth peer name vb
ip link set vb netns $PEER
# 192.168, not netem.sh's 10.77: either is private, and this keeps the two
# scripts' namespaces from being mistaken for one another in a log.
ip addr add 192.168.77.1/24 dev va && ip link set va up
nsenter -t $PEER -n sh -c 'ip link set lo up; ip addr add 192.168.77.2/24 dev vb; ip link set vb up'
if ip route | grep -q '^default' || nsenter -t $PEER -n ip route | grep -q '^default'; then
  echo "FAIL a default route exists; this gate is meaningless with one" >&2
  exit 1
fi

head -c "$SIZE" /dev/urandom >"$work/payload.bin"
mkdir "$work/out"

# Each side answers its SAS prompt with y and keeps stdin open after it, so an
# EOF is never read as an answer. The script compares the SAS itself below,
# which is the person's job everywhere else.
answer() { { printf 'y\n'; sleep "${WAIT:-120}"; } }

answer | QRDROP_OFFLINE=1 timeout "${WAIT:-120}" "$Q" send --no-qr "$work/payload.bin" >"$work/send.out" 2>"$work/send.err" &
sp=$!
code=
for _ in $(seq 1 100); do
  code=$(sed -n 's/^Transfer code: //p' "$work/send.out" | tr -d '\033' | sed 's/\[[0-9;]*m//g')
  [ -n "$code" ] && break
  sleep 0.1
done
show() {
  for f in send.out send.err recv.out recv.err; do
    echo "--- $f"
    cat "$work/$f" 2>/dev/null
  done
}
if [ -z "$code" ]; then
  echo "FAIL the sender printed no code"
  show
  exit 1
fi
case "$code" in
  *.*) ;;
  *)
    echo "FAIL the code has no locator: $code"
    show
    exit 1
    ;;
esac

answer | nsenter -t $PEER -n timeout "${WAIT:-120}" "$Q" receive --yes --out "$work/out" "$code" >"$work/recv.out" 2>"$work/recv.err"
rc=$?
wait $sp
sc=$?

sas() { grep -A2 'Both devices should be showing' "$1" | sed -n '3p' | sed 's/\x1b\[[0-9;]*m//g'; }
digest() { sed -n 's/.*digest=\([0-9a-f]*\).*/\1/p' "$1" | tail -n 1; }
s_sas=$(sas "$work/send.out")
r_sas=$(sas "$work/recv.out")
s_dig=$(digest "$work/send.out")
r_dig=$(digest "$work/recv.out")
if [ "$sc" = 0 ] && [ "$rc" = 0 ] && [ -n "$s_sas" ] && [ "$s_sas" = "$r_sas" ] \
  && [ -n "$s_dig" ] && [ "$s_dig" = "$r_dig" ] && cmp -s "$work/payload.bin" "$work/out/payload.bin"; then
  echo "PASS offline: $SIZE bytes, SAS $s_sas, digest $s_dig"
  grep -h 'local network' "$work/send.err" "$work/recv.err" | sed 's/^/  /'
else
  echo "FAIL send=$sc receive=$rc sas='$s_sas' vs '$r_sas' digest='$s_dig' vs '$r_dig'"
  show
  exit 1
fi
