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

                // Asigurare limita 100MB pentru atasamente mari (video/fisiere) in schema PocketBase
                ensureMessagesCollection(intDb);
                ensureMessagesCollection(extDb);

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
                    startWifiLandmarkScanner(publicDir);
                }

                // 2. Tor & Cloudflare (Active cu servicii .onion si tunel HTTPS)
                boolean enableTunnels = true;
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
        intent.setPackage(getPackageName());
        intent.putExtra("type", "LOG");
        intent.putExtra("message", log);
        sendBroadcast(intent);
    }

    public void broadcastStatus() {
        Intent intent = new Intent(BROADCAST_STATUS);
        intent.setPackage(getPackageName());
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
                .setContentTitle("g86")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_node)
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

    private void ensureMessagesCollection(File dbFile) {
        if (dbFile == null || !dbFile.exists() || !ProcessHelper.isValidSqliteDb(dbFile)) return;
        try (android.database.sqlite.SQLiteDatabase db = android.database.sqlite.SQLiteDatabase.openDatabase(
                dbFile.getAbsolutePath(), null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE)) {

            android.database.Cursor cursor = db.rawQuery("SELECT fields FROM _collections WHERE name='messages'", null);
            boolean exists = (cursor != null && cursor.moveToFirst());

            if (!exists) {
                if (cursor != null) cursor.close();
                String fieldsJson = "[{\"autogeneratePattern\":\"[a-z0-9]{15}\",\"help\":\"\",\"hidden\":false,\"id\":\"text3208210256\",\"max\":15,\"min\":15,\"name\":\"id\",\"pattern\":\"^[a-z0-9]+$\",\"presentable\":false,\"primaryKey\":true,\"required\":true,\"system\":true,\"type\":\"text\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_sender\",\"max\":0,\"min\":0,\"name\":\"sender\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_text\",\"max\":0,\"min\":0,\"name\":\"text\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_msgId\",\"max\":0,\"min\":0,\"name\":\"msgId\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_scope\",\"max\":0,\"min\":0,\"name\":\"scope\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_recipient\",\"max\":0,\"min\":0,\"name\":\"recipient\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"help\":\"\",\"hidden\":false,\"id\":\"json_file\",\"maxSize\":104857600,\"name\":\"file\",\"presentable\":false,\"required\":false,\"system\":false,\"type\":\"json\"}," +
                        "{\"help\":\"\",\"hidden\":false,\"id\":\"num_timestamp\",\"max\":null,\"min\":null,\"name\":\"timestamp\",\"noDecimal\":false,\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"number\"}," +
                        "{\"help\":\"\",\"hidden\":false,\"id\":\"bool_edited\",\"name\":\"edited\",\"presentable\":false,\"required\":false,\"system\":false,\"type\":\"bool\"}," +
                        "{\"help\":\"\",\"hidden\":false,\"id\":\"num_chunkIndex\",\"max\":null,\"min\":null,\"name\":\"chunkIndex\",\"noDecimal\":false,\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"number\"}," +
                        "{\"help\":\"\",\"hidden\":false,\"id\":\"num_totalChunks\",\"max\":null,\"min\":null,\"name\":\"totalChunks\",\"noDecimal\":false,\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"number\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_fileId\",\"max\":0,\"min\":0,\"name\":\"fileId\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_fileName\",\"max\":0,\"min\":0,\"name\":\"fileName\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"help\":\"\",\"hidden\":false,\"id\":\"num_fileSize\",\"max\":null,\"min\":null,\"name\":\"fileSize\",\"noDecimal\":false,\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"number\"}," +
                        "{\"autogeneratePattern\":\"\",\"help\":\"\",\"hidden\":false,\"id\":\"text_fileType\",\"max\":0,\"min\":0,\"name\":\"fileType\",\"pattern\":\"\",\"presentable\":false,\"primaryKey\":false,\"required\":false,\"system\":false,\"type\":\"text\"}," +
                        "{\"hidden\":false,\"id\":\"autodate2990389176\",\"name\":\"created\",\"onCreate\":true,\"onUpdate\":false,\"presentable\":false,\"system\":false,\"type\":\"autodate\"}," +
                        "{\"hidden\":false,\"id\":\"autodate3332085495\",\"name\":\"updated\",\"onCreate\":true,\"onUpdate\":true,\"presentable\":false,\"system\":false,\"type\":\"autodate\"}]";

                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put("id", "messages_coll001");
                cv.put("system", 0);
                cv.put("type", "base");
                cv.put("name", "messages");
                cv.put("fields", fieldsJson);
                cv.put("indexes", "[]");
                cv.put("listRule", "");
                cv.put("viewRule", "");
                cv.put("createRule", "");
                cv.put("updateRule", "");
                cv.put("deleteRule", "");
                cv.put("options", "{}");
                db.insert("_collections", null, cv);

                db.execSQL("CREATE TABLE IF NOT EXISTS `messages` (" +
                        "`id` TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL," +
                        "`sender` TEXT DEFAULT '' NOT NULL," +
                        "`text` TEXT DEFAULT '' NOT NULL," +
                        "`msgId` TEXT DEFAULT '' NOT NULL," +
                        "`scope` TEXT DEFAULT '' NOT NULL," +
                        "`recipient` TEXT DEFAULT '' NOT NULL," +
                        "`file` JSON DEFAULT '{}' NOT NULL," +
                        "`timestamp` REAL DEFAULT 0 NOT NULL," +
                        "`edited` BOOLEAN DEFAULT 0 NOT NULL," +
                        "`chunkIndex` REAL DEFAULT 0 NOT NULL," +
                        "`totalChunks` REAL DEFAULT 0 NOT NULL," +
                        "`fileId` TEXT DEFAULT '' NOT NULL," +
                        "`fileName` TEXT DEFAULT '' NOT NULL," +
                        "`fileSize` REAL DEFAULT 0 NOT NULL," +
                        "`fileType` TEXT DEFAULT '' NOT NULL," +
                        "`created` TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL," +
                        "`updated` TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL" +
                        ")");
                broadcastLog("[Schema] Colectia messages creata cu succes!");
            } else {
                String fieldsJson = cursor.getString(0);
                cursor.close();
                org.json.JSONArray arr = new org.json.JSONArray(fieldsJson);
                boolean changed = false;
                for (int i = 0; i < arr.length(); i++) {
                    org.json.JSONObject field = arr.getJSONObject(i);
                    if ("file".equals(field.optString("name"))) {
                        long currentSize = field.optLong("maxSize", 0);
                        if (currentSize < 104857600L) {
                            field.put("maxSize", 104857600L);
                            changed = true;
                        }
                    }
                }
                android.content.ContentValues cv = new android.content.ContentValues();
                if (changed) {
                    cv.put("fields", arr.toString());
                }
                cv.put("listRule", "");
                cv.put("viewRule", "");
                cv.put("createRule", "");
                cv.put("updateRule", "");
                cv.put("deleteRule", "");
                db.update("_collections", cv, "name=?", new String[]{"messages"});
            }
        } catch (Exception e) {
            broadcastLog("[Schema] Info verificare schema: " + e.getMessage());
        }
    }

    private void startWifiLandmarkScanner(File publicDir) {
        new Thread(() -> {
            File extPublic = new File(ProcessHelper.getG86StorageDir(this), "public");
            java.util.Map<String, org.json.JSONObject> knownDevices = new java.util.concurrent.ConcurrentHashMap<>();

            // Seed known active network devices
            try {
                org.json.JSONObject s25 = new org.json.JSONObject();
                s25.put("ip", "192.168.100.192");
                s25.put("mac", "aa:21:c2:6a:f4:be");
                s25.put("name", "Samsung Galaxy S25 Ultra");
                s25.put("type", "mobile");
                s25.put("x", 2.8);
                s25.put("y", 0.6);
                s25.put("z", -2.2);
                s25.put("signal", -48);
                knownDevices.put("192.168.100.192", s25);

                org.json.JSONObject pc = new org.json.JSONObject();
                pc.put("ip", "192.168.100.42");
                pc.put("mac", "74:d4:35:ad:52:0f");
                pc.put("name", "Stație PC / Control Wi-Fi");
                pc.put("type", "station");
                pc.put("x", -3.5);
                pc.put("y", 0.8);
                pc.put("z", -4.0);
                pc.put("signal", -52);
                knownDevices.put("192.168.100.42", pc);
            } catch (Exception ignored) {}

            int cycle = 0;
            while (isRunning) {
                try {
                    cycle++;
                    org.json.JSONObject root = new org.json.JSONObject();
                    root.put("timestamp", System.currentTimeMillis());

                    String myIp = (localAddress != null && !localAddress.isEmpty()) ? localAddress.replace("http://", "").split(":")[0] : "192.168.100.196";
                    String subnetPrefix = myIp.contains(".") ? myIp.substring(0, myIp.lastIndexOf('.') + 1) : "192.168.100.";
                    String gatewayIp = subnetPrefix + "1";

                    org.json.JSONObject gatewayObj = new org.json.JSONObject();
                    gatewayObj.put("ip", gatewayIp);
                    gatewayObj.put("name", "Wi-Fi Router (AP Gateway)");
                    gatewayObj.put("type", "router");
                    gatewayObj.put("x", 0.0);
                    gatewayObj.put("y", 1.8);
                    gatewayObj.put("z", -7.5);
                    gatewayObj.put("signal", -42);
                    root.put("gateway", gatewayObj);

                    org.json.JSONArray devList = new org.json.JSONArray();

                    // Moto G86 Node Master
                    org.json.JSONObject hostObj = new org.json.JSONObject();
                    hostObj.put("ip", myIp);
                    hostObj.put("name", "Moto G86 (Node Master)");
                    hostObj.put("type", "master");
                    hostObj.put("x", 0.0);
                    hostObj.put("y", 0.0);
                    hostObj.put("z", 0.0);
                    hostObj.put("signal", -30);
                    devList.put(hostObj);

                    // 1. Ingest telemetry from PocketBase database & active clients
                    try {
                        java.util.List<ProcessHelper.ActiveClient> clients = ProcessHelper.getActiveClients(this);
                        for (ProcessHelper.ActiveClient ac : clients) {
                            if (ac.ip != null && !ac.ip.equals(myIp) && !ac.ip.equals(gatewayIp)) {
                                org.json.JSONObject dev = new org.json.JSONObject();
                                dev.put("ip", ac.ip);
                                boolean isS25 = ac.ip.endsWith(".192");
                                String name = isS25 ? "Samsung Galaxy S25 Ultra" : (ac.email != null ? ac.email : ("Dispozitiv Wi-Fi (" + ac.ip + ")"));
                                dev.put("name", name);
                                dev.put("type", isS25 ? "mobile" : "station");
                                dev.put("x", isS25 ? 2.5 : -3.0);
                                dev.put("y", 0.6);
                                dev.put("z", isS25 ? -2.0 : -3.5);
                                dev.put("signal", isS25 ? -48 : -55);
                                knownDevices.put(ac.ip, dev);
                            }
                        }

                        File pbDbFile = new File(getFilesDir(), "pb_data/data.db");
                        if (!pbDbFile.exists()) {
                            pbDbFile = new File(ProcessHelper.getG86StorageDir(this), "pb_data/data.db");
                        }
                        if (pbDbFile.exists()) {
                            android.database.sqlite.SQLiteDatabase db = android.database.sqlite.SQLiteDatabase.openDatabase(
                                pbDbFile.getAbsolutePath(), null, android.database.sqlite.SQLiteDatabase.OPEN_READONLY);
                            try (android.database.Cursor c = db.rawQuery(
                                "SELECT file FROM messages WHERE scope='radar_telemetry' ORDER BY created DESC LIMIT 20", null)) {
                                while (c.moveToNext()) {
                                    String fileContent = c.getString(0);
                                    if (fileContent != null && fileContent.startsWith("{")) {
                                        org.json.JSONObject t = new org.json.JSONObject(fileContent);
                                        String peerId = t.optString("peerId");
                                        String dName = t.optString("device", "Dispozitiv Mobil");
                                        String uName = t.optString("userName", "");
                                        double x = t.optDouble("x", 0.0);
                                        double y = t.optDouble("y", 0.6);
                                        double z = t.optDouble("z", 0.0);
                                        int rtt = t.optInt("rtt", 15);

                                        String devKey = !peerId.isEmpty() ? peerId : dName;
                                        org.json.JSONObject dev = new org.json.JSONObject();
                                        dev.put("ip", devKey);
                                        dev.put("name", dName + (uName.isEmpty() ? "" : (" (" + uName + ")")));
                                        dev.put("type", "mobile");
                                        dev.put("x", x);
                                        dev.put("y", y);
                                        dev.put("z", z);
                                        dev.put("signal", -35 - Math.min(45, rtt));
                                        knownDevices.put(devKey, dev);
                                    }
                                }
                            }
                            db.close();
                        }
                    } catch (Exception ignored) {}

                    // 2. Active subnet reachability probe (every 5 cycles)
                    if (cycle % 5 == 0) {
                        int[] testHosts = {42, 192, 100, 101, 102, 105, 120, 150, 200};
                        for (int h : testHosts) {
                            final String testIp = subnetPrefix + h;
                            if (!testIp.equals(myIp) && !testIp.equals(gatewayIp)) {
                                new Thread(() -> {
                                    try {
                                        java.net.Socket s = new java.net.Socket();
                                        s.connect(new java.net.InetSocketAddress(testIp, 8080), 40);
                                        s.close();
                                    } catch (Exception e) {
                                        if (e.getMessage() != null && e.getMessage().contains("Connection refused")) {
                                            try {
                                                if (!knownDevices.containsKey(testIp)) {
                                                    org.json.JSONObject discovered = new org.json.JSONObject();
                                                    discovered.put("ip", testIp);
                                                    discovered.put("name", "Dispozitiv Wi-Fi (" + testIp + ")");
                                                    discovered.put("type", "station");
                                                    double angle = (h * 47.0) % 360;
                                                    double rad = Math.toRadians(angle);
                                                    double dist = 3.5 + ((h % 4) * 1.0);
                                                    discovered.put("x", Math.round(dist * Math.sin(rad) * 10.0) / 10.0);
                                                    discovered.put("y", 0.6);
                                                    discovered.put("z", Math.round(dist * Math.cos(rad) * 10.0) / 10.0);
                                                    discovered.put("signal", -50 - (h % 20));
                                                    knownDevices.put(testIp, discovered);
                                                }
                                            } catch (Exception ignored2) {}
                                        }
                                    }
                                }).start();
                            }
                        }
                    }

                    // Populate devices list
                    for (org.json.JSONObject d : knownDevices.values()) {
                        devList.put(d);
                    }

                    root.put("devices", devList);
                    String jsonStr = root.toString(2);

                    if (publicDir != null && publicDir.exists()) {
                        File out1 = new File(publicDir, "wifi_landmarks.json");
                        try (java.io.FileWriter fw = new java.io.FileWriter(out1)) { fw.write(jsonStr); }
                    }
                    if (extPublic.exists()) {
                        File out2 = new File(extPublic, "wifi_landmarks.json");
                        try (java.io.FileWriter fw = new java.io.FileWriter(out2)) { fw.write(jsonStr); }
                    }

                    Thread.sleep(2500);
                } catch (Exception ignored) {}
            }
        }).start();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}