/**
 * The page's end of src-tauri/src/history.rs: four commands, and nothing in
 * between. The store lives in Rust, in the app data directory, because
 * webview storage is the browser's to clear and a switch that came back on by
 * itself would be worse than having none; history.rs says more.
 *
 * Kept out of shell.js so the shell takes these as an option, as it takes
 * changeFolder, and is driven in check-layout.mjs with no Tauri underneath.
 */
import { invoke } from '@tauri-apps/api/core'

/**
 * @typedef {import('../../src/web/events.js').TransferRecord} Entry
 * @typedef {{ enabled: boolean, entries: Entry[] }} Store
 */

/** @returns {Promise<Store>} */
export const list = () => invoke('history_list')

/**
 * Resolves false when recording is off, which history.rs decides as well as
 * the shell, so a record cannot be written past the switch either way.
 *
 * @param {Entry} entry
 * @returns {Promise<boolean>}
 */
export const append = entry => invoke('history_append', { entry })

/** @returns {Promise<Store>} */
export const clear = () => invoke('history_clear')

/**
 * @param {boolean} enabled
 * @returns {Promise<Store>}
 */
export const setEnabled = enabled => invoke('history_set_enabled', { enabled })
