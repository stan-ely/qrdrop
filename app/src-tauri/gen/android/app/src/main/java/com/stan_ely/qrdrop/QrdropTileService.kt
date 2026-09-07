package com.stan_ely.qrdrop

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

/**
 * The Quick Settings tile: "qrdrop" one pull-down away, opening on the
 * scanner.
 *
 * ADDED, NOT EDITED. Tauri does not generate this file, so a re-init has
 * nothing here to overwrite -- unlike MainActivity.kt and AndroidManifest.xml,
 * which it does. It is still in CLAUDE.md's list, because the manifest entry
 * that registers it is a hand edit, and a re-init dropping that would leave
 * this class in the tree doing nothing with no error to read.
 *
 * WHY A TILE. Receiving is the half of this app that starts with a device
 * already in your hand and a code already on someone's screen, and every tap
 * before the camera opens is spent while the other person waits. From the
 * shade it is one pull and one tap, from inside whatever app you were in.
 *
 * It hands off exactly as the launcher shortcuts do -- the same extra, read by
 * the same MainActivity.stashLaunchAction, through the same cache-file handoff
 * to src/share.rs and app/src/main.js. Two entry points, one mechanism. A tile
 * that reached the web layer its own way would be a second thing to keep in
 * step with a chain that already has four links.
 *
 * TileService requires API 24, which is this app's minSdk exactly
 * (build.gradle.kts), so there is no version guard around the class itself --
 * only around how it starts the activity.
 */
class QrdropTileService : TileService() {
    override fun onClick() {
        super.onClick()

        val intent = Intent(this, MainActivity::class.java).apply {
            // The activity is launchMode="singleTask", so a tile tapped while
            // qrdrop is already running reuses the instance and arrives at
            // onNewIntent rather than onCreate. Both stash the extra, for the
            // reason MainActivity's own comment gives.
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra(MainActivity.EXTRA_LAUNCH_ACTION, "receive")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // FLAG_IMMUTABLE because nothing may rewrite this intent's extras,
            // and UPDATE_CURRENT so a second tap reuses the pending intent
            // rather than accumulating one per press.
            val pending = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pending)
        } else {
            // The Intent overload is deprecated on 34+ and THROWS there, which
            // is why the branch above exists at all -- it is not a politeness
            // about a warning. Below 34 it is the only overload that exists.
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
