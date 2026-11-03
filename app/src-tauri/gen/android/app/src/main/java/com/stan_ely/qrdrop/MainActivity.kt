package com.stan_ely.qrdrop

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import kotlin.math.max

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

  /**
   * Back walks the history the page actually has, by asking the page to.
   *
   * WryActivity's own callback does canGoBack() and goBack(). The session guard
   * answers a press by pushing its sentinel back with no user activation, and
   * after that goBack() the WebView said there was nowhere to go: measured on
   * API 29 with WebView 158, index 2 of 3 and canGoBack=false, 1.9 s after the
   * push. So a second Back closed the app mid-transfer however slowly it was
   * pressed, where it should have cancelled. This looks like Chromium's history
   * manipulation intervention, which skips such entries. Anything sent over
   * devtools carries a user gesture and clears it, so a test that reads the page
   * between two presses passes against the bug.
   *
   * Traversing from the page does not trip it: canGoBack stayed true throughout.
   * goBackOrForward(-1) is the obvious alternative and did not help, the app
   * still closed. The list's index is the test because it is the one reading
   * that stayed right when canGoBack was wrong.
   *
   * WryActivity's callback is not registered at all (handleBackNavigation), so
   * this is the only one, and it stands aside at the bottom of the stack so that
   * Back still leaves the app from Home.
   *
   * PREDICTIVE BACK. The system shows its back-to-home preview only when no
   * callback is enabled as the gesture starts, so a callback that is always on,
   * as both of these used to be, means the gesture never previews anything. So
   * this one is on exactly when the page has an entry to go back to, which the
   * page reports (watchHistory). Where it cannot, an old WebView, it stays on and
   * Back behaves as it always did, without the preview.
   */
  override val handleBackNavigation: Boolean = false

  override fun onWebViewCreate(webView: WebView) {
    // Transparent until the page paints its own --bg, so the window background
    // below shows through rather than the WebView's white. Without it a phone in
    // night mode went from the dark splash to a white flash to the page.
    webView.setBackgroundColor(Color.TRANSPARENT)

    val watched = watchHistory(webView)
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (webView.copyBackForwardList().currentIndex > 0) {
          webView.evaluateJavascript("history.back()", null)
          return
        }
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = !watched
      }
    }
    backCallback = callback
    onBackPressedDispatcher.addCallback(this, callback)
  }

  private var backCallback: OnBackPressedCallback? = null

  /**
   * Keeps the Back callback on exactly while the page has history, as far as
   * the page can say so.
   *
   * app/src/main.js posts "push" after every pushState and "moved" on every
   * popstate and hashchange. A push turns the callback on at once, because a
   * push always leaves something to go back to, and a Back press in the moment
   * before the list caught up must still be caught: that is the press that
   * would otherwise leave the app mid-transfer. Everything is then read again
   * from the list a beat later, since a push made by the page reaches the list
   * on another channel from this message. Erring towards on costs only the
   * preview. Erring towards off costs the session, so nothing here turns the
   * callback off on the strength of a message alone.
   *
   * addWebMessageListener rather than addJavascriptInterface, because it is
   * restricted to the app's own origin and carries a string and nothing else.
   *
   * @return whether the page can report, so the callback knows to stay on if not.
   */
  private fun watchHistory(webView: WebView): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    val read = Runnable {
      backCallback?.isEnabled = webView.copyBackForwardList().currentIndex > 0
    }
    WebViewCompat.addWebMessageListener(
      webView, "qrdropBack", setOf("http://tauri.localhost", "https://tauri.localhost"),
    ) { _, message, _, _, _ ->
      if (message.data == "push") backCallback?.isEnabled = true
      else read.run()
      webView.removeCallbacks(read)
      webView.postDelayed(read, 150)
    }
    return true
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    keepClearOfBars()
    // A share to an app that was not running lands here.
    stashSharedFile(intent)
    stashLaunchAction(intent)
  }

  /**
   * The theme changed while the app was open.
   *
   * The manifest lists uiMode in configChanges, so a switch to or from night
   * mode does not recreate this activity, and nothing decided in onCreate is
   * decided again: the status bar's icons would stay dark on a page that had
   * just gone dark, and the strip under the navigation bar would keep the old
   * --bg. enableEdgeToEdge reads the night mode each time it is called, and the
   * resources already answer for the new configuration here.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    enableEdgeToEdge()
    window.setBackgroundDrawable(ColorDrawable(getColor(R.color.qrdrop_bg)))
  }

  /**
   * Keeps the page out from under the navigation bar and the keyboard, which
   * CSS cannot do.
   *
   * Edge to edge, the WebView lays out behind the system bars, and it reports
   * the status bar to the page and not the navigation bar: measured on API 29
   * with WebView 158, env(safe-area-inset-top) is 24px and -bottom is 0 in a
   * viewport the full height of the screen. So every safe-area term in the CSS
   * resolved to nothing, and the app's full-bleed action bar put Send text
   * behind the Back button. Dropping enableEdgeToEdge() is not an alternative,
   * because Android 15 enforces it at this targetSdk.
   *
   * The keyboard is the same problem. Edge to edge, adjustResize no longer
   * shrinks the window for it, so the compose sheet's box and its Send button
   * sat under the keyboard they were typed with. Padding the bottom by the
   * taller of the two shrinks the WebView, and the page's dvh with it, so the
   * sheet rises above the keys. The two are not added: the keyboard covers the
   * navigation bar's area rather than sitting on top of it.
   *
   * Both insets are consumed so that a WebView that does report them cannot
   * clear the same space twice.
   */
  private fun keepClearOfBars() {
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bar = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bar.left, 0, bar.right, max(bar.bottom, keyboard.bottom))
      WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.NONE)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }
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
