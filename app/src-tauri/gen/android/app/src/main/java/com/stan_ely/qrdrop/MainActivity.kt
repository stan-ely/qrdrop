package com.stan_ely.qrdrop

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject
import java.io.File

/**
 * The app shell, plus the writing end of the share-sheet handoff.
 *
 * THIS FILE IS A HAND EDIT INSIDE gen/, and the third one. The other two are
 * the CAMERA permission in AndroidManifest.xml and the adaptive-icon
 * background colour in res/values/ic_launcher_background.xml. CLAUDE.md lists
 * all three; that list is the only thing standing between a `tauri android
 * init` and silently losing them, which is why gen/ is committed at all.
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
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // A share to an app that was not running lands here.
    stashSharedFile(intent)
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
  }

  /**
   * Copies a shared stream into the cache directory and writes the handoff.
   *
   * Deliberately silent on every failure. A share that cannot be read is
   * indistinguishable, from here, from an app being opened normally, and the
   * web layer already handles "no handoff" as the ordinary case: the person
   * gets the choose screen and picks a file. Throwing would crash the app on
   * the way in from another app's share sheet, which is the worst possible
   * place to surface a copy error.
   */
  private fun stashSharedFile(intent: Intent?) {
    if (intent == null) return
    if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return

    val uri = firstStream(intent) ?: return

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

      val copied = contentResolver.openInputStream(uri)?.use { input ->
        payload.outputStream().use { output -> input.copyTo(output) }
      } ?: return

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
    } catch (_: Exception) {
      // See the note above: silence is the correct posture here.
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
