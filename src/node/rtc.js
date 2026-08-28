/**
 * WebRTC for Node, via node-datachannel.
 *
 * Node has no native RTCPeerConnection, and openRoom() (src/transport/room.js)
 * accepts an `rtcPolyfill` for exactly this reason -- Trystero forwards it
 * straight through to the RTCPeerConnection constructor it uses internally.
 * This was verified end-to-end before anything in src/node/ or src/cli.js was
 * built on top of it: two Node processes, each holding one room open with
 * this polyfill, paired over the real Nostr relays and exchanged a file with
 * matching digests. That is what makes the rest of this package possible --
 * without it, qrdrop/node would have nothing to hand openRoom() and the CLI
 * would not exist.
 *
 * node-datachannel is an optionalDependency, not a dependency, because it
 * ships a native binary (libdatachannel via prebuilt bindings) and the
 * browser half of this package must never require one. A dynamic import is
 * what makes that optional: a static `import ... from 'node-datachannel'` at
 * the top of a file reachable from src/index.js would drag the native module
 * into every consumer's dependency graph, install or not.
 */

/**
 * @returns {Promise<typeof RTCPeerConnection>}
 */
export async function loadRTCPolyfill() {
  try {
    const mod = await import('node-datachannel/polyfill')
    return mod.RTCPeerConnection
  } catch (error) {
    // A bare module-not-found stack trace here would read as "the CLI is
    // broken" rather than "one optional native dependency did not install" --
    // easy to mistake for the former when node-datachannel's prebuilt binary
    // silently fails to fetch for an unsupported platform/arch combination.
    // Naming the exact fix is cheaper than making the user diagnose an
    // ESM resolution error against a package they may not know exists.
    throw new Error(
      'WebRTC support is unavailable: the optional "node-datachannel" package '
      + 'is not installed (or failed to load its native binary for this '
      + 'platform). Run `npm install node-datachannel` and try again.\n'
      + `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
