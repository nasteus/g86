package com.motog86.webnode;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

public class ServerService extends Service {
    private static final String TAG = "ServerService";
    public static final String ACTION_START = "com.motog86.webnode.START";
    public static final String ACTION_STOP = "com.motog86.webnode.STOP";
    public static final String BROADCAST_STATUS = "com.motog86.webnode.STATUS_UPDATE";

    public static volatile boolean isRunning = false;
    public static volatile String onionAddress = "";
    public static volatile String localAddress = "";
    public static volatile String mdnsAddress = "http://g86.local:8080";
    public static volatile String cloudflareAddress = "";

    private boolean isStarting = false;
    private PowerManager.WakeLock wakeLock;
    private Process pbProcess;
    private Process torProcess;
    private Process cloudflaredProcess;
    private NsdManager nsdManager;
    private NsdManager.RegistrationListener nsdListener;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopServer();
            stopSelf();
            return START_NOT_STICKY;
        }

        localAddress = getLocalIpAddress();
        startForeground(1, createNotification("Pornire server pe " + localAddress));
        startServer();
        return START_STICKY;
    }

    private synchronized void startServer() {
        if (isStarting || (isRunning && pbProcess != null)) {
            broadcastStatus();
            return;
        }
        isStarting = true;
        isRunning = true;
        localAddress = getLocalIpAddress();

        acquireWakeLock();
        registerMdns();

        new Thread(() -> {
            try {
                broadcastLog("[Sistem] Verificare fisiere web...");

                File g86Dir = ProcessHelper.getG86StorageDir(this);
                File extPublic = new File(g86Dir, "public");
                File intPublic = new File(getFilesDir(), "public");
                ProcessHelper.copyAssetFolder(this, "public", intPublic);
                if (!extPublic.exists() || extPublic.list() == null || extPublic.list().length == 0) {
                    ProcessHelper.copyAssetFolder(this, "public", extPublic);
                }
                File publicDir = extPublic.exists() ? extPublic : intPublic;

                File pbExec = ProcessHelper.getExecutable(this, "libpocketbase.so");
                if (pbExec == null) {
                    broadcastLog("[Eroare] Binarul PocketBase lipseste!");
                    stopServer();
                    return;
                }

                File extPbData = new File(g86Dir, "pb_data");
                if (!extPbData.exists()) extPbData.mkdirs();

                File pbData = new File(getFilesDir(), "pb_data");
                if (!pbData.exists()) pbData.mkdirs();

                // RESTAURARE AUTOMATĂ: Daca exista o baza de date valida in /sdcard/g86/pb_data, o restaureaza
                File extDb = new File(extPbData, "data.db");
                File intDb = new File(pbData, "data.db");
                if (ProcessHelper.isValidSqliteDb(extDb)) {
                    if (!ProcessHelper.isValidSqliteDb(intDb) || extDb.lastModified() > intDb.lastModified()) {
                        try {
                            File[] files = extPbData.listFiles();
                            if (files != null) {
                                for (File f : files) {
                                    if (f.isFile()) {
                                        ProcessHelper.copyFileOrFolder(f, new File(pbData, f.getName()));
                                    }
                                }
                            }
                            broadcastLog("[Stocare] Baza de date restaurata din: " + extDb.getAbsolutePath());
                        } catch (Exception ignored) {}
                    }
                }

                // 1. Start PocketBase cu filesDir (pentru viteza maxima si compatibilitate totala SQLite WAL)
                if (pbProcess == null) {
                    broadcastLog("[PocketBase] Pornire pe port 8080 (" + localAddress + ")...");
                    broadcastLog("[Stocare] Folder sincronizat: " + g86Dir.getAbsolutePath());
                    String[] pbCmd = {
                            pbExec.getAbsolutePath(),
                            "serve",
                            "--dir", pbData.getAbsolutePath(),
                            "--publicDir", publicDir.getAbsolutePath(),
                            "--http", "0.0.0.0:8080"
                    };
                    pbProcess = ProcessHelper.startProcess(pbCmd, getFilesDir(), line -> {
                        broadcastLog("[PocketBase] " + line);
                    });
                    startStorageSync();
                }

                // 2. Tor & Cloudflare (Dezactivate temporar pentru mod de dezvoltare ultra-rapid)
                boolean enableTunnels = false;
                if (enableTunnels) {
                    File torExec = ProcessHelper.getExecutable(this, "libtor.so");
                    if (torExec != null && torProcess == null) {
                        broadcastLog("[Tor] Pornire serviciu .onion...");
                        File torrc = ProcessHelper.createTorConfig(this, 8080);
                        String[] torCmd = { torExec.getAbsolutePath(), "-f", torrc.getAbsolutePath() };
                        torProcess = ProcessHelper.startProcess(torCmd, getFilesDir(), line -> broadcastLog("[Tor] " + line));
                    }

                    File cfExec = ProcessHelper.getExecutable(this, "libcloudflared.so");
                    if (cfExec != null && cloudflaredProcess == null) {
                        broadcastLog("[Cloudflare] Pornire tunel securizat HTTPS...");
                        String[] cfCmd = { cfExec.getAbsolutePath(), "tunnel", "--url", "http://127.0.0.1:8080" };
                        cloudflaredProcess = ProcessHelper.startProcess(cfCmd, getFilesDir(), line -> {
                            broadcastLog("[Cloudflare] " + line);
                            if (line.contains("trycloudflare.com")) {
                                int httpsIdx = line.indexOf("https://");
                                if (httpsIdx != -1) {
                                    int endIdx = line.indexOf(".trycloudflare.com", httpsIdx) + ".trycloudflare.com".length();
                                    if (endIdx > httpsIdx) {
                                        cloudflareAddress = line.substring(httpsIdx, endIdx).trim();
                                        broadcastStatus();
                                    }
                                }
                            }
                        });
                    }
                }

                broadcastStatus();
                monitorOnionHostname();

            } catch (Exception e) {
                Log.e(TAG, "Eroare la pornire", e);
                broadcastLog("[Eroare Pornire] " + e.getMessage());
                stopServer();
            } finally {
                isStarting = false;
            }
        }).start();
    }

    private void registerMdns() {
        try {
            NsdServiceInfo serviceInfo = new NsdServiceInfo();
            serviceInfo.setServiceName("g86");
            serviceInfo.setServiceType("_http._tcp.");
            serviceInfo.setPort(8080);

            nsdManager = (NsdManager) getSystemService(Context.NSD_SERVICE);
            nsdListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo serviceInfo) {
                    Log.d(TAG, "mDNS Service registered: " + serviceInfo.getServiceName());
                    broadcastLog("[mDNS] Activ: http://g86.local:8080");
                }

                @Override
                public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    Log.e(TAG, "mDNS registration failed: " + errorCode);
                }

                @Override
                public void onServiceUnregistered(NsdServiceInfo arg0) {}

                @Override
                public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {}
            };

            if (nsdManager != null) {
                nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, nsdListener);
            }
        } catch (Exception e) {
            Log.e(TAG, "mDNS error", e);
        }
    }

    private void unregisterMdns() {
        if (nsdManager != null && nsdListener != null) {
            try {
                nsdManager.unregisterService(nsdListener);
            } catch (Exception ignored) {}
            nsdListener = null;
        }
    }

    private void monitorOnionHostname() {
        File g86HsFile = new File(ProcessHelper.getG86StorageDir(this), "tor_data/hs/hostname");
        File fallbackHsFile = new File(getFilesDir(), "tor_data/hs/hostname");
        new Thread(() -> {
            int attempts = 0;
            while (isRunning && attempts < 90) {
                File hsFile = g86HsFile.exists() ? g86HsFile : fallbackHsFile;
                if (hsFile.exists()) {
                    try (BufferedReader reader = new BufferedReader(new FileReader(hsFile))) {
                        String line = reader.readLine();
                        if (line != null && !line.trim().isEmpty()) {
                            onionAddress = line.trim();
                            broadcastLog("[Tor Succes] Adresa .onion activa: " + onionAddress);
                            broadcastStatus();
                            updateNotification("Tor: " + onionAddress);
                            break;
                        }
                    } catch (Exception ignored) {}
                }
                attempts++;
                try {
                    Thread.sleep(1500);
                } catch (InterruptedException ignored) {}
            }
        }).start();
    }

    private void startStorageSync() {
        new Thread(() -> {
            while (isRunning) {
                syncDatabaseToExternal();
                try {
                    Thread.sleep(10000);
                } catch (InterruptedException ignored) {}
            }
        }).start();
    }

    private void syncDatabaseToExternal() {
        try {
            File intPbData = new File(getFilesDir(), "pb_data");
            File intDb = new File(intPbData, "data.db");
            if (ProcessHelper.isValidSqliteDb(intDb)) {
                File extPb = new File(ProcessHelper.getG86StorageDir(this), "pb_data");
                if (!extPb.exists()) extPb.mkdirs();
                File[] files = intPbData.listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (f.isFile()) {
                            ProcessHelper.copyFileOrFolder(f, new File(extPb, f.getName()));
                        }
                    }
                }
            }

            File intHs = new File(getFilesDir(), "tor_data/hs");
            if (intHs.exists()) {
                File extHs = new File(ProcessHelper.getG86StorageDir(this), "tor_data/hs");
                if (!extHs.exists()) extHs.mkdirs();
                ProcessHelper.copyFileOrFolder(intHs, extHs);
            }
        } catch (Exception ignored) {}
    }

    private synchronized void stopServer() {
        syncDatabaseToExternal();
        isStarting = false;
        isRunning = false;
        unregisterMdns();
        if (pbProcess != null) {
            pbProcess.destroy();
            pbProcess = null;
        }
        if (torProcess != null) {
            torProcess.destroy();
            torProcess = null;
        }
        if (cloudflaredProcess != null) {
            cloudflaredProcess.destroy();
            cloudflaredProcess = null;
        }
        releaseWakeLock();
        onionAddress = "";
        cloudflareAddress = "";
        broadcastStatus();
        broadcastLog("[Sistem] Toate serviciile server au fost oprite.");
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MotoG86:ServerWakeLock");
                wakeLock.acquire();
            }
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
    }

    public static String getLocalIpAddress() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface intf : interfaces) {
                if (intf.getName().startsWith("wlan") || intf.getName().startsWith("eth") || intf.getName().startsWith("rndis")) {
                    for (InetAddress addr : Collections.list(intf.getInetAddresses())) {
                        if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                            return "http://" + addr.getHostAddress() + ":8080";
                        }
                    }
                }
            }
            for (NetworkInterface intf : interfaces) {
                for (InetAddress addr : Collections.list(intf.getInetAddresses())) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        return "http://" + addr.getHostAddress() + ":8080";
                    }
                }
            }
        } catch (Exception ignored) {}
        return "http://127.0.0.1:8080";
    }

    private void broadcastLog(String log) {
        Log.d(TAG, log);
        Intent intent = new Intent(BROADCAST_STATUS);
        intent.putExtra("type", "LOG");
        intent.putExtra("message", log);
        sendBroadcast(intent);
    }

    public void broadcastStatus() {
        Intent intent = new Intent(BROADCAST_STATUS);
        intent.putExtra("type", "STATUS");
        intent.putExtra("isRunning", isRunning);
        intent.putExtra("onionAddress", onionAddress);
        intent.putExtra("localAddress", localAddress);
        intent.putExtra("mdnsAddress", mdnsAddress);
        intent.putExtra("cloudflareAddress", cloudflareAddress);
        sendBroadcast(intent);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    "webnode_channel",
                    "Moto G86 Node Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    private Notification createNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, "webnode_channel")
                .setContentTitle("Moto G86 Web Node")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_node)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(1, createNotification(text));
        }
    }

    @Override
    public void onDestroy() {
        stopServer();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}