#!/bin/bash
# The two-process transfer bench across an emulated link, without root:
#
#   cargo build --release -p qrdrop-session --examples --features quic
#   unshare -rn bash crates/qrdrop-session/examples/netem.sh
#   RTTS="20 50" NETEM="loss 0.5%" EXTRA=--quic unshare -rn bash crates/qrdrop-session/examples/netem.sh
#
# Two network namespaces over a veth pair, netem on each egress carrying half
# the round trip, the host (sender, and the stand-in relay) in this namespace
# and the guest in the other. Linux only; `unshare -r` is what stands in for
# root, so this runs as an ordinary user under WSL as well.
#
# Each side is pinned to ONE core, and that is the measurement rather than a
# tidy-up: with a qdisc armed from two CPUs netem reorders packets, and an
# SCTP sender halves its window on each reorder it takes for loss, so two
# cores per side measured WebRTC at about half its one-core rate.
#
# Variables: RTTS (ms, default "0 20 50 100"), RUNS ("1 2"), SIZE (bytes,
# 256 MiB), SIZE_LONG (used at 50 ms and above, 64 MiB), NETEM (appended to
# the netem spec: "loss 0.5%", "rate 100mbit loss 0.1%"), EXTRA (passed to
# both sides: --quic), CPUS_A / CPUS_B, LABEL, BENCH (the binary).
set -u
here=$(cd "$(dirname "$0")" && pwd)
B=${BENCH:-$here/../../../target/release/examples/bench}
ip link set lo up
unshare -n sleep infinity >/dev/null 2>&1 &
PEER=$!
sleep 0.3
ip link add va type veth peer name vb
ip link set vb netns $PEER
ip addr add 10.77.0.1/24 dev va && ip link set va up && ip route add default dev va
nsenter -t $PEER -n sh -c 'ip link set lo up; ip addr add 10.77.0.2/24 dev vb; ip link set vb up; ip route add default dev vb'
setq() {
  if [ "$1" = 0 ] && [ -z "${NETEM:-}" ]; then
    tc qdisc del dev va root 2>/dev/null
    nsenter -t $PEER -n tc qdisc del dev vb root 2>/dev/null
    true
  else
    tc qdisc replace dev va root netem delay $(($1 / 2))ms limit 100000 ${NETEM:-}
    nsenter -t $PEER -n tc qdisc replace dev vb root netem delay $(($1 / 2))ms limit 100000 ${NETEM:-}
  fi
}
port=7400
for rtt in ${RTTS:-0 20 50 100}; do
  setq $rtt
  size=${SIZE:-268435456}
  [ "$rtt" -ge 50 ] && size=${SIZE_LONG:-67108864}
  for i in ${RUNS:-1 2}; do
    port=$((port + 1))
    code=$($B code)
    taskset -c ${CPUS_A:-2} $B host --code "$code" --bind 10.77.0.1 --relay-at 10.77.0.1:$port --size $size ${EXTRA:-} >/tmp/bench-host.log 2>&1 &
    hp=$!
    sleep 0.5
    out=$(timeout 600 nsenter -t $PEER -n taskset -c ${CPUS_B:-4} $B guest --code "$code" --bind 10.77.0.2 --relay ws://10.77.0.1:$port ${EXTRA:-} 2>/tmp/bench-guest.err | tail -n 1)
    wait $hp
    echo "${LABEL:-run} rtt=$rtt ${NETEM:-} $out"
    [ -n "$out" ] || tail -n 8 /tmp/bench-host.log /tmp/bench-guest.err
  done
done
kill $PEER
