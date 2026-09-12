import test from 'node:test'
import assert from 'node:assert/strict'

import { createControlStream } from '../src/core/control.js'

// The field report: a phone cancelled a 64 MiB receive at 25%, and the CLI sender
// went on to "Sent 64 MB of 64 MB" and was still running two minutes later. Its
// onPeerLeave did call control.fail() -- but fail() only rejected a waiter that
// already existed, and mid-file there is none. The leave was forgotten, and the
// sender then parked on a 'done' that was never coming. These pin the failure as
// a state of the stream rather than an event that only a present listener hears.

const gone = () => new Error('The other device disconnected')

test('a failure before anyone waits still rejects the next wait', async () => {
  const control = createControlStream()
  const error = gone()
  control.fail(error)
  await assert.rejects(control.next(['done', 'error'], 0), e => e === error)
  await assert.rejects(control.next(['accept'], 0), e => e === error, 'and every wait after it')
})

test('a parked waiter is rejected, as before', async () => {
  const control = createControlStream()
  const waiting = control.next(['done'], 0)
  control.fail(gone())
  await assert.rejects(waiting, /disconnected/)
})

test('a message that arrived before the failure is still delivered', async () => {
  // The success-then-leave order: the peer sends done and closes. Its done must
  // finish the transfer rather than lose a race to the leave that followed it.
  const control = createControlStream()
  control.push({ t: 'done', seq: 0 })
  control.fail(gone())
  assert.deepEqual(await control.next(['done', 'error'], 0), { t: 'done', seq: 0 })
  await assert.rejects(control.next(['done', 'error'], 0), /disconnected/)
})

test('the first failure is the one reported', async () => {
  const control = createControlStream()
  control.fail(gone())
  control.fail(new Error('a later, lesser complaint'))
  await assert.rejects(control.next(['done'], 0), /disconnected/)
  assert.throws(() => control.throwIfFailed(), /disconnected/)
})

test('throwIfFailed throws only once the stream has failed', () => {
  const control = createControlStream()
  control.throwIfFailed()
  control.fail(gone())
  assert.throws(() => control.throwIfFailed(), /disconnected/)
})

test('a failed stream rejects the flow gate, paused or not', async () => {
  // Without this a paused sender whose receiver left would sit out the whole
  // PAUSE_TIMEOUT_MS before saying anything, and blame the wrong thing.
  const running = createControlStream()
  running.fail(gone())
  await assert.rejects(/** @type {Promise<void>} */ (running.flowGate()), /disconnected/)

  const paused = createControlStream()
  paused.setFlow('pause')
  paused.fail(gone())
  await assert.rejects(/** @type {Promise<void>} */ (paused.flowGate()), /disconnected/)
})

test('a sender parked on the flow gate is released by the failure', async () => {
  const control = createControlStream()
  control.setFlow('pause')
  const gate = control.flowGate()
  assert.ok(gate)
  control.fail(gone())
  await assert.rejects(gate, /disconnected/)
})

test('resume still releases the gate on a healthy stream', async () => {
  const control = createControlStream()
  control.setFlow('pause')
  const gate = control.flowGate()
  control.setFlow('resume')
  await gate
  assert.equal(control.flowGate(), null)
})
