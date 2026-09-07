package com.stan_ely.qrdrop

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import java.io.File

/**
 * The app shell, plus the writing end of the share-sheet handoff.
 *
 * THIS FILE IS A HAND EDIT INSIDE gen/ -- one of the entries in CLAUDE.md's
 * table of them, which is the only thing standing between a `tauri android
 * init` and silently losing the whole delta. That is why gen/ is committed at
 * all. Do not add an edit here without adding a row there.
 *
 * It holds the writing end of BOTH handoffs: a shared file (below) and a
 * launcher shortcut or Quick Settings tile's chosen screen (further below).
 * They are the same mechanism carrying different cargo.
 *
 * WHY THE HANDOFF IS A FILE ON DISK. An ACTION_SEND intent arrives as a
 * `content://` URI that only Android's ContentResolver can open -- there is
 * no path for the Rust side to read and no way to pass the descriptor across
 * without a full Tauri Android plugin (a Kotlin class, a Rust binding, a
 * Gradle entry and a permissions manifest) for what amounts to one filename
 * and one number. So this copies the stream into the app's own cache
 * directory and writes a small JSON beside it; src/share.rs reads that JSON
 * and deletes it, and app/src/main.js turns it into a send.
 *
 * `cacheDir` here MUST be the directory Tauri's `app_cache_dir()` resolves to
 * on Android. It is -- both are the context's cache directory -- and it is
 * the one assumption in this file that no test on a developer machine can
 * check, so it is written down rather than left to be rediscovered from an
 * app that appears in the share sheet and then does nothing.
 */
class MainActivity : TauriActivity() {
  companion object {
    /** One tag for the whole chain, so it is an `adb logcat -s qrdrop` away. */
    const val TAG = "qrdrop"

    /**
     * The extra a launcher shortcut or the Quick Settings tile carries to say
     * which screen it meant. Named here rather than in each caller because
     * QrdropTileService reads it off this class -- res/xml/shortcuts.xml
     * cannot, XML having no way to reference a Kotlin constant, so that file
     * spells the same string out and says that it is doing so.
     */
    const val EXTRA_LAUNCH_ACTION = "com.stan_ely.qrdrop.LAUNCH_ACTION"

    /**
     * The actions this build will pass on, and the reason this check exists.
     *
     * MainActivity is an exported activity -- it has to be, or the share sheet
     * and the deep links could not reach it -- so any app on the device can
     * fire an intent at it carrying whatever it likes in that extra. Nothing
     * downstream interpolates the value (src/share.rs carries the string,
     * element.js looks it up in a fixed map), so an unknown one would be
     * inert anyway. It is filtered here regardless, at the boundary where the
     * value stops being someone else's: an allowlist beside the definition is
     * cheaper to keep true than an argument about why the layers below are
     * safe.
     */
    val LAUNCH_ACTIONS = setOf("receive", "send", "photo")

    /** Named by src/share.rs's LAUNCH_HANDOFF. The two must agree. */
    const val LAUNCH_HANDOFF = "qrdrop-launch.json"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // A share to an app that was not running lands here.
    stashSharedFile(intent)
    stashLaunchAction(intent)
  }

  /**
   * A share to an app that WAS running lands here instead.
   *
   * The activity is `launchMode="singleTask"` (AndroidManifest.xml), so
   * Android reuses the existing instance rather than creating a second one --
   * which means onCreate does not run and this is the only callback that
   * fires. Handling only onCreate was the first shape and it works exactly
   * once per cold start, which is the most misleading way this could fail:
   * it would look like it worked when the tester tried it, and stop working
   * for every share after.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    stashSharedFile(intent)
    stashLaunchAction(intent)
  }

  /**
   * Records which screen a launcher shortcut or the Quick Settings tile asked
   * for, in the same shape and for the same reasons as stashSharedFile above.
   *
   * A file on disk rather than anything cleverer, because the web layer is not
   * running yet on a cold start and there is nothing to postMessage to; and a
   * take rather than a read on the other side, because app/src/main.js polls
   * on every window focus and a handoff that survived would drag a person back
   * to the scanner from wherever they had since got to.
   *
   * Never throws and always logs, exactly as stashSharedFile does. The reason
   * is written out there in full: a silent catch on this path turns the one
   * likely failure into something indistinguishable from the feature not being
   * wired up at all, and it cost a whole device run once already.
   */
  private fun stashLaunchAction(intent: Intent?) {
    val requested = intent?.getStringExtra(EXTRA_LAUNCH_ACTION) ?: return

    if (requested !in LAUNCH_ACTIONS) {
      // Logged rather than dropped in silence: this is what a shortcut
      // definition drifting from the web layer looks like from the device,
      // and it is otherwise indistinguishable from the extra not arriving.
      Log.w(TAG, "ignoring unknown launch action: " + requested)
      return
    }

    try {
      // Kept as JSON rather than a bare string so the Rust side deserialises
      // it the way it deserialises the share handoff, and so a later field
      // does not have to change the file's format.
      val handoff = JSONObject().put("action", requested)
      File(cacheDir, LAUNCH_HANDOFF).writeText(handoff.toString())
      Log.i(TAG, "stashed launch action " + requested)
    } catch (e: Exception) {
      Log.w(TAG, "could not stash the launch action", e)
    }
  }

