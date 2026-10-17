package com.stan_ely.qrdrop

import android.app.Activity
import android.content.Intent
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class CreateFileArgs {
  lateinit var name: String
  var mime: String? = null
}

@InvokeArg
class DeleteFileArgs {
  lateinit var uri: String
}

/**
 * The Kotlin half of src-tauri/src/storage.rs: where every received file on
 * Android is created.
 *
 * On Android 10 and later that is a MediaStore download in Download/qrdrop
 * (createDownload, then finishDownload when the bytes are in). Android 7 to 9
 * have no MediaStore.Downloads and cannot write to Download without a storage
 * permission, so on those the person picks a folder ONCE, before their first
 * pairing, and every receive after that is a document in it (createFile). On
 * any version the done screen's "Change folder" picks a folder too, and a
 * folder picked that way wins over Download/qrdrop.
 *
 * WHY A PLUGIN AND NOT MORE MAINACTIVITY. A folder grant is
 * ACTION_OPEN_DOCUMENT_TREE, which is an activity result to wait for and a
 * reply to send back to Rust, and Tauri's Plugin base class is the one thing
 * that already carries both. This is not a plugin crate: it lives in the app's
 * own package, compiles with the app (which already depends on
 * :tauri-android), and storage.rs loads it with register_android_plugin
 * through the activity's class loader -- so there is no Gradle entry, no
 * manifest entry and no ACL file. Losing that one Rust call leaves this class
 * in the APK doing nothing. Tauri's consumer ProGuard rules keep any
 * @TauriPlugin class and its @Command methods, which is what lets the release
 * build's minifier leave it alone.
 *
 * THE PERSISTED-PERMISSION LIST IS THE STORE. There is no preference file
 * holding the folder's URI: the grant itself is what says a folder was chosen,
 * and exactly one is ever held (pickFolderResult releases the rest). A second
 * copy of the URI would be a second thing to disagree with the first the day
 * the person revokes the grant from Settings.
 */
@TauriPlugin
class StoragePlugin(private val activity: Activity) : Plugin(activity) {

  /** sdk, and the held folder's name or null. See storage.rs's Status. */
  @Command
  fun status(invoke: Invoke) {
    val result = JSObject()
    result.put("sdk", Build.VERSION.SDK_INT)
    result.put("folder", heldFolder()?.let { folderName(it) })
    invoke.resolve(result)
  }

