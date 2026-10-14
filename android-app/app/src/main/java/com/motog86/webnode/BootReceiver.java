package com.motog86.webnode;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(intent.getAction())) {

            Intent serviceIntent = new Intent(context, ServerService.class);
            serviceIntent.setAction(ServerService.ACTION_START);
            ContextCompat.startForegroundService(context, serviceIntent);
        }
    }
}