  /**
   * Copies a shared stream into the cache directory and writes the handoff.
   *
   * Never throws, and always logs. Those are two separate decisions, and the
   * first version of this conflated them: it caught everything and said
   * nothing, on the reasoning that a share which cannot be read must not
   * crash the app on the way in from another app's share sheet. That half is
   * right -- the web layer treats "no handoff" as the ordinary case and the
   * person lands on the choose screen.
   *
   * Swallowing the REASON as well was the mistake, and it cost the first
   * device run: the shared/ directory appeared, nothing landed in it, and
   * logcat had not one word to say about why. A silent catch turns the single
   * most likely failure on this path -- a URI the app was never granted
   * permission to read -- into something indistinguishable from the feature
   * not being wired up at all. Log.w crashes nobody.
   */
  private fun stashSharedFile(intent: Intent?) {
    if (intent == null) return
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return

    val uri = firstStream(intent)
    if (uri == null) {
      Log.w(TAG, "share intent carried no EXTRA_STREAM: " + intent.action)
      return
    }

    try {
      val name = displayName(uri)
      // A directory of our own inside the cache, so clearing a stale share
      // cannot touch anything else the app keeps there.
      val dir = File(cacheDir, "shared").apply {
        deleteRecursively()
        mkdirs()
      }

      // The name is used for the copy's filename, so it has to be reduced to
      // a bare filename first: another app chose this string, and a value
      // like "../databases/x" would otherwise write outside the directory
      // this line just created. File(name).name keeps the last segment only.
      val safe = File(name).name.ifBlank { "shared-file" }
      val payload = File(dir, safe)

      val stream = contentResolver.openInputStream(uri)
      if (stream == null) {
        Log.w(TAG, "openInputStream returned null for " + uri)
        return
      }
      val copied = stream.use { input ->
        payload.outputStream().use { output -> input.copyTo(output) }
      }

      // The name in the handoff is the ORIGINAL, not the sanitised filename:
      // the sanitising exists to keep this process from writing somewhere it
      // should not, and the person on the other end should see the name the
      // sending app gave. It reaches the UI through the vdom, which has no
      // innerHTML path (src/web/vdom.js), and is never used to build a path
      // on the receiving side either.
      val handoff = JSONObject()
        .put("name", name)
        .put("path", payload.absolutePath)
        .put("size", copied)

      // Named by src/share.rs's HANDOFF constant. The two must agree and
      // nothing can check that, so both sides say so.
      File(cacheDir, "qrdrop-share.json").writeText(handoff.toString())
      Log.i(TAG, "stashed " + copied + " bytes as \"" + name + "\"")
    } catch (e: Exception) {
      // A SecurityException here is the sending app not having granted read
      // access to the URI, which is both the likeliest failure on this path
      // and the one that looks exactly like nothing having happened.
      Log.w(TAG, "could not stash the shared file", e)
    }
  }

  /**
   * The first stream in the intent, whether it arrived as SEND or
   * SEND_MULTIPLE.
   *
   * SEND_MULTIPLE is accepted and then reduced to one file, which is honest
   * rather than lazy: qrdrop moves one file at a time (README, "One file at a
   * time"), and the alternative was to leave multi-select out of the
   * intent-filter entirely. That reads worse on the phone -- an app missing
   * from the share sheet the moment a second photo is selected looks broken,
   * where taking the first one and showing its name on the send screen says
   * plainly what happened.
   */
  private fun firstStream(intent: Intent): Uri? {
    @Suppress("DEPRECATION")
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        ?: intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.firstOrNull()
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM)
        ?: intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.firstOrNull()
    }
  }

  /**
   * The provider's display name, falling back to the URI's last path segment.
   *
   * A `content://` URI has no filename in it -- the name lives in the
   * provider's DISPLAY_NAME column, and querying for it is the only way to
   * get what the person saw in the app they shared from. Without this every
   * shared photo would arrive on the other device called something like
   * "1000012345".
   */
  private fun displayName(uri: Uri): String {
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) {
          val name = cursor.getString(column)
          if (!name.isNullOrBlank()) return name
        }
      }
    return uri.lastPathSegment?.let { File(it).name }?.ifBlank { null } ?: "shared-file"
  }
}