  /**
   * Opens the system folder picker at Download/qrdrop where that exists, and
   * at Download otherwise. On Android 11+ the Download root itself cannot be
   * chosen (the picker refuses it), which is why the subfolder is made first:
   * a direct mkdirs there needs no permission on those versions. On 10 and
   * older it fails quietly and the picker opens at Download, which those
   * versions do let the person choose.
   */
  @Command
  fun pickFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
      )
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialFolder())
      }
    }
    startActivityForResult(invoke, intent, "pickFolderResult")
  }

  /**
   * A dismissal resolves with a null folder rather than rejecting: dismissing
   * is a choice, and storage.rs reports it as one ("no folder chosen") rather
   * than as an error -- the same two-valued contract the sink keeps.
   */
  @ActivityCallback
  fun pickFolderResult(invoke: Invoke, result: ActivityResult) {
    val tree = result.data?.data
    val reply = JSObject()
    if (result.resultCode != Activity.RESULT_OK || tree == null) {
      reply.put("folder", null)
      invoke.resolve(reply)
      return
    }
    try {
      val resolver = activity.contentResolver
      resolver.takePersistableUriPermission(
        tree,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
      // Exactly one folder, ever. An app holds at most 128 (512 on 11+)
      // persisted grants, and "the first one in the list" is only a rule if
      // the list has one entry.
      for (held in resolver.persistedUriPermissions) {
        if (held.uri != tree) release(held.uri)
      }
      reply.put("folder", folderName(tree))
      invoke.resolve(reply)
    } catch (e: Exception) {
      invoke.reject("Could not keep access to that folder: ${e.message}")
    }
  }

  /**
   * A new document in the held folder. createDocument never returns an
   * existing document -- the external-storage provider renames a clash to
   * "name (1).ext" itself -- so this cannot overwrite anything, and the name
   * reported back is queried rather than assumed for exactly that reason.
   */
  @Command
  fun createFile(invoke: Invoke) {
    val args = invoke.parseArgs(CreateFileArgs::class.java)
    val tree = heldFolder()
    if (tree == null) {
      invoke.reject(NO_FOLDER)
      return
    }
    try {
      val parent = DocumentsContract.buildDocumentUriUsingTree(
        tree, DocumentsContract.getTreeDocumentId(tree)
      )
      val doc = DocumentsContract.createDocument(
        activity.contentResolver, parent, mimeFor(args.name, args.mime), args.name
      ) ?: throw IllegalStateException("the folder refused a new file")
      val result = JSObject()
      result.put("uri", doc.toString())
      result.put("name", displayName(doc) ?: args.name)
      result.put("folder", folderName(tree) ?: "the chosen folder")
      invoke.resolve(result)
    } catch (e: Exception) {
      // A grant that still exists but no longer works: the folder was deleted
      // or the storage removed. Release it so the next Receive asks again,
      // instead of failing the same way on every transfer from now on.
      Log.w(TAG, "createDocument failed", e)
      release(tree)
      invoke.reject(NO_FOLDER)
    }
  }

  /**
   * A new, pending entry in Download/qrdrop through MediaStore.Downloads.
   *
   * NOT a file created by path, though Android 11+ allows one there, and that
   * was tried first. MEASURED on an Android 15 emulator: FUSE gives a path-
   * created file a MediaStore row that is is_pending=1 with no size, and
   * closing it does not settle it -- some were still pending minutes later,
   * one had no row at all, and an explicit MediaScannerConnection.scanFile
   * after close raced the same way. A pending row is hidden from every other
   * app and purged after about a week. Here the row exists, pending, before a
   * byte is written, and finishDownload clearing IS_PENDING is what makes the
   * provider scan the finished file -- an ordering this side owns. It also
   * works on Android 10, where a path does not.
   *
   * The provider renames a clash to "name (1).ext" itself, so this never
   * overwrites. The name reported back here is only provisional: a clash is
   * renamed when the entry is published, and finishDownload reports the final
   * one. MIME from the extension, for createFile's reason (see mimeFor).
   */
  @Command
  fun createDownload(invoke: Invoke) {
    val args = invoke.parseArgs(CreateFileArgs::class.java)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      invoke.reject("MediaStore.Downloads needs Android 10")
      return
    }
    try {
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, args.name)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(args.name, args.mime))
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_SUBFOLDER")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IllegalStateException("MediaStore refused a new download")
      val result = JSObject()
      result.put("uri", uri.toString())
      result.put("name", mediaName(uri) ?: args.name)
      result.put("folder", "${Environment.DIRECTORY_DOWNLOADS}/$DOWNLOADS_SUBFOLDER")
      invoke.resolve(result)
    } catch (e: Exception) {
      Log.w(TAG, "MediaStore insert failed", e)
      invoke.reject("Could not save into Download/$DOWNLOADS_SUBFOLDER: ${e.message}")
    }
  }

  /**
   * Publishes a download once its bytes are written and its file closed.
   * Clearing IS_PENDING is the update MediaProvider answers by scanning the
   * file, which is what puts its real size in the index and makes it visible
   * to other apps. Best effort: the file is complete either way.
   *
   * Resolves with the name it was published under, which is NOT always the
   * one createDownload reported. A pending entry lives on disk as
   * ".pending-<expiry>-<name>", and the provider settles the final,
   * de-duplicated name only at this update. Measured on an Android 15
   * emulator: the second of two identical names was reported as
   * "many-big.bin" at insert and published as "many-big (1).bin".
   */
  @Command
  fun finishDownload(invoke: Invoke) {
    val args = invoke.parseArgs(DeleteFileArgs::class.java)
    try {
      val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      activity.contentResolver.update(Uri.parse(args.uri), values, null, null)
    } catch (e: Exception) {
      Log.w(TAG, "clearing IS_PENDING failed", e)
    }
    val result = JSObject()
    result.put("name", mediaName(Uri.parse(args.uri)))
    invoke.resolve(result)
  }

  /**
   * Removes a partial file after a cancelled receive, either kind: a document
   * in the granted folder, or a MediaStore download. Best effort.
   */
  @Command
  fun deleteFile(invoke: Invoke) {
    val args = invoke.parseArgs(DeleteFileArgs::class.java)
    try {
      val uri = Uri.parse(args.uri)
      if (DocumentsContract.isDocumentUri(activity, uri)) {
        DocumentsContract.deleteDocument(activity.contentResolver, uri)
      } else {
        activity.contentResolver.delete(uri, null, null)
      }
    } catch (e: Exception) {
      Log.w(TAG, "deleteDocument failed", e)
    }
    invoke.resolve(JSObject())
  }

  /**
   * The held folder, if it is still there. A grant can outlive its folder --
   * deleted from a file manager, or on a card that was taken out -- and one
   * that no longer resolves is released here, so save_prepare asks for a new
   * folder before pairing instead of the receive failing at Accept.
   */
  private fun heldFolder(): Uri? {
    val held = activity.contentResolver.persistedUriPermissions
      .firstOrNull { it.isWritePermission }?.uri ?: return null
    if (folderName(held) == null) {
      release(held)
      return null
    }
    return held
  }

  // The device's own storage names a tree "primary:Download/qrdrop", and the
  // path after the colon is what the done screen should say -- the same
  // "Download/qrdrop" the MediaStore route reports, rather than a bare
  // "qrdrop" that reads as a different place when it is the same folder. Any
  // other provider (an SD card's volume id, a cloud drive's opaque id) has no
  // readable path, so it gets the folder's display name.
  private fun folderName(tree: Uri): String? = try {
    val id = DocumentsContract.getTreeDocumentId(tree)
    if (tree.authority == "com.android.externalstorage.documents" && id.startsWith("primary:") &&
      id.length > "primary:".length) {
      id.removePrefix("primary:")
    } else {
      displayName(DocumentsContract.buildDocumentUriUsingTree(tree, id))
    }
  } catch (e: Exception) {
    null
  }

  private fun displayName(doc: Uri): String? = try {
    activity.contentResolver.query(
      doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null
    )?.use { if (it.moveToFirst()) it.getString(0) else null }
  } catch (e: Exception) {
    null
  }

  /**
   * The MIME type to create a document as: the one Android maps the name's
   * extension to, and the sender's claim only when Android has none.
   *
   * Not cosmetic. The external-storage provider decides what counts as the
   * extension by comparing the type it is given with the name
   * (FileUtils.splitFileName): when they disagree it treats the WHOLE name as
   * the stem. So a second report.pdf sent as application/octet-stream, which
   * the CLI and most browsers send, came back as "report.pdf (1)" -- measured
   * on an Android 10 emulator -- and a file manager no longer knows it is a
   * PDF. Taking the type from the extension makes the two agree by
   * construction, and the sender's MIME was only ever a hint.
   */
  private fun mimeFor(name: String, claimed: String?): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    val fromExt = if (ext.isEmpty()) null else MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    return fromExt ?: claimed?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
  }

  private fun mediaName(uri: Uri): String? = try {
    activity.contentResolver.query(
      uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null
    )?.use { if (it.moveToFirst()) it.getString(0) else null }
  } catch (e: Exception) {
    null
  }

  private fun release(tree: Uri) {
    try {
      activity.contentResolver.releasePersistableUriPermission(
        tree,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
    } catch (e: Exception) {
      // Already gone, which is what was wanted.
    }
  }

  private fun initialFolder(): Uri {
    val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    val qrdrop = File(downloads, "qrdrop")
    try {
      qrdrop.mkdirs()
    } catch (e: Exception) {
      // No permission on Android 10 and older; open at Download instead.
    }
    val id = if (qrdrop.isDirectory) "primary:Download/qrdrop" else "primary:Download"
    return DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE_AUTHORITY, id)
  }

  companion object {
    private const val TAG = "QrdropStorage"
    private const val DOWNLOADS_SUBFOLDER = "qrdrop"
    private const val EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents"

    /** storage.rs's NO_FOLDER, said from this side. */
    private const val NO_FOLDER =
      "The folder qrdrop saves into is no longer available. Start a new receive to choose another."
  }
}
