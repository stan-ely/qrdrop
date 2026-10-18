#!/bin/bash
# The transfer bench with each peer behind its own NAT, without root:
#
#   unshare -rn bash crates/qrdrop-session/examples/nat.sh
#   RTT=50 EXTRA=--quic unshare -rn bash crates/qrdrop-session/examples/nat.sh
#
#   peer A 192.168.10.2 -- 192.168.10.1 [NAT A] 100.64.1.2 -- 100.64.1.1
#                                                             [internet]   relay + STUN on 100.64.1.1
#   peer B 192.168.20.2 -- 192.168.20.1 [NAT B] 100.64.2.2 -- 100.64.2.1
#
# This namespace is the internet and runs `bench serve`: the stand-in relay
# and a STUN responder, so each peer learns its mapped address the way it
# would from a public server. Each NAT is iptables MASQUERADE, which maps
# endpoint-independently and keeps the source port where it can: the common
# home router, and the case a hole punch can win. A symmetric NAT on both
# sides needs a TURN relay and is not what this measures.
#
# Each NAT also DROPS unsolicited input on its WAN side, and the harness
# fails without that, for a reason that is the harness's and not the
# traversal's. Both peers punch at once, so one side's first check reaches
# the other NAT before that NAT has a mapping for it. Accepted, the packet is
# delivered to the NAT namespace itself and its conntrack entry is confirmed,
# and that entry now holds the very tuple the peer behind it is about to
# send on, so MASQUERADE picks a different source port for it -- the mapping
# goes port-changing and every check after it misses. Measured: nine checks
# out of each NAT to the other's mapped address, none forwarded in. A
# dropped packet is never confirmed, and a real router drops it.
#
# iptables needs no root either, only a binary: in a distro without one,
# `apt-get download iptables libxtables12 libip4tc2 libnftnl11` and
# `dpkg -x` each into one directory, then point IPTABLES_ROOT at it.
#
# Variables: RTT (ms, half on each internet link), RUNS, SIZE, NETEM, EXTRA,
# NONAT=1 (route the private ranges instead, to compare), BLOCKQUIC=1 (drop
# every QUIC long-header packet on the internet, which leaves STUN and DTLS
# alone: the QUIC handshake cannot finish, and the sender should go on over
# WebRTC after quic::LINK_WAIT), CPUS_A / CPUS_B, LABEL, BENCH.
set -u
here=$(cd "$(dirname "$0")" && pwd)
B=${BENCH:-$here/../../../target/release/examples/bench}
if [ -n "${IPTABLES_ROOT:-}" ]; then
  export LD_LIBRARY_PATH=$IPTABLES_ROOT/usr/lib/x86_64-linux-gnu
  export XTABLES_LIBDIR=$IPTABLES_ROOT/usr/lib/x86_64-linux-gnu/xtables
  IPT="$IPTABLES_ROOT/usr/sbin/xtables-nft-multi iptables"
else
  IPT=iptables
fi
ns() { unshare -n sleep infinity >/dev/null 2>&1 & echo $!; }
at() { nsenter -t "$1" -n "${@:2}"; }
ip link set lo up
echo 1 > /proc/sys/net/ipv4/ip_forward
NA=$(ns); NB=$(ns); PA=$(ns); PB=$(ns)
sleep 0.3
ip link add ia type veth peer name wa; ip link set wa netns $NA
ip link add ib type veth peer name wb; ip link set wb netns $NB
ip addr add 100.64.1.1/24 dev ia; ip link set ia up
ip addr add 100.64.2.1/24 dev ib; ip link set ib up
for x in A B; do
  eval n=\$N$x; eval p=\$P$x
  l=$(echo $x | tr AB 12); w=$(echo w$x | tr AB ab)
  at $n sh -c "ip link set lo up; ip addr add 100.64.$l.2/24 dev $w; ip link set $w up; ip route add default via 100.64.$l.1; echo 1 > /proc/sys/net/ipv4/ip_forward"
  ip link add l$x type veth peer name p$x
  ip link set l$x netns $n; ip link set p$x netns $p
  at $n sh -c "ip addr add 192.168.${l}0.1/24 dev l$x; ip link set l$x up"
  at $p sh -c "ip link set lo up; ip addr add 192.168.${l}0.2/24 dev p$x; ip link set p$x up; ip route add default via 192.168.${l}0.1"
  if [ -n "${NONAT:-}" ]; then
    ip route add 192.168.${l}0.0/24 via 100.64.$l.2
  else
    at $n $IPT -t nat -A POSTROUTING -o $w -j MASQUERADE
    at $n $IPT -A INPUT -i $w -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    at $n $IPT -A INPUT -i $w -j DROP
  fi
done
if [ -n "${BLOCKQUIC:-}" ]; then
  # The first payload byte of a QUIC long header has its top two bits set,
  # which no STUN message or DTLS record does.
  $IPT -A FORWARD -p udp -m u32 --u32 "0>>22&0x3C@8>>24&0xC0=0xC0" -j DROP
fi
if [ "${RTT:-0}" != 0 ] || [ -n "${NETEM:-}" ]; then
  for dev in ia ib; do tc qdisc replace dev $dev root netem delay $((${RTT:-0} / 4))ms limit 100000 ${NETEM:-}; done
  for x in A B; do
    eval n=\$N$x; w=$(echo w$x | tr AB ab)
    at $n tc qdisc replace dev $w root netem delay $((${RTT:-0} / 4))ms limit 100000 ${NETEM:-}
  done
fi
at $PA ping -c1 -W1 192.168.20.2 >/dev/null 2>&1 && { echo "LEAK: A reaches B's private address"; exit 1; }

$B serve --relay-at 100.64.1.1:7600 --stun-at 100.64.1.1:3478 >/tmp/bench-serve.log 2>&1 &
SP=$!
sleep 0.5
for i in ${RUNS:-1 2}; do
  code=$($B code)
  at $PA taskset -c ${CPUS_A:-2} $B host --code "$code" --bind 192.168.10.2 --relay ws://100.64.1.1:7600 --stun 100.64.1.1:3478 --size ${SIZE:-67108864} ${EXTRA:-} >/tmp/bench-host.log 2>&1 &
  hp=$!
  sleep 0.3
  out=$(timeout 300 nsenter -t $PB -n taskset -c ${CPUS_B:-4} $B guest --code "$code" --bind 192.168.20.2 --relay ws://100.64.1.1:7600 --stun 100.64.1.1:3478 ${EXTRA:-} 2>/tmp/bench-guest.err | tail -n 1)
  wait $hp
  echo "${LABEL:-nat} rtt=${RTT:-0} ${NETEM:-} $out"
  [ -n "$out" ] || tail -n 8 /tmp/bench-host.log /tmp/bench-guest.err
done
kill $SP $NA $NB $PA $PB
