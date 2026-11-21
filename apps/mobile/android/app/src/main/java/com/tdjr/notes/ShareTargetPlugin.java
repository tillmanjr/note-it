package com.tdjr.notes;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Share to Notes" (docs/mobile.md): text and links shared from other apps arrive as a "shared" event, kept until
 * the web side listens, which turns each into a new note.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {
    @Override
    public void load() {
        take(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        take(intent);
    }

    private void take(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (type == null || !type.startsWith("text/") || text == null || text.trim().isEmpty()) return;
        JSObject share = new JSObject();
        share.put("text", text);
        share.put("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT));
        // Handle each share once, even if the activity is recreated with the same intent.
        intent.setAction(Intent.ACTION_MAIN);
        notifyListeners("shared", share, true);
    }
}
